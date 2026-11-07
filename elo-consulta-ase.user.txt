// ==UserScript==
// @name         ELO | Consulta rápida do histórico ASE
// @namespace    https://cad-elo.tse.jus.br/
// @version      1.5.45
// @description  Consulta uma inscrição, abre o primeiro resultado e o histórico ASE, com painel flutuante e retorno à consulta inicial.
// @match        https://cad-elo.tse.jus.br/sae/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /*
   * GUIA DE MANUTENÇÃO
   * - ELEICOES: conjuntos disponíveis; ELEICAO: valor inicial, alterável pelo painel.
   * - aplicarSelecaoEleitoral: valida o contexto usado na conferência e na sessão.
   * - CONFIG: códigos ASE e duração dos avisos e das etapas.
   * - TIMEOUT_MESSAGES: mensagens de prazo excedido por etapa da consulta.
   * - montarRelatorioTurnos/relatarAusencias: redação dos resultados exibidos.
   * - lerAsesPorTurno/conferirHistorico: leitura, pendências, cores e limpeza do título.
   * - obterHtmlPainel/ESTILOS_PAINEL/CSS_ESTADOS_PAINEL: estrutura, estilos e estados (foco, mouse).
   * - TONS_STATUS/aplicarTomStatus/copiarStatus: cor persistente do resultado e botão Copiar.
   * - posicionarPainel: posição e altura dentro da janela.
   * - registrarEventosPainel/habilitarArrastePainel: controles, atalhos, arraste e redimensionamento.
   * - definirPainelRecolhido/exibirBotaoRestaurarPainel: minimização e restauração.
   * - exibirPopover: apresentação dos avisos.
   * - escolherProximaAcao/executarCiclo: sequência de navegação no ELO.
   *
   * Preserve KEY e o formato salvo na sessão para manter a continuidade das consultas.
   * As etapas (query/results/detail/history/done), seletores e APIs externas mantêm
   * os nomes originais por compatibilidade. As funções próprias usam português.
   * O nome do eleitor aparece na tela, mas não deve ser salvo na sessão.
   * Mantenha o arquivo único: ele é instalado diretamente como userscript.
   */

  // 1. Configuração, contratos da sessão e estado do controlador
  // Um controlador por janela. Os quadros são acompanhados pelo controlador superior.
  try { if (window.top !== window.self && window.top.location.origin === location.origin) return; }
  catch { return; }

  const KEY = 'elo.consultaASE.v1';
  // A posição do painel também fica fora da sessão, para valer em novas abas e dias.
  const KEY_POSICAO = 'elo.consultaASE.painel.posicao';
  const PANEL = 'elo-consulta-ase-painel';
  const LIMIT = 120000;
  // Cadastre aqui os conjuntos de turnos. A conferência usa somente o conjunto escolhido.
  const ELEICOES = {
    2020: [
      {label:'1º turno', date:'15/11/2020'},
      {label:'2º turno', date:'29/11/2020'}
    ],
    2022: [
      {label:'1º turno', date:'02/10/2022'},
      {label:'2º turno', date:'30/10/2022'}
    ],
    2024: [
      {label:'1º turno', date:'06/10/2024'},
      {label:'2º turno', date:'27/10/2024'}
    ],
    2026: [
      {label:'1º turno', date:'04/10/2026'},
      {label:'2º turno', date:'25/10/2026'}
    ]
  };
  // Valor inicial para uma sessão nova. Eleição e turnos podem ser escolhidos no painel.
  const ELEICAO = 2026;
  let eleicaoSelecionada = ELEICAO;
  let indicesTurnosSelecionados = Object.freeze(ELEICOES[ELEICAO].map((_, index) => index));
  let turnosSelecionados = Object.freeze(ELEICOES[ELEICAO].map(turn => Object.freeze({...turn})));
  // Guarda as escolhas de cada ano durante a sessão, sem misturar os contextos de consulta.
  const turnosPorEleicao = Object.assign(Object.create(null), {[ELEICAO]:indicesTurnosSelecionados});
  let escolhaEleitoralRecolhida = true;

  const CONFIG = Object.freeze({
    aseCode: '167',
    absenceAseCode: '094',
    absenceGuidanceStatuses: Object.freeze(['ATIVO', 'FACULTADO']),
    get turns() { return turnosSelecionados; },
    popoverDurationMs: 10000, // duração de todos os avisos, incluindo erros
    stepTimeoutMs: 45000,  // espera máxima em cada etapa (consulta, resultado, detalhe, histórico)
    historyRetryMs: 4000,  // tempo para a tabela do histórico aparecer antes de acusar falha
    noResultDelayMs: 1500, // o aviso de "sem resultado" precisa persistir por esse tempo
    // Padrão conservador. Ajuste se a mensagem real do ELO tiver outra redação.
    noResultPattern: /^(?:nenhum (?:registro|eleitor|resultado)(?: foi)? (?:encontrado|localizado)|n[ãa]o (?:foi encontrado|foi localizado) nenhum (?:registro|eleitor|resultado))[.!]?$/i
  });
  const TIMEOUT_MESSAGES = Object.freeze({
    query: 'O formulário de consulta do ELO não ficou disponível. Volte à consulta inicial e tente novamente.',
    results: 'O ELO não abriu o resultado da consulta a tempo. Confira o título e tente novamente.',
    detail: 'Os dados do eleitor não carregaram, ou o link do ASE não foi reconhecido. Confira a tela do ELO.',
    history: 'O histórico ASE não carregou a tempo. Confira a tela do ELO.'
  });

  // Estado temporário: WeakMap evita reter documentos que o ELO já substituiu.
  let checkedHistories = new WeakMap();
  let historyWaits = new WeakMap();
  let state = null;
  let home = null;
  let panel = null;
  let botaoRestaurarPainel = null;
  let statusText = 'Informe o título e clique em Consultar ASE.';
  let statusTone = 'neutral';
  let falhaSalva = null;
  let removerOuvinteResize = null;
  let temporizadorCopia = null;
  let running = false;
  let timer = null;
  let pendingTick = null;
  let pendingTickDue = 0;
  let focusAfterLoad = null;
  let suspended = false;
  const monitors = new Map();
  let savedPosition = null;
  let popover = null;
  let popoverTimer = null;
  let noResultSince = 0;

  // 2. Título de eleitor: normalização, máscara e validação

  /** Remove separadores aceitos e devolve os 12 dígitos, ou null se o formato for inválido. */
  function normalizarTitulo(value) {
    const raw = String(value ?? '').trim();
    if (!/^[\d\s.\-]+$/.test(raw)) return null;
    const digits = raw.replace(/\D/g, '');
    return /^\d{12}$/.test(digits) ? digits : null;
  }

  /** Agrupa os dígitos em blocos de quatro para exibição, sem truncar entradas excedentes. */
  function formatarTitulo(value) {
    // Preserva dígitos excedentes para que a validação recuse o número inteiro.
    return String(value ?? '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  /** Valida a UF e os dois dígitos verificadores antes de permitir uma consulta. */
  function tituloValido(value) {
    const title = normalizarTitulo(value);
    if (!title || /^(\d)\1{11}$/.test(title)) return false;
    const uf = Number(title.slice(8, 10));
    if (uf < 1 || uf > 28) return false;
    const digits = Array.from(title, Number);
    // Módulo 11: pesos 2 a 9 no sequencial e 7, 8, 9 no código de UF + DV.
    // SP e MG usam 1 quando o resto original é zero; resto 10 resulta em zero.
    const calcularDigitoVerificador = sum => {
      const remainder = sum % 11;
      return remainder === 10 ? 0 : remainder === 0 && uf <= 2 ? 1 : remainder;
    };
    const first = calcularDigitoVerificador(digits.slice(0, 8).reduce((sum, digit, index) => sum + digit * (index + 2), 0));
    const second = calcularDigitoVerificador(digits[8] * 7 + digits[9] * 8 + first * 9);
    return digits[10] === first && digits[11] === second;
  }

  /** Aplica a máscara durante a digitação e preserva a posição de edição do usuário. */
  function formatarCampoTitulo(event) {
    const input = event.currentTarget;
    const position = input.selectionStart ?? input.value.length;
    const digitsBefore = input.value.slice(0, position).replace(/\D/g, '').length;
    const formatted = formatarTitulo(input.value);
    let caret = 0;
    let digits = 0;
    while (caret < formatted.length && digits < digitsBefore) {
      if (/\d/.test(formatted[caret])) digits++;
      caret++;
    }
    if (event.inputType === 'deleteContentForward' && formatted[caret] === ' ') caret++;
    input.value = formatted;
    input.setSelectionRange(caret, caret);
    atualizarBotoes();
  }

  // 3. Sessão e endereço de retorno

  /** Aceita somente etapas conhecidas e sessões ainda válidas dentro de LIMIT. */
  function estadoValido(value) {
    return Boolean(value && ['query', 'results', 'detail', 'history', 'done'].includes(value.phase)
      && /^\d{12}$/.test(value.title) && Number.isFinite(value.updated)
      && Date.now() - value.updated >= 0 && Date.now() - value.updated < LIMIT);
  }

  /** Aceita retorno apenas para /sae/ na mesma origem; devolve a URL validada ou null. */
  function validarEnderecoInicial(value) {
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && url.pathname.startsWith('/sae/') ? url.href : null;
    } catch { return null; }
  }

  /** Normaliza uma preferência sem alterar a eleição atual; rejeita seleção vazia ou inválida. */
  function validarIndicesTurnos(ano, indices) {
    const turnos = ELEICOES[ano];
    if (!Array.isArray(turnos) || !Array.isArray(indices) || !indices.length) return null;
    const escolhidos = [...new Set(indices)].sort((a, b) => a - b);
    if (escolhidos.some(index => !Number.isInteger(index) || index < 0 || index >= turnos.length)) return null;
    return Object.freeze(escolhidos);
  }

  /** Aplica uma seleção válida e memoriza os turnos escolhidos para aquele ano. */
  function aplicarSelecaoEleitoral(ano, indices) {
    const escolhidos = validarIndicesTurnos(ano, indices);
    if (!escolhidos) return false;
    eleicaoSelecionada = Number(ano);
    indicesTurnosSelecionados = escolhidos;
    turnosSelecionados = Object.freeze(escolhidos.map(index => Object.freeze({...ELEICOES[ano][index]})));
    turnosPorEleicao[eleicaoSelecionada] = escolhidos;
    return true;
  }

  /** Identifica a seleção e as regras usadas no resultado, para validar cache e sessão. */
  function chaveContextoEleitoral() {
    return JSON.stringify({
      election:eleicaoSelecionada,
      selectedTurns:indicesTurnosSelecionados,
      turns:CONFIG.turns,
      ase:CONFIG.aseCode,
      absenceAse:CONFIG.absenceAseCode,
      guidanceStatuses:CONFIG.absenceGuidanceStatuses
    });
  }

  /** Persiste a seleção junto da consulta, sem gravar o nome do eleitor. */
  function salvarSessao() {
    // Salva a próxima etapa ANTES de um clique que possa trocar de página.
    window.sessionStorage.setItem(KEY, JSON.stringify({state, home, position:savedPosition,
      failure:state ? null : falhaSalva,
      election:eleicaoSelecionada, selectedTurns:indicesTurnosSelecionados,
      turnsByElection:turnosPorEleicao,
      selectionCollapsed:escolhaEleitoralRecolhida, queryContext:chaveContextoEleitoral()}));
  }

  /** Lê a última posição do painel guardada fora da sessão; devolve null se ausente ou inválida. */
  function lerPosicaoPersistida() {
    try {
      const posicao = JSON.parse(window.localStorage.getItem(KEY_POSICAO) || 'null');
      return Number.isFinite(posicao?.x) && Number.isFinite(posicao?.y) ? {x:posicao.x, y:posicao.y} : null;
    } catch { return null; }
  }

  /** Guarda a posição do painel para as próximas abas; falhas de armazenamento são ignoradas. */
  function gravarPosicaoPersistida() {
    try {
      if (savedPosition) window.localStorage.setItem(KEY_POSICAO, JSON.stringify(savedPosition));
    } catch { /* A posição continua valendo nesta sessão. */ }
  }

  /** Recupera a sessão e descarta consultas expiradas ou dados que não puderem ser lidos. */
  function restaurarSessao() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(KEY) || 'null');
      if (!saved) return;
      home = validarEnderecoInicial(saved.home);
      savedPosition = saved.position;
      if (typeof saved.selectionCollapsed === 'boolean') escolhaEleitoralRecolhida = saved.selectionCollapsed;
      // Recupera só anos cadastrados e preferências válidas, sem mudar o contexto atual.
      for (const ano of Object.keys(ELEICOES)) {
        const indices = validarIndicesTurnos(ano, saved.turnsByElection?.[ano]);
        if (indices) turnosPorEleicao[ano] = indices;
      }
      // Sessões antigas não tinham subconjunto de turnos e usavam todos os turnos do ano.
      const anoSalvo = saved.election ?? 2026;
      const indicesSalvos = saved.selectedTurns ?? turnosPorEleicao[anoSalvo] ?? ELEICOES[anoSalvo]?.map((_, index) => index);
      if (!aplicarSelecaoEleitoral(anoSalvo, indicesSalvos)) {
        state = null;
        statusText = 'A seleção anterior não está disponível. Escolha a eleição e os turnos para consultar.';
        return;
      }
      // Prefere uma nova consulta a apresentar um resultado baseado em datas ou regras antigas.
      // Sessões sem assinatura também são migradas, mantendo as preferências do painel.
      if ((saved.state || saved.failure) && saved.queryContext !== chaveContextoEleitoral()) {
        state = null;
        statusText = 'Configuração da conferência atualizada. Inicie uma nova consulta.';
        return;
      }
      if (estadoValido(saved.state)) state = saved.state;
      else if (saved.state) statusText = 'Consulta anterior expirada. Inicie uma nova consulta.';
      else if (typeof saved.failure?.message === 'string' && Number.isFinite(saved.failure.updated)) {
        const idade = Date.now() - saved.failure.updated;
        if (idade >= 0 && idade < LIMIT) falhaSalva = saved.failure;
      }
    } catch { statusText = 'Não foi possível recuperar a consulta anterior.'; }
  }

  // 4. Leitura dos documentos e controles do ELO

  /** Confere disponibilidade e visibilidade antes de usar um controle nativo do ELO. */
  function elementoVisivel(node) {
    if (!node?.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true'
      || node.classList?.contains('ui-state-disabled')) return false;
    const win = node.ownerDocument?.defaultView;
    if (!win) return false;
    const style = win.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse' && node.getClientRects().length > 0;
  }

  /** Lê a inscrição eleitoral na célula seguinte ao rótulo de identificação. */
  function obterTituloEleitor(cells) {
    const label = cells.find(cell => /^Inscrição:\s*$/i.test(cell.textContent.trim()));
    return normalizarTitulo(label?.nextElementSibling?.textContent);
  }

  /** Extrai a inscrição dos argumentos do onclick do ELO, sem executar esse código. */
  function extrairTituloDoClique(link, argumentIndex) {
    const args = (link.getAttribute('onclick') || '').match(/\(\s*['"](\d+)['"](?:\s*,\s*['"]([^'"]*)['"])?/);
    return normalizarTitulo(args?.[argumentIndex + 1]);
  }

  /** Identifica o eleitor sem link de histórico apenas após o carregamento completo dos detalhes. */
  function obterTituloSemHistoricoAse(doc, aseLinks) {
    // O ELO omite o link ASE quando o eleitor não possui esses registros.
    // Só conclui ausência depois do carregamento completo dos detalhes.
    if (doc.readyState !== 'complete' || aseLinks.length) return null;
    const cells = Array.from(doc.querySelectorAll('td'));
    const history = cells.some(cell => /^Histórico:\s*$/i.test(cell.textContent.trim()));
    return history ? obterTituloEleitor(cells) : null;
  }

  /** Reconhece a tela de histórico carregada e devolve o título ao qual ela pertence. */
  function obterTituloHistoricoCarregado(doc) {
    if (doc.readyState !== 'complete') return null;
    // Pré-filtro barato: innerText força cálculo de layout, então só é lido se o texto parece estar na página.
    if (!/Hist\S{0,3}rico\s*ASE/i.test(doc.body?.textContent || '')) return null;
    if (!/^\s*Histórico\s+ASE\s*$/im.test(doc.body?.innerText || '')) return null;
    return obterTituloEleitor(Array.from(doc.querySelectorAll('td')));
  }

  /** Lê código e data de ocorrência na mesma linha. Retorna boolean[] por turno, ou null se a tabela não puder ser interpretada. */
  function lerAsesPorTurno(doc, code = CONFIG.aseCode, requiredStatus = '', rows = Array.from(doc.querySelectorAll('tr'))) {
    // Cada código e data precisam estar na mesma linha da tabela de histórico.
    const header = rows.find(row => {
      const names = Array.from(row.cells, cell => cell.textContent.trim());
      return names.includes('ASE') && names.includes('Ocorrência');
    });
    if (!header) return null;
    const names = Array.from(header.cells, cell => cell.textContent.trim());
    const codeColumn = names.indexOf('ASE');
    const occurrenceColumn = names.indexOf('Ocorrência');
    const statusColumn = names.indexOf('Situação');
    const acceptedStatuses = Array.isArray(requiredStatus) ? requiredStatus : requiredStatus ? [requiredStatus] : [];
    // Uma coluna não reconhecida não equivale à ausência de registro.
    if (acceptedStatuses.length && statusColumn < 0) return null;
    const table = header.closest('table');
    if (!table) return null;
    const found = CONFIG.turns.map(() => false);
    for (const row of Array.from(table.rows)) {
      if (row.cells[codeColumn]?.textContent.trim().padStart(3, '0') !== code.padStart(3, '0')) continue;
      if (acceptedStatuses.length && !acceptedStatuses.includes(row.cells[statusColumn]?.textContent.replace(/\s+/g, ' ').trim().toUpperCase())) continue;
      const date = row.cells[occurrenceColumn]?.textContent.replace(/\s+/g, ' ').trim();
      const index = CONFIG.turns.findIndex(turn => turn.date === date);
      if (index >= 0) found[index] = true;
    }
    return found;
  }

  /** Obtém o nome na linha do mesmo título, evitando nomes de outros elementos da página. */
  function obterNomeEleitor(doc, title) {
    // O cadastro pode usar “Nome Civil” e o histórico, “Nome”. A inscrição valida a linha.
    for (const row of doc.querySelectorAll('tr')) {
      const cells = Array.from(row.cells);
      if (obterTituloEleitor(cells) !== title) continue;
      const label = cells.find(cell => /^Nome(?:\s+Civil)?\s*:$/i.test(cell.textContent.trim()));
      const name = label?.nextElementSibling?.textContent.replace(/\s+/g, ' ').trim();
      if (name) return name;
    }
    return '';
  }

  /** Aplica uma correção visual isolada para a tabela não cobrir o botão Voltar do ELO. */
  function corrigirBotaoVoltarHistorico(doc) {
    if (!doc.querySelector('a[name="btn_voltar"] img[name="img_btn_voltar"]')
      || doc.querySelector('style[data-elo-ase-back-fix]')) return;
    // A tabela do ELO usa position:absolute e z-index:2, cobrindo o botão nativo.
    const style = doc.createElement('style');
    style.setAttribute('data-elo-ase-back-fix', '');
    style.textContent = 'a[name="btn_voltar"] img[name="img_btn_voltar"] { position:relative; z-index:3; }';
    (doc.head || doc.documentElement).append(style);
  }

  /** Reúne os controles e identificações de todos os quadros acessíveis, com limite de profundidade. */
  function coletarQuadros() {
    const views = [];
    // Visita recursiva protegida contra quadros de outra origem e aninhamento excessivo.
    function visitarQuadro(win, depth) {
      if (depth > 6) return;
      let doc;
      try {
        doc = win.document;
        if (!doc.documentElement) return;
      } catch { return; } // O acesso a quadros de outra origem pode ser recusado.
      const links = Array.from(doc.querySelectorAll('a[onclick]'));
      const firstResult = links.find(a => /^\s*consEleitor\s*\(/.test(a.getAttribute('onclick') || '') && elementoVisivel(a));
      const aseLinks = links.filter(a => /^\s*ConsultaHistoricoFase\s*\(/.test(a.getAttribute('onclick') || ''));
      // Verifica a existência de ASE antes de filtrar links disponíveis para clique.
      const ase = aseLinks.find(a => (!state || extrairTituloDoClique(a, 1) === state.title) && elementoVisivel(a));
      const historyTitle = obterTituloHistoricoCarregado(doc);
      views.push({win, doc, input:doc.querySelector('#num_inscricao_cpf'),
        consult:doc.querySelector('input[name="btn_consultar"]'),
        result:firstResult ? {node:firstResult, title:extrairTituloDoClique(firstResult, 0)} : null,
        ase:ase ? {node:ase, title:extrairTituloDoClique(ase, 1)} : null,
        noAseTitle:state?.phase === 'detail' ? obterTituloSemHistoricoAse(doc, aseLinks) : null,
        historyTitle});
      for (const frame of doc.querySelectorAll('frame,iframe')) {
        if (frame.contentWindow) visitarQuadro(frame.contentWindow, depth + 1);
      }
    }
    visitarQuadro(window, 0);
    return views;
  }

  // 5. Textos dos relatórios

  /** Padroniza a grafia do turno usada nos relatórios. */
  function rotuloTurno(turn) {
    // Mesma grafia ("1º Turno") em todas as mensagens.
    return turn.label.replace(/turno/gi, 'Turno');
  }

  /** Descreve os turnos sem ASE 094 ou avisa quando a conferência não foi possível. */
  function relatarAusencias(absenceFound) {
    if (!absenceFound) return `Não foi possível conferir o ASE ${CONFIG.absenceAseCode}. Confira manualmente a situação dos registros no ELO.`;
    return CONFIG.turns.filter((_, index) => !absenceFound[index])
      .map(turn => `Não há ausência (ASE ${CONFIG.absenceAseCode}) registrada no ${rotuloTurno(turn)} (${turn.date}).`).join('\n');
  }

  /** Monta somente o texto do relatório; a definição de cor e a limpeza do campo ficam na conferência. */
  function montarRelatorioTurnos(title, found, name = '', absenceFound, ausenciasParaOrientacao) {
    const heading = `ELEITOR(A): ${name.trim() || 'nome não identificado'}\nTÍTULO: ${formatarTitulo(title)}`;
    if (found?.every(Boolean)) {
      if (CONFIG.turns.length === 1) {
        const turn = CONFIG.turns[0];
        return `${heading}\nASE ${CONFIG.aseCode} registrado no ${rotuloTurno(turn)} (${turn.date}).\nNão há registros a serem feitos.`;
      }
      const dates = CONFIG.turns.map(turn => `${rotuloTurno(turn)} (${turn.date})`).join('\n');
      return `${heading}\nASE ${CONFIG.aseCode} registrado ${CONFIG.turns.length === 2 ? 'nos dois turnos' : 'em todos os turnos'}.\n${dates}\nNão há registros a serem feitos.`;
    }
    const absence = absenceFound === undefined ? '' : relatarAusencias(absenceFound);
    if (!found) {
      return heading + '\nNão foi possível identificar a tabela do histórico ASE. Confira manualmente os registros dos turnos.'
        + (absence ? `\n${absence}` : '');
    }
    const sections = CONFIG.turns.map((turn, index) => {
      const label = rotuloTurno(turn);
      const lines = [];
      if (absenceFound?.[index]) {
        const situacao = ausenciasParaOrientacao && !ausenciasParaOrientacao[index] ? 'INATIVO ' : '';
        lines.push(`ASE ${CONFIG.absenceAseCode} ${situacao}encontrado no ${label} (${turn.date}).`);
      }
      if (found[index]) {
        lines.push(`ASE ${CONFIG.aseCode} registrado no ${label} (${turn.date}).`);
      } else if (absenceFound?.[index]) {
        lines.push(`ASE ${CONFIG.aseCode} não encontrado no ${label} (${turn.date}).`);
        if (ausenciasParaOrientacao?.[index]) lines.push(`Registre o ASE ${CONFIG.aseCode} no ${label}, se for o caso.`);
      } else if (!absenceFound) {
        lines.push(`ASE ${CONFIG.aseCode} não encontrado no ${label} (${turn.date}).`);
      }
      return lines.join('\n');
    });
    if (absence) sections.push(absence);
    if (absenceFound && ausenciasParaOrientacao && !ausenciasParaOrientacao.some((ausencia, index) => ausencia && !found[index])) {
      sections.push('Não há registros a serem feitos.');
    }
    return heading + '\n' + sections.filter(Boolean).join('\n\n');
  }

  // 6. Popovers: apresentação, prazo e fechamento

  /** Fecha o aviso atual e cancela seu temporizador para não afetar um aviso posterior. */
  function fecharPopover() {
    if (popoverTimer !== null) window.clearTimeout(popoverTimer);
    popoverTimer = null;
    popover?.remove();
    popover = null;
  }

  /** Exibe qualquer tipo de aviso por CONFIG.popoverDurationMs, com fechamento manual pelo botão X. */
  function exibirPopover(message, doc, tone = 'warning') {
    fecharPopover();
    if (doc?.body?.tagName !== 'BODY') return;
    popover = doc.createElement('div');
    popover.setAttribute('role', 'alert');
    popover.setAttribute('data-elo-ase-popover', '');
    popover.style.cssText = 'position:fixed;inset:auto;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;box-sizing:border-box;width:max-content;min-width:min(520px,calc(100vw - 32px));max-width:calc(100vw - 32px);padding:36px 40px 24px;border:2px solid #c58a14;border-radius:12px;background:#fff8e6;color:#593b00;box-shadow:0 10px 40px #0004;font:600 18px/1.5 Arial,sans-serif;text-align:center;z-index:2147483647;pointer-events:none;overflow-wrap:anywhere';
    popover.style.whiteSpace = 'pre-line';
    if (tone === 'success') {
      popover.style.background = '#edf9f0'; popover.style.borderColor = '#278046'; popover.style.color = '#14562b';
    } else if (tone === 'pending') {
      popover.style.background = '#fff0df'; popover.style.borderColor = '#d96b00'; popover.style.color = '#7a3500';
    } else if (tone === 'error') {
      popover.style.background = '#fdecec'; popover.style.borderColor = '#b3261e'; popover.style.color = '#6b130e';
    }
    popover.textContent = message;
    const close = doc.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Fechar aviso';
    close.setAttribute('aria-label', 'Fechar aviso');
    close.style.cssText = 'position:absolute;top:8px;right:8px;width:28px;height:28px;margin:0;padding:0;border:0;border-radius:4px;background:transparent;color:inherit;font:700 24px/1 Arial,sans-serif;cursor:pointer;pointer-events:auto;display:flex;align-items:center;justify-content:center';
    close.addEventListener('click', fecharPopover);
    popover.append(close);
    isolarEventosDoScript(popover);
    doc.body.append(popover);
    // A camada superior mantém o aviso à frente do painel, quando disponível.
    if (typeof popover.showPopover === 'function') {
      popover.setAttribute('popover', 'manual');
      try { popover.showPopover(); }
      catch { popover.removeAttribute('popover'); }
    }
    popoverTimer = window.setTimeout(fecharPopover, CONFIG.popoverDurationMs);
  }

  // 7. Painel: montagem, entrada e interação

  /** Atualiza a mensagem persistente do painel usando texto, sem interpretar HTML. O tom colore o resultado. */
  function atualizarMensagemPainel(text, tone = 'neutral') {
    falhaSalva = null;
    const mudou = statusText !== text || statusTone !== tone;
    statusText = text;
    statusTone = Object.hasOwn(TONS_STATUS, tone) ? tone : 'neutral';
    const status = panel?.querySelector('[data-status]');
    if (status && status.textContent !== text) status.textContent = text;
    if (mudou) limparRetornoCopia();
    aplicarTomStatus();
  }

  /** Mantém no painel a cor do resultado (mesmas cores dos avisos) depois que o aviso some. */
  function aplicarTomStatus(elemento = panel) {
    const secao = elemento?.querySelector('[data-status-section]');
    if (!secao) return;
    const tom = TONS_STATUS[statusTone] || TONS_STATUS.neutral;
    secao.style.background = tom.fundo;
    secao.style.borderColor = tom.borda;
    secao.style.borderLeftColor = tom.destaque;
    elemento.querySelector('[data-status]').style.color = tom.texto;
    // Só resultados e falhas podem ser copiados; mensagens de andamento não.
    const copiar = elemento.querySelector('[data-copy]');
    if (copiar) {
      copiar.disabled = statusTone === 'neutral';
      copiar.style.opacity = copiar.disabled ? '0.45' : '1';
      copiar.style.cursor = copiar.disabled ? 'not-allowed' : 'pointer';
    }
  }

  /** Cancela o retorno visual anterior, liberando a referência ao botão e ao documento. */
  function limparRetornoCopia() {
    if (temporizadorCopia !== null) window.clearTimeout(temporizadorCopia);
    temporizadorCopia = null;
    const botao = panel?.querySelector('[data-copy]');
    if (botao) botao.textContent = 'Copiar';
  }

  /** Copia o texto do resultado exibido no painel, com alternativa para navegadores sem Clipboard API. */
  async function copiarStatus() {
    const elemento = panel;
    const texto = elemento?.querySelector('[data-status]')?.textContent;
    const botao = elemento?.querySelector('[data-copy]');
    if (!texto || !botao || botao.disabled) return;
    const doc = elemento.ownerDocument;
    let copiado = false;
    try {
      const clipboard = doc.defaultView?.navigator?.clipboard;
      if (clipboard?.writeText) {
        await clipboard.writeText(texto);
        copiado = true;
      }
    } catch { /* A alternativa abaixo também funciona sem a Clipboard API. */ }

    // A consulta ou o quadro podem ter mudado enquanto o navegador respondia.
    if (suspended || !elemento.isConnected || panel !== elemento || statusText !== texto || botao.disabled) return;
    if (!copiado) {
      const foco = doc.activeElement;
      const area = doc.createElement('textarea');
      try {
        area.value = texto;
        area.setAttribute('readonly', '');
        area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
        elemento.append(area);
        area.select();
        copiado = Boolean(doc.execCommand?.('copy'));
      } catch { /* O retorno do botão informa a falha de cópia. */ }
      finally {
        area.remove();
        if (foco?.isConnected) foco.focus({preventScroll:true});
      }
    }
    limparRetornoCopia();
    botao.textContent = copiado ? 'Copiado ✓' : 'Falhou';
    temporizadorCopia = window.setTimeout(limparRetornoCopia, 1600);
  }

  /** Atualiza validação, orientação e disponibilidade dos botões de acordo com a entrada e a etapa. */
  function atualizarBotoes() {
    if (!panel) return;
    const active = consultaEmAndamento();
    const input = panel.querySelector('[data-title]');
    const valid = tituloValido(input.value);
    const length = input.value.replace(/\D/g, '').length;
    const invalid = length >= 12 && !valid;
    const feedback = panel.querySelector('[data-title-feedback]');
    const message = !length ? 'Digite os 12 dígitos do título.'
      : length < 12 ? `Complete o título: ${12 - length === 1 ? 'falta 1 dígito' : `faltam ${12 - length} dígitos`}.`
      : invalid ? 'Título inválido. Corrija os números para consultar.'
      : 'Dígitos verificadores válidos.';
    input.setAttribute('aria-invalid', String(invalid));
    input.style.borderColor = invalid ? '#b3261e' : valid ? '#278046' : '#a6b6c5';
    if (feedback) {
      if (feedback.textContent !== message) feedback.textContent = message;
      feedback.style.color = invalid ? '#b3261e' : valid ? '#14562b' : '#526577';
    }
    const submit = panel.querySelector('[data-submit]');
    submit.disabled = active || !valid;
    submit.textContent = active ? 'Consultando…' : 'Consultar ASE';
    submit.style.opacity = active ? '0.8' : submit.disabled ? '0.45' : '1';
    submit.style.cursor = submit.disabled ? 'not-allowed' : 'pointer';
    const cancel = panel.querySelector('[data-cancel]');
    cancel.disabled = !active;
    cancel.style.opacity = cancel.disabled ? '0.45' : '1';
    cancel.style.cursor = cancel.disabled ? 'not-allowed' : 'pointer';
    const back = panel.querySelector('[data-return]');
    back.disabled = !home;
    back.style.opacity = back.disabled ? '0.45' : '1';
    back.style.cursor = back.disabled ? 'not-allowed' : 'pointer';
    const activity = panel.querySelector('[data-activity]');
    activity.textContent = active ? 'Em consulta' : 'Pronto';
    activity.style.background = active ? '#dceaf8' : '#e9eff6';
    activity.style.color = active ? '#174975' : '#425e7d';
    panel.querySelector('[data-election-select]').disabled = active;
    for (const controle of panel.querySelectorAll('[data-turn]')) controle.disabled = active;
  }

  /** Remove o atalho anterior, inclusive quando o ELO substitui o documento do painel. */
  function removerBotaoRestaurarPainel() {
    botaoRestaurarPainel?.remove();
    botaoRestaurarPainel = null;
  }

  /** Exibe somente uma seta no canto superior direito, sem deslocar o painel original. */
  function exibirBotaoRestaurarPainel() {
    const doc = panel?.ownerDocument;
    if (doc?.body?.tagName !== 'BODY') return;
    if (botaoRestaurarPainel?.isConnected && botaoRestaurarPainel.ownerDocument === doc) return;
    removerBotaoRestaurarPainel();
    botaoRestaurarPainel = doc.createElement('button');
    botaoRestaurarPainel.type = 'button';
    botaoRestaurarPainel.textContent = '←';
    botaoRestaurarPainel.title = 'Restaurar painel de consulta ASE';
    botaoRestaurarPainel.setAttribute('aria-label', 'Restaurar painel de consulta ASE');
    botaoRestaurarPainel.setAttribute('data-elo-ase-restaurar', '');
    botaoRestaurarPainel.style.cssText = ESTILO_BOTAO_RESTAURAR_PAINEL;
    const botao = botaoRestaurarPainel;
    botao.addEventListener('mouseenter', () => { botao.style.opacity = '1'; });
    botao.addEventListener('mouseleave', () => {
      if (doc.activeElement !== botao) botao.style.opacity = '0.65';
    });
    botao.addEventListener('focus', () => { botao.style.opacity = '1'; });
    botao.addEventListener('blur', () => { botao.style.opacity = '0.65'; });
    botaoRestaurarPainel.addEventListener('click', () => {
      definirPainelRecolhido(false, true);
      focarCampoTitulo();
    });
    isolarEventosDoScript(botaoRestaurarPainel);
    doc.body.append(botaoRestaurarPainel);
  }

  /** Preserva a minimização escolhida pelo usuário; somente a restauração manual a desfaz. */
  function definirPainelRecolhido(recolhido, restauracaoManual = false) {
    if (!panel) return;
    // Resultados e erros continuam nos popovers sem reabrir o painel contra a escolha do usuário.
    if (!recolhido && panel.hidden && !restauracaoManual) return;
    panel.hidden = recolhido;
    panel.querySelector('[data-body]').hidden = recolhido;
    const button = panel.querySelector('[data-collapse]');
    button.textContent = recolhido ? '+' : '−';
    button.setAttribute('aria-label', recolhido ? 'Restaurar painel' : 'Minimizar painel');
    button.setAttribute('aria-expanded', String(!recolhido));
    if (recolhido) exibirBotaoRestaurarPainel();
    else { removerBotaoRestaurarPainel(); posicionarPainel(panel); }
  }

  /** Foca o campo apenas quando ele está conectado e visível; pode selecionar seu conteúdo. */
  function focarCampoTitulo(select = false) {
    const input = panel?.querySelector('[data-title]');
    if (input?.isConnected && !panel.hidden && !panel.querySelector('[data-body]').hidden) {
      input.focus({preventScroll:true});
      if (select) input.select();
    }
  }

  /** Limpa a entrada e marca a sessão para não restaurar o título quando o painel for recriado. */
  function limparCampoTitulo() {
    const input = panel?.querySelector('[data-title]');
    if (!input) return;
    input.value = '';
    atualizarBotoes();
    // Evita restaurar o título apagado quando o painel for recriado.
    if (state && !state.clearTitle) {
      state.clearTitle = true;
      try { salvarSessao(); } catch { /* A limpeza do campo continua disponível. */ }
    }
    focarCampoTitulo();
  }

  /** Impede que eventos dos controles próprios acionem rotinas legadas da página. */
  function isolarEventosDoScript(element) {
    // Os tratadores globais legados do ELO não conhecem os controles deste painel.
    // Interrompe só a propagação: digitação, foco e envio por Enter continuam nativos.
    for (const type of ['keydown', 'keypress', 'keyup', 'click', 'dblclick',
      'mousedown', 'mouseup', 'mouseover', 'mouseout', 'input', 'change',
      'focusin', 'focusout', 'submit']) {
      element.addEventListener(type, event => event.stopPropagation());
    }
  }

  // Estilos centralizados e aplicados inline: preserva a prioridade visual no ELO.
  // A chave "raiz" identifica o próprio painel; as demais identificam seus controles.
  const ESTILOS_PAINEL = Object.freeze({
    raiz: `
      position: fixed; top: 80px; right: 20px;
      width: 320px; max-width: calc(100vw - 24px);
      z-index: 2147483647; box-sizing: border-box;
      background: #fff; color: #172b45;
      border: 1px solid #d9e2ee; border-radius: 14px;
      box-shadow: 0 12px 36px #16345424, 0 2px 6px #1634540d;
      font: 13px/1.45 Arial,sans-serif; text-align: left;
      overflow: hidden;
    `,
    '[data-handle]': `
      display: flex; align-items: center; justify-content: space-between;
      gap: 10px; padding: 12px;
      background: #f7f9fc; border-bottom: 1px solid #e7edf5;
      cursor: move; touch-action: none; user-select: none;
    `,
    '[data-brand]': `display: flex; align-items: center; gap: 9px; min-width: 0;`,
    '[data-brand-mark]': `
      display: flex; align-items: center; justify-content: center;
      flex: 0 0 32px; width: 32px; height: 32px;
      border-radius: 9px; background: #174975; color: #fff;
      font: 700 10px/1 Arial,sans-serif; letter-spacing: .5px;
    `,
    '[data-panel-title]': `display: block; font: 700 14px/1.3 Arial,sans-serif; color: #183451;`,
    '[data-collapse]': `
      display: flex; align-items: center; justify-content: center;
      flex: 0 0 30px; width: 30px; height: 30px;
      margin: 0; padding: 0; appearance: none;
      background: #fff; color: #4b627d;
      border: 1px solid #dce4ee; border-radius: 8px;
      font: 20px/1 Arial,sans-serif; cursor: pointer;
    `,
    // A altura máxima é recalculada por posicionarPainel, conforme a altura da janela.
    '[data-body]': `padding: 12px; max-height: calc(100vh - 156px); overflow-y: auto; box-sizing: border-box;`,
    '[data-election-controls]': `margin: 0 0 12px; padding: 0 0 12px; border-bottom: 1px solid #e7edf5;`,
    '[data-election-toggle]': `display: flex; align-items: center; justify-content: space-between; gap: 8px; box-sizing: border-box; width: 100%; margin: 0; padding: 0; border: 0; background: transparent; color: #253d58; text-align: left; font: 700 12px/1.4 Arial,sans-serif; cursor: pointer;`,
    '[data-election-copy]': `display: block; min-width: 0;`,
    '[data-selection-summary]': `display: block; margin-top: 3px; color: #64758a; font: 11px/1.4 Arial,sans-serif;`,
    '[data-election-chevron]': `flex: 0 0 auto; color: #64758a; font: 16px/1 Arial,sans-serif;`,
    '[data-election-options]': `margin-top: 9px;`,
    '[data-election-label]': `display: block; margin: 0 0 5px; color: #253d58; font: 700 12px/1.4 Arial,sans-serif;`,
    '[data-election-select]': `box-sizing: border-box; width: 100%; height: 32px; margin: 0; padding: 4px 8px; border: 1px solid #cbd6e3; border-radius: 7px; background: #f8fafc; color: #253d58; font: 12px/1.4 Arial,sans-serif;`,
    '[data-turns]': `display: grid; grid-template-columns: repeat(auto-fit,minmax(112px,1fr)); gap: 6px; margin-top: 7px;`,
    '[data-turn-option]': `display: flex; align-items: center; gap: 6px; box-sizing: border-box; margin: 0; padding: 6px; border: 1px solid #dce4ee; border-radius: 7px; background: #f8fafc; color: #344f6d; font: 11px/1.4 Arial,sans-serif; cursor: pointer; white-space: pre-line;`,
    '[data-turn]': `flex: 0 0 14px; width: 14px; height: 14px; margin: 0; padding: 0; accent-color: #174975;`,
    '[data-form]': `margin: 0; padding: 0;`,
    '[data-input-heading]': `display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;`,
    'label[for="elo-ase-titulo"]': `display: block; margin: 0; color: #253d58; font: 700 12px/1.4 Arial,sans-serif;`,
    '[data-shortcut]': `font: 11px/1.4 Arial,sans-serif; color: #5b6d82; white-space: nowrap;`,
    '[data-title-wrapper]': `position: relative;`,
    '[data-title]': `
      box-sizing: border-box; width: 100%; min-width: 0;
      height: 44px; padding: 10px 38px 10px 11px;
      border: 1px solid #a6b6c5; border-radius: 9px;
      background: #f8fafc; color: #172b45;
      font: 19px/1.2 monospace; font-variant-numeric: tabular-nums;
    `,
    '[data-clear-title]': `
      position: absolute; right: 5px; top: 50%; transform: translateY(-50%);
      width: 28px; height: 28px; margin: 0; padding: 0; appearance: none;
      border: 0; border-radius: 6px; background: transparent; color: #60748e;
      font: 21px/1 Arial,sans-serif; cursor: pointer;
    `,
    '[data-title-feedback]': `
      min-height: 16px; margin: 6px 0 0;
      font: 11px/1.45 Arial,sans-serif; color: #526577;
    `,
    '[data-submit]': `
      box-sizing: border-box; width: 100%; min-height: 40px;
      margin: 9px 0 0; padding: 9px 12px; appearance: none;
      border: 1px solid #174975; border-radius: 8px;
      background: #174975; color: #fff;
      font: 700 14px/1.4 Arial,sans-serif; cursor: pointer;
    `,
    '[data-actions]': `display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px;`,
    '[data-return]': `
      box-sizing: border-box; width: 100%; min-width: 0; min-height: 32px;
      margin: 0; padding: 6px 8px; appearance: none;
      border: 1px solid #dce4ee; border-radius: 7px;
      background: #f7f9fc; color: #344f6d;
      font: 600 12px/1.4 Arial,sans-serif; cursor: pointer;
    `,
    '[data-cancel]': `
      box-sizing: border-box; width: 100%; min-width: 0; min-height: 32px;
      margin: 0; padding: 6px 8px; appearance: none;
      border: 1px solid #f0d5d5; border-radius: 7px;
      background: #fff7f7; color: #9d3434;
      font: 600 12px/1.4 Arial,sans-serif; cursor: pointer;
    `,
    '[data-status-section]': `margin-top: 12px; padding: 10px; border: 1px solid #e5ebf3; border-left: 4px solid #cbd6e3; border-radius: 9px; background: #f8fafc;`,
    '[data-status-heading]': `display: flex; align-items: center; justify-content: space-between; gap: 8px;`,
    '[data-status-label]': `font: 700 10px/1.4 Arial,sans-serif; letter-spacing: .7px; text-transform: uppercase; color: #61748b;`,
    '[data-status-tools]': `display: flex; align-items: center; gap: 6px;`,
    '[data-activity]': `padding: 2px 6px; border-radius: 4px; background: #e9eff6; color: #425e7d; font: 600 10px/1.4 Arial,sans-serif; white-space: nowrap;`,
    '[data-copy]': `margin: 0; padding: 2px 8px; appearance: none; border: 1px solid #cbd6e3; border-radius: 5px; background: #fff; color: #344f6d; font: 600 10px/1.5 Arial,sans-serif; white-space: nowrap; cursor: pointer;`,
    '[data-status]': `
      margin: 7px 0 0; max-height: 150px; overflow-y: auto;
      font: 12px/1.55 Arial,sans-serif; color: #344b65;
      white-space: pre-line; overflow-wrap: anywhere;
    `
  });

  // Cores do resultado no painel; seguem as dos avisos para o usuário reconhecer o estado.
  const TONS_STATUS = Object.freeze({
    neutral: Object.freeze({fundo:'#f8fafc', borda:'#e5ebf3', destaque:'#cbd6e3', texto:'#344b65'}),
    success: Object.freeze({fundo:'#edf9f0', borda:'#bfe3c9', destaque:'#278046', texto:'#14562b'}),
    pending: Object.freeze({fundo:'#fff0df', borda:'#f1c79a', destaque:'#d96b00', texto:'#7a3500'}),
    warning: Object.freeze({fundo:'#fff8e6', borda:'#ecd199', destaque:'#c58a14', texto:'#593b00'}),
    error:   Object.freeze({fundo:'#fdecec', borda:'#efb6b2', destaque:'#b3261e', texto:'#6b130e'})
  });

  // Estados que o estilo inline não alcança (foco, passagem do mouse, turno marcado).
  // O escopo pelo id do painel evita qualquer efeito sobre a página do ELO.
  const CSS_ESTADOS_PAINEL = `
    #${PANEL} button:focus-visible,
    #${PANEL} select:focus-visible,
    #${PANEL} [data-status]:focus-visible { outline: 3px solid #f5b942 !important; outline-offset: 2px !important; }
    #${PANEL} [data-title]:focus { outline: 3px solid #9cc4e8 !important; outline-offset: 1px !important; }
    #${PANEL} [data-collapse]:hover,
    #${PANEL} [data-copy]:not(:disabled):hover { background: #eaf2fa !important; }
    #${PANEL} [data-clear-title]:hover { background: #e8eef4 !important; }
    #${PANEL} [data-submit]:not(:disabled):hover { background: #1f5f98 !important; }
    #${PANEL} [data-return]:not(:disabled):hover { background: #eaf2fa !important; }
    #${PANEL} [data-cancel]:not(:disabled):hover { background: #fdecec !important; }
    #${PANEL} [data-turn-option]:hover { border-color: #9cc4e8 !important; }
  `;
  const CSS_TURNO_MARCADO = `
    #${PANEL} [data-turn-option]:has(input:checked) { background: #e6f0fa !important; border-color: #9cc4e8 !important; }
  `;

  // Atalho independente do painel: não altera a posição salva para o tamanho normal.
  const ESTILO_BOTAO_RESTAURAR_PAINEL = `
    position: fixed;
    top: 8px;
    right: 8px;
    width: 24px;
    height: 28px;
    margin: 0;
    padding: 0;
    border: 1px solid #d9e2eb;
    border-radius: 5px;
    background: #f8fafc;
    color: #62758c;
    box-shadow: none;
    opacity: 0.65;
    font: 18px/1 Arial,sans-serif;
    cursor: pointer;
    z-index: 2147483647;
    box-sizing: border-box;
  `;

  /** Define a estrutura estática. Valores digitados e mensagens são atribuídos depois como texto. */
  function obterHtmlPainel() {
    return `
      <div data-handle>
        <div data-brand>
          <span data-brand-mark aria-hidden="true">ASE</span>
          <div>
            <strong data-panel-title>Consulta ASE</strong>
          </div>
        </div>
        <button type="button" data-collapse title="Minimizar painel" aria-label="Minimizar painel">−</button>
      </div>
      <div data-body>
        <div data-election-controls>
          <button data-election-toggle type="button" aria-expanded="false" aria-controls="elo-ase-selecao">
            <span data-election-copy>Eleição e turnos<span data-selection-summary></span></span>
            <span data-election-chevron aria-hidden="true">▸</span>
          </button>
          <div data-election-options id="elo-ase-selecao" hidden>
            <label data-election-label for="elo-ase-eleicao">Eleição</label>
            <select data-election-select id="elo-ase-eleicao" aria-label="Eleição"></select>
            <div data-turns role="group" aria-label="Turnos para conferir"></div>
          </div>
        </div>
        <form data-form>
          <div data-input-heading>
            <label for="elo-ase-titulo">Título de eleitor</label>
            <span data-shortcut>Esc para limpar</span>
          </div>
          <div data-title-wrapper>
            <input id="elo-ase-titulo" data-title type="text" inputmode="numeric"
              aria-describedby="elo-ase-titulo-feedback" autocomplete="off" spellcheck="false"
              maxlength="20" placeholder="0000 0000 0000">
            <button data-clear-title type="button" aria-label="Limpar título" title="Limpar título (Esc)">×</button>
          </div>
          <p id="elo-ase-titulo-feedback" data-title-feedback aria-live="polite">Digite os 12 dígitos do título.</p>
          <button disabled data-submit type="submit">Consultar ASE</button>
        </form>
        <div data-actions>
          <button data-return type="button" title="Voltar à consulta inicial" aria-label="Voltar à consulta inicial">Voltar</button>
          <button data-cancel type="button" title="Parar automação" aria-label="Parar automação">Parar</button>
        </div>
        <div data-status-section>
          <div data-status-heading>
            <span data-status-label>Acompanhamento</span>
            <span data-status-tools>
              <span data-activity>Pronto</span>
              <button data-copy type="button" title="Copiar o resultado" aria-label="Copiar o resultado">Copiar</button>
            </span>
          </div>
          <p data-status role="status" aria-live="polite" tabindex="0"></p>
        </div>
        <style data-elo-ase-estados></style>
      </div>
    `;
  }

  /** Aplica a aparência inicial; cores de validação e estados dos botões continuam dinâmicos. */
  function aplicarEstilosPainel(elemento) {
    for (const [seletor, estilos] of Object.entries(ESTILOS_PAINEL)) {
      const controles = seletor === 'raiz' ? [elemento] : elemento.querySelectorAll(seletor);
      for (const controle of controles) controle.style.cssText = estilos;
    }
  }

  /** Cria o painel completo sem inseri-lo na página ou registrar interações. */
  function criarPainel(doc) {
    const elemento = doc.createElement('section');
    elemento.id = PANEL;
    elemento.setAttribute('aria-label', 'Consulta rápida ASE');
    elemento.innerHTML = obterHtmlPainel();
    atualizarSelecaoPainel(elemento);
    aplicarEstilosPainel(elemento);
    // O CSS é texto puro; a regra com :has fica separada para não invalidar as demais em navegadores antigos.
    const estados = elemento.querySelector('[data-elo-ase-estados]');
    estados.textContent = CSS_ESTADOS_PAINEL;
    const turnoMarcado = doc.createElement('style');
    turnoMarcado.textContent = CSS_TURNO_MARCADO;
    estados.after(turnoMarcado);
    aplicarTomStatus(elemento);
    definirSelecaoRecolhida(escolhaEleitoralRecolhida, elemento);
    return elemento;
  }

  /** Recolhe apenas as opções eleitorais, mantendo o resumo e o restante do painel visíveis. */
  function definirSelecaoRecolhida(recolhida, elemento = panel) {
    escolhaEleitoralRecolhida = Boolean(recolhida);
    if (!elemento) return;
    elemento.querySelector('[data-election-options]').hidden = escolhaEleitoralRecolhida;
    const botao = elemento.querySelector('[data-election-toggle]');
    botao.setAttribute('aria-expanded', String(!escolhaEleitoralRecolhida));
    botao.title = escolhaEleitoralRecolhida ? 'Expandir eleição e turnos' : 'Recolher eleição e turnos';
    elemento.querySelector('[data-election-chevron]').textContent = escolhaEleitoralRecolhida ? '▸' : '▾';
  }

  /** Recria somente as opções de turno; não reaplica estilos que deslocariam o painel. */
  function atualizarSelecaoPainel(elemento = panel) {
    if (!elemento) return;
    const seletor = elemento.querySelector('[data-election-select]');
    if (!seletor.children.length) {
      for (const ano of Object.keys(ELEICOES).sort((a, b) => Number(b) - Number(a))) {
        const opcao = elemento.ownerDocument.createElement('option');
        opcao.value = ano;
        opcao.textContent = ano;
        seletor.append(opcao);
      }
    }
    seletor.value = String(eleicaoSelecionada);
    const grupo = elemento.querySelector('[data-turns]');
    grupo.textContent = '';
    ELEICOES[eleicaoSelecionada].forEach((turno, index) => {
      const rotulo = elemento.ownerDocument.createElement('label');
      rotulo.setAttribute('data-turn-option', '');
      rotulo.style.cssText = ESTILOS_PAINEL['[data-turn-option]'];
      const caixa = elemento.ownerDocument.createElement('input');
      caixa.type = 'checkbox';
      caixa.setAttribute('data-turn', '');
      caixa.value = String(index);
      caixa.checked = indicesTurnosSelecionados.includes(index);
      caixa.style.cssText = ESTILOS_PAINEL['[data-turn]'];
      const texto = elemento.ownerDocument.createElement('span');
      texto.textContent = `${rotuloTurno(turno)}\n${turno.date}`;
      rotulo.append(caixa, texto);
      grupo.append(rotulo);
    });
    elemento.querySelector('[data-selection-summary]').textContent = `${eleicaoSelecionada} · ${CONFIG.turns.map(rotuloTurno).join(' e ')}`;
  }

  /** Invalida o resultado anterior e relê o histórico aberto no novo contexto, se houver. */
  function alterarSelecaoEleitoral(ano, indices) {
    if (consultaEmAndamento()) return false;
    const anterior = chaveContextoEleitoral();
    if (!aplicarSelecaoEleitoral(ano, indices)) return false;
    if (anterior === chaveContextoEleitoral()) return true;
    // Também invalida a leitura se o usuário voltar à seleção anterior antes do próximo ciclo.
    checkedHistories = new WeakMap();
    historyWaits = new WeakMap();
    atualizarSelecaoPainel();
    interromperConsulta(`Eleição ${eleicaoSelecionada}: ${CONFIG.turns.map(rotuloTurno).join(' e ')}. Pronto para consultar.`);
    agendarVerificacao();
    return true;
  }

  /** Recupera a preferência do ano; na primeira escolha, marca todos os turnos cadastrados. */
  function alterarEleicaoPainel(evento) {
    const ano = Number(evento.currentTarget.value);
    const indices = turnosPorEleicao[ano] ?? ELEICOES[ano]?.map((_, index) => index);
    if (!alterarSelecaoEleitoral(ano, indices)) atualizarSelecaoPainel();
    atualizarBotoes();
  }

  /** Impede uma seleção vazia, mantendo a última opção e o contexto anterior intactos. */
  function alterarTurnosPainel() {
    const indices = Array.from(panel.querySelectorAll('[data-turn]'))
      .filter(controle => controle.checked).map(controle => Number(controle.value));
    if (!alterarSelecaoEleitoral(eleicaoSelecionada, indices)) {
      atualizarSelecaoPainel();
      if (!consultaEmAndamento()) atualizarMensagemPainel('Mantenha pelo menos um turno selecionado.', 'warning');
    }
    atualizarBotoes();
  }

  /** Escolhe um quadro com body, dando preferência ao quadro principal do ELO. */
  function selecionarQuadroPainel(quadros) {
    return quadros.find(quadro => quadro.win.name === 'principal' && quadro.doc.body?.tagName === 'BODY')
      || quadros.find(quadro => quadro.doc.body?.tagName === 'BODY' && (quadro.input || quadro.result || quadro.ase))
      || quadros.find(quadro => quadro.doc.body?.tagName === 'BODY');
  }

  /** Limpa pelo Esc sem interferir na composição de texto ou nos atalhos legados do ELO. */
  function tratarEscapeNoTitulo(evento) {
    if (evento.key !== 'Escape' || evento.isComposing) return;
    evento.preventDefault();
    evento.stopPropagation();
    limparCampoTitulo();
  }

  /** Reúne os eventos dos controles. É chamada somente na criação de um painel novo. */
  function registrarEventosPainel(elemento) {
    isolarEventosDoScript(elemento);
    elemento.querySelector('[data-election-toggle]').addEventListener('click', () => {
      definirSelecaoRecolhida(!escolhaEleitoralRecolhida);
      try { salvarSessao(); } catch { /* A expansão continua disponível sem armazenamento. */ }
    });
    elemento.querySelector('[data-election-select]').addEventListener('change', alterarEleicaoPainel);
    elemento.querySelector('[data-turns]').addEventListener('change', alterarTurnosPainel);
    const campoTitulo = elemento.querySelector('[data-title]');
    campoTitulo.addEventListener('input', formatarCampoTitulo);
    campoTitulo.addEventListener('keydown', tratarEscapeNoTitulo);
    elemento.querySelector('[data-clear-title]').addEventListener('click', limparCampoTitulo);
    elemento.querySelector('[data-form]').addEventListener('submit', iniciarConsulta);
    elemento.querySelector('[data-return]').addEventListener('click', voltarConsultaInicial);
    elemento.querySelector('[data-copy]').addEventListener('click', copiarStatus);
    elemento.querySelector('[data-cancel]').addEventListener('click', () => {
      interromperConsulta('Automação interrompida. Você pode voltar à consulta inicial.');
    });
    elemento.querySelector('[data-collapse]').addEventListener('click', () => {
      definirPainelRecolhido(!elemento.querySelector('[data-body]').hidden);
    });
  }

  /** Reaplica a posição preferida dentro do quadro atual e limita o conteúdo ao espaço disponível. */
  function posicionarPainel(elemento, posicao = savedPosition) {
    const janela = elemento.ownerDocument.defaultView;
    if (!janela || elemento.hidden) return posicao;
    const alturaCabecalho = elemento.querySelector('[data-handle]').offsetHeight;
    const margem = 12;
    const bordas = 2;
    const maxY = Math.max(0, janela.innerHeight - alturaCabecalho - bordas - margem - 140);
    const posicaoValida = Number.isFinite(posicao?.x) && Number.isFinite(posicao?.y);
    const y = Math.max(0, Math.min(posicaoValida ? posicao.y : 80, maxY));
    const alturaPainel = Math.max(0, janela.innerHeight - y - margem);
    elemento.style.top = y + 'px';
    elemento.style.maxHeight = alturaPainel + 'px';
    elemento.querySelector('[data-body]').style.maxHeight = Math.max(0, alturaPainel - alturaCabecalho - bordas) + 'px';
    if (!posicaoValida) return null;
    const x = Math.max(0, Math.min(posicao.x, janela.innerWidth - elemento.offsetWidth));
    elemento.style.right = 'auto';
    elemento.style.left = x + 'px';
    return {x, y};
  }

  /** Mantém o arraste restrito ao cabeçalho e salva a posição somente ao soltá-lo. */
  function habilitarArrastePainel(elemento, janela) {
    const cabecalho = elemento.querySelector('[data-handle]');
    let arraste = null;

    function iniciarArraste(evento) {
      if (evento.target.closest('button') || evento.button !== 0) return;
      const retangulo = elemento.getBoundingClientRect();
      arraste = {x: evento.clientX - retangulo.left, y: evento.clientY - retangulo.top};
      cabecalho.setPointerCapture(evento.pointerId);
      evento.preventDefault();
    }

    function moverPainel(evento) {
      if (!arraste) return;
      savedPosition = posicionarPainel(elemento, {x:evento.clientX - arraste.x, y:evento.clientY - arraste.y});
    }

    function concluirArraste() {
      if (!arraste) return;
      arraste = null;
      try { salvarSessao(); } catch { /* O arraste continua disponível sem armazenamento. */ }
      gravarPosicaoPersistida();
    }

    cabecalho.addEventListener('pointerdown', iniciarArraste);
    cabecalho.addEventListener('pointermove', moverPainel);
    cabecalho.addEventListener('pointerup', concluirArraste);
    cabecalho.addEventListener('pointercancel', concluirArraste);
    // Redimensionar o quadro ajusta a exibição sem sobrescrever a posição escolhida pelo usuário.
    const aoRedimensionar = () => posicionarPainel(elemento);
    janela.addEventListener('resize', aoRedimensionar);
    removerOuvinteResize = () => janela.removeEventListener('resize', aoRedimensionar);
  }

  /** Coordena a montagem e a restauração do painel quando o ELO substitui seu documento. */
  function montarPainel(quadros) {
    const quadro = selecionarQuadroPainel(quadros);
    if (!quadro || (panel?.isConnected && panel.ownerDocument === quadro.doc)) return;

    // O rascunho atual tem prioridade sobre o título da consulta anterior.
    const campoAnterior = panel?.querySelector('[data-title]');
    const rascunho = campoAnterior ? campoAnterior.value
      : state && !state.clearTitle ? formatarTitulo(state.title) : '';
    const estavaRecolhido = Boolean(panel?.hidden);
    limparRetornoCopia();
    removerBotaoRestaurarPainel();
    removerOuvinteResize?.();
    removerOuvinteResize = null;
    panel?.remove();

    panel = criarPainel(quadro.doc);
    registrarEventosPainel(panel);
    quadro.doc.body.append(panel);
    panel.querySelector('[data-title]').value = rascunho;
    panel.querySelector('[data-status]').textContent = statusText;
    habilitarArrastePainel(panel, quadro.win);

    definirPainelRecolhido(estavaRecolhido);
    atualizarBotoes();
    focarCampoTitulo();
    // O monitor reaplica o foco quando o documento terminar de carregar.
    focusAfterLoad = quadro.doc.readyState === 'complete' ? null : quadro.doc;
  }


  // 8. Monitoramento dos quadros e agendamento

  /** Agenda uma verificação sem duplicar tarefas nem atrasar uma execução já mais próxima. */
  function agendarVerificacao(delay = 0) {
    if (suspended) return;
    const due = Date.now() + delay;
    if (pendingTick !== null) {
      // Um evento de carregamento não deve ficar atrás de uma retentativa atrasada.
      if (due >= pendingTickDue) return;
      window.clearTimeout(pendingTick);
    }
    pendingTickDue = due;
    pendingTick = window.setTimeout(() => {
      pendingTick = null; pendingTickDue = 0; executarCiclo();
    }, delay);
  }

  /** Reconhece alterações do painel e dos avisos para evitar ciclos causados pela própria interface. */
  function alteracaoDoScript(record) {
    const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    return Boolean(element?.closest?.('#' + PANEL + ',[data-elo-ase-popover],[data-elo-ase-restaurar]'));
  }

  /** Desconecta o observador e os eventos de um documento substituído ou encerrado. */
  function removerMonitorDocumento(doc, monitor) {
    monitor.observer?.disconnect();
    doc.removeEventListener('load', monitor.aoCarregarQuadro, true);
    doc.removeEventListener('readystatechange', monitor.aoAlterarCarregamento);
  }

  /** Mantém monitores somente para documentos acessíveis que ainda pertencem à janela. */
  function sincronizarMonitores(views) {
    const currentDocs = new Set(views.map(view => view.doc));
    if (focusAfterLoad && !currentDocs.has(focusAfterLoad)) focusAfterLoad = null;
    // Libera referências a documentos substituídos durante a navegação.
    for (const [doc, monitor] of monitors) {
      if (!currentDocs.has(doc)) { removerMonitorDocumento(doc, monitor); monitors.delete(doc); }
    }
    for (const doc of currentDocs) {
      if (monitors.has(doc)) continue;
      // Eventos leves avisam quando um quadro ou documento precisa ser relido.
      const aoCarregarQuadro = event => {
        if (event.target === doc || /^(I?FRAME)$/.test(event.target?.tagName || '')) agendarVerificacao();
      };
      const aoAlterarCarregamento = () => { if (doc.readyState !== 'loading') agendarVerificacao(); };
      doc.addEventListener('load', aoCarregarQuadro, true);
      doc.addEventListener('readystatechange', aoAlterarCarregamento);
      monitors.set(doc, {aoCarregarQuadro, aoAlterarCarregamento, observer:null});
    }
  }

  /** Ativa temporizador e observadores durante a consulta e os desativa quando a execução termina. */
  function atualizarMonitoramento() {
    const active = !suspended && consultaEmAndamento();
    if (active && timer === null) timer = window.setInterval(() => agendarVerificacao(), 800);
    else if (!active && timer !== null) { window.clearInterval(timer); timer = null; }
    for (const [doc, monitor] of monitors) {
      if (active && !monitor.observer) {
        monitor.observer = new MutationObserver(records => {
          if (records.some(record => !alteracaoDoScript(record))) agendarVerificacao(80);
        });
        monitor.observer.observe(doc.documentElement, {childList:true, subtree:true, attributes:true,
          attributeFilter:['class', 'style', 'disabled', 'aria-disabled', 'onclick']});
      } else if (!active && monitor.observer) {
        monitor.observer.disconnect(); monitor.observer = null;
      }
    }
  }

  /** Libera temporizadores, observadores e referências ao suspender ou sair da página. */
  function encerrarMonitoramento() {
    limparRetornoCopia();
    if (timer !== null) window.clearInterval(timer);
    if (pendingTick !== null) window.clearTimeout(pendingTick);
    timer = null; pendingTick = null; pendingTickDue = 0; focusAfterLoad = null;
    for (const [doc, monitor] of monitors) removerMonitorDocumento(doc, monitor);
    monitors.clear();
  }

  // 9. Consulta: preparação, navegação e conclusão

  /** Informa se existe consulta em andamento, incluindo espera por carregamento. */
  function consultaEmAndamento() {
    return Boolean(state && state.phase !== 'done');
  }

  /** Exige documento carregado e controles disponíveis antes de preencher a consulta. */
  function formularioPronto(view) {
    return Boolean(view?.doc?.readyState === 'complete' && elementoVisivel(view.input) && elementoVisivel(view.consult));
  }

  /** Aguarda o carregamento e as requisições jQuery para evitar interromper o menu do ELO no Firefox. */
  function navegacaoPronta(views) {
    return views.every(view => {
      try {
        // load_menu() continua por AJAX depois do load. Navegar antes pode abortá-lo.
        return view.doc.readyState === 'complete' && !(view.win.jQuery?.active > 0);
      } catch { return false; } // Um quadro em troca de documento será relido.
    });
  }

  /** Decide a próxima ação a partir da etapa e dos quadros atuais, sem clicar ou alterar o estado. */
  function escolherProximaAcao(current, views) {
    if (!current || current.phase === 'done') return null;
    if (current.phase === 'query' && current.direct) return {kind:'direct'};
    if (current.phase === 'query') {
      const view = views.find(formularioPronto);
      return view ? {kind:'query', view} : null;
    }
    if (current.phase === 'history') {
      return views.some(v => v.historyTitle === current.title) ? {kind:'complete'} : null;
    }
    if (current.direct && current.phase === 'detail') {
      // A navegação pode ainda estar pendente. Não usa links do cadastro anterior.
      views = views.filter(view => {
        try {
          const url = new URL(view.doc.location?.href || view.win?.location?.href);
          return url.origin === location.origin && url.pathname === '/sae/jsp/ResConsultaEleitor.jsp'
            && url.searchParams.get('num_inscricao') === current.title;
        } catch { return false; }
      });
    }
    const detail = views.find(v => v.ase?.title === current.title);
    if (detail) return {kind:'ase', node:detail.ase.node};
    if (current.phase === 'detail' && views.some(v => v.noAseTitle === current.title)) {
      return {kind:'noase'};
    }
    if (current.phase === 'results') {
      const result = views.find(v => v.result);
      if (result) return result.result.title === current.title
        ? {kind:'result', node:result.result.node} : {kind:'mismatch'};
    }
    return null;
  }

  /** Captura alertas somente durante a ação fornecida e restaura os alertas originais mesmo se ela falhar. */
  function executarCapturandoAlertas(wins, messages, action) {
    const saved = [];
    for (const win of new Set(wins)) {
      try {
        const original = win.alert;
        win.alert = text => { messages.push(String(text ?? '').replace(/\s+/g, ' ').trim()); };
        saved.push([win, original]);
      } catch { /* quadro inacessível */ }
    }
    try { return action(); }
    finally {
      for (const [win, original] of saved) { try { win.alert = original; } catch { /* ignora */ } }
    }
  }

  /** Abre o cadastro diretamente pelo título e continua a conferência após a navegação. */
  function iniciarConsulta(event) {
    event.preventDefault();
    if (consultaEmAndamento()) return;
    const title = normalizarTitulo(panel.querySelector('[data-title]').value);
    if (!tituloValido(title)) { atualizarBotoes(); focarCampoTitulo(); return; }
    home = validarEnderecoInicial(home) || new URL('/sae/jsp/ConsultaAtendimento.jsp', location.origin).href;
    state = {phase:'query', title, direct:true, updated:Date.now()};
    noResultSince = 0;
    fecharPopover();
    try {
      salvarSessao();
      atualizarMensagemPainel('Abrindo diretamente o cadastro do eleitor…');
      atualizarBotoes();
      atualizarMonitoramento();
      enviarConsultaDireta();
    } catch (error) { informarFalha('Não foi possível abrir o cadastro. Tente novamente.'); }
  }

  /** Aguarda o carregamento interno do ELO antes de navegar, inclusive no Firefox. */
  function enviarConsultaDireta() {
    if (!tituloValido(state?.title)) { informarFalha('Título inválido. Corrija os números para consultar.'); return; }
    if (!navegacaoPronta(coletarQuadros())) {
      atualizarMensagemPainel('Aguardando o ELO concluir o carregamento interno para abrir o cadastro…');
      agendarVerificacao(100);
      return;
    }
    const destino = new URL('/sae/jsp/ResConsultaEleitor.jsp', location.origin);
    destino.searchParams.set('num_inscricao', state.title);
    state.phase = 'detail';
    state.updated = Date.now();
    salvarSessao();
    window.location.assign(destino.href);
  }

  /** Compatibilidade com consultas iniciadas por versões antigas, ainda salvas na sessão. */
  function enviarConsulta(view, title) {
    if (!tituloValido(title)) {
      informarFalha('Título inválido. Corrija os números para consultar.');
      return;
    }
    const views = coletarQuadros();
    if (!formularioPronto(view) || !navegacaoPronta(views)) {
      // O body.onload do ELO inicializa e limpa o formulário. Aguarda antes de preencher.
      const changed = state?.phase !== 'query' || state.title !== title;
      if (changed) {
        state = {phase:'query', title, updated:Date.now()};
      }
      try {
        // O estado já salvo não muda durante as retentativas de carregamento.
        if (changed) salvarSessao();
        atualizarMensagemPainel('Aguardando o ELO concluir o carregamento interno para consultar…');
        atualizarBotoes();
        atualizarMonitoramento();
        agendarVerificacao(100);
      } catch (error) { interromperConsulta('Não foi possível preparar a consulta. ' + error.message); }
      return;
    }
    const otherText = Array.from(view.input.form?.querySelectorAll('input[type="text"]') || [])
      .some(input => input !== view.input && input.value.trim());
    if (otherText) {
      interromperConsulta('Limpe os outros filtros da página antes de consultar apenas pelo título.');
      return;
    }
    home = validarEnderecoInicial(location.href);
    state = {phase:'results', title, updated:Date.now()};
    noResultSince = 0;
    try {
      salvarSessao();
      view.input.focus();
      const setter = Object.getOwnPropertyDescriptor(view.win.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(view.input, title);
      else view.input.value = title;
      // O ELO avisa título inválido com alert(). Captura a mensagem para tratá-la aqui.
      const alerts = [];
      const wins = views.map(item => item.win);
      executarCapturandoAlertas(wins, alerts, () => {
        view.input.dispatchEvent(new view.win.Event('input', {bubbles:true}));
        // Não simula teclas: rotinas legadas podem exigir dados que Event não possui.
        view.input.dispatchEvent(new view.win.Event('change', {bubbles:true}));
        view.input.blur(); // Executa o onblur nativo do ELO antes da consulta.
      });
      if (alerts.length) { tratarConsultaRecusada(title, alerts); return; }
      // A validação nativa pode cancelar ou corrigir a inscrição.
      if (view.input.value.replace(/\D/g, '') !== title) {
        throw new Error('O ELO alterou ou limpou o título digitado. Confira os números e tente novamente.');
      }
      const inscription = view.input.form?.querySelector('input[name="num_inscricao"]');
      const cpf = view.input.form?.querySelector('input[name="num_cpf"]');
      if (!inscription || !cpf) {
        throw new Error('O formulário do ELO não disponibilizou os campos de Inscrição/CPF. Reabra a consulta.');
      }
      // Estes são os parâmetros do formulário que selecionam a pesquisa por título.
      // Não depende de o onblur sintético atualizar os campos internos do ELO.
      inscription.value = title;
      cpf.value = '';
      atualizarMensagemPainel('Consultando inscrição. Aguardando o resultado…');
      atualizarBotoes();
      if (!elementoVisivel(view.consult) || !elementoVisivel(view.input)) throw new Error('O formulário mudou. Tente novamente.');
      fecharPopover();
      atualizarMonitoramento();
      executarCapturandoAlertas(wins, alerts, () => view.consult.click());
      if (alerts.length) { tratarConsultaRecusada(title, alerts); return; }
      agendarVerificacao();
    } catch (error) { interromperConsulta('Consulta interrompida. ' + error.message); }
  }

  /** Apresenta o motivo da recusa e seleciona o título para facilitar sua correção. */
  function tratarConsultaRecusada(title, alerts) {
    const reason = alerts.filter(Boolean).join(' ') || 'motivo não informado.';
    const message = `O ELO recusou o título ${formatarTitulo(title)}: ${reason}`;
    interromperConsulta(message, 'error', `O ELO recusou o título ${formatarTitulo(title)}. Corrija o título e consulte novamente.`);
    definirPainelRecolhido(false);
    exibirPopover(message + '\nCorrija o título e consulte novamente.', panel?.ownerDocument, 'error');
    focarCampoTitulo(true);
  }

  /** Interrompe a execução e navega para a tela inicial previamente validada. */
  function voltarConsultaInicial() {
    if (!home) { atualizarMensagemPainel('Abra a tela inicial de consulta para registrar o retorno.'); return; }
    const destination = validarEnderecoInicial(home);
    if (!destination) { interromperConsulta('Endereço de retorno inválido.'); return; }
    interromperConsulta('Voltando à consulta inicial…');
    window.location.assign(destination);
  }

  /** Interrompe a automação e mantém o painel disponível para correção ou nova consulta. */
  function interromperConsulta(message, tone = 'neutral', mensagemParaSessao = message) {
    fecharPopover();
    state = null;
    noResultSince = 0;
    atualizarMonitoramento();
    atualizarMensagemPainel(message, tone);
    if (tone === 'error') falhaSalva = {message:mensagemParaSessao, updated:Date.now()};
    try { salvarSessao(); } catch { /* Ainda permite parar se o armazenamento estiver indisponível. */ }
    atualizarBotoes();
  }

  /** Conclui e salva a consulta. Recebe separadamente o texto sem nome que pode ficar na sessão. */
  function concluirConsulta(message, noAse = false, storedMessage = message, tone = 'neutral') {
    state.phase = 'done';
    state.message = storedMessage;
    state.tone = tone;
    state.updated = Date.now();
    salvarSessao();
    atualizarMensagemPainel(message, tone);
    if (noAse) {
      definirPainelRecolhido(false);
      exibirPopover(message, panel?.ownerDocument, 'success');
    }
    atualizarBotoes();
  }

  /** Interrompe com aviso de erro e devolve o foco ao campo para correção. */
  function informarFalha(message) {
    interromperConsulta(message, 'error');
    definirPainelRecolhido(false);
    exibirPopover(message, panel?.ownerDocument, 'error');
    focarCampoTitulo(true);
  }

  // 10. Conferência de ASE 094 e ASE 167 por turno

  /** Confere o histórico uma vez por documento/título. Retorna true, false ou "waiting" enquanto aguarda a tabela. */
  function conferirHistorico(views) {
    // Retorna true quando relatou o histórico, 'waiting' quando aguarda a tabela e false quando não havia o que fazer.
    const history = views.find(view => view.doc && view.historyTitle
      && (!consultaEmAndamento() || (state.phase === 'history' && state.title === view.historyTitle)));
    const chaveHistorico = history ? `${history.historyTitle}|${chaveContextoEleitoral()}` : '';
    // O cache evita avisos repetidos em repouso, mas não substitui uma nova consulta.
    if (!history || (!consultaEmAndamento() && checkedHistories.get(history.doc) === chaveHistorico)) return false;
    // Compartilha a seleção de linhas apenas neste ciclo, sem manter documentos em cache forte.
    const rows = Array.from(history.doc.querySelectorAll('tr'));
    const found = lerAsesPorTurno(history.doc, CONFIG.aseCode, '', rows);
    if (!found) {
      // O documento já terminou de carregar. Só aguarda se a tabela ainda não existe.
      let waiting = historyWaits.get(history.doc);
      if (!waiting || waiting.context !== chaveHistorico) {
        waiting = {context:chaveHistorico, since:Date.now()};
        historyWaits.set(history.doc, waiting);
      }
      if (Date.now() - waiting.since < CONFIG.historyRetryMs) {
        atualizarMensagemPainel('Lendo o histórico ASE…');
        return 'waiting';
      }
    }
    const absenceFound = lerAsesPorTurno(history.doc, CONFIG.absenceAseCode, ['ATIVO', 'INATIVO', 'FACULTADO'], rows);
    const ausenciasParaOrientacao = lerAsesPorTurno(history.doc, CONFIG.absenceAseCode, CONFIG.absenceGuidanceStatuses, rows);
    const message = montarRelatorioTurnos(history.historyTitle, found, obterNomeEleitor(history.doc, history.historyTitle), absenceFound, ausenciasParaOrientacao);
    // Só orienta o lançamento condicional se houver 094 ATIVO ou FACULTADO sem 167 na mesma data.
    const pending = Boolean(found && ausenciasParaOrientacao?.some((absence, index) => absence && !found[index]));
    const tone = found?.every(Boolean) ? 'success'
      : !found || !absenceFound || !ausenciasParaOrientacao ? 'warning' : pending ? 'pending' : 'success';
    const input = panel?.querySelector('[data-title]');
    // Só considera ausência confirmada quando a leitura dos turnos selecionados foi possível.
    const noAbsence = Boolean(absenceFound && !absenceFound.some(Boolean));
    // Preserva outro título que já esteja sendo preparado para a próxima consulta.
    const clearInput = (Boolean(found?.some(Boolean)) || noAbsence) && (!input || !input.value.trim()
      || normalizarTitulo(input.value) === history.historyTitle);
    const saveCleared = clearInput && state?.title === history.historyTitle && !state.clearTitle;
    if (saveCleared) state.clearTitle = true;
    // O nome do eleitor aparece só na tela; o que fica salvo na sessão não o contém.
    if (consultaEmAndamento()) concluirConsulta(message, false, montarRelatorioTurnos(history.historyTitle, found, '', absenceFound, ausenciasParaOrientacao), tone);
    else {
      atualizarMensagemPainel(message, tone);
      if (saveCleared) salvarSessao();
    }
    exibirPopover(message, history.doc, tone);
    // Marca a leitura após concluir a atualização do aviso.
    checkedHistories.set(history.doc, chaveHistorico);
    historyWaits.delete(history.doc);
    if (clearInput) {
      if (input) input.value = '';
      atualizarBotoes();
      definirPainelRecolhido(false);
      focarCampoTitulo();
    }
    return true;
  }

  // 11. Espera, mensagens sem resultado e limites por etapa

  /** Busca a mensagem de consulta sem resultado, ignorando o painel e os popovers do script. */
  function possuiMensagemSemResultado(doc) {
    if (doc.readyState !== 'complete') return false;
    // Evita confundir mensagens do painel, alertas antigos ou textos de outros campos.
    return Array.from(doc.querySelectorAll('td,p,div,span,[role="alert"]')).some(node => {
      if (node.closest('#' + PANEL + ',[data-elo-ase-popover],[data-elo-ase-restaurar]')) return false;
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      // Consulta estilos e dimensões apenas quando o texto pode ser a mensagem esperada.
      return CONFIG.noResultPattern.test(text) && elementoVisivel(node);
    });
  }

  /** Trata a espera e exige persistência da mensagem sem resultado antes de concluir uma falha. */
  function verificarEspera(views) {
    if (verificarPrazoEtapa()) return;
    if (state.phase === 'results' || (state.direct && state.phase === 'detail')) {
      if (views.some(view => possuiMensagemSemResultado(view.doc))) {
        // Exige que o aviso persista, para não confundir com a tela ainda carregando.
        noResultSince = noResultSince || Date.now();
        if (Date.now() - noResultSince >= CONFIG.noResultDelayMs) {
          informarFalha(`O ELO não retornou nenhum eleitor para o título ${formatarTitulo(state.title)}. Confira o número digitado.`);
        }
        return;
      }
      noResultSince = 0;
    }
  }

  /** Interrompe etapas que ultrapassaram o prazo específico e informa o motivo correspondente. */
  function verificarPrazoEtapa() {
    if (!consultaEmAndamento() || Date.now() - state.updated <= CONFIG.stepTimeoutMs) return false;
    informarFalha(TIMEOUT_MESSAGES[state.phase] || 'Tempo esgotado. Confira as mensagens do ELO e tente novamente.');
    return true;
  }

  // 12. Ciclo de execução e inicialização

  /** Executa um ciclo da automação com proteção contra reentrada e nova leitura antes de cada clique. */
  function executarCiclo() {
    if (suspended || running) return;
    running = true;
    try {
      const views = coletarQuadros();
      sincronizarMonitores(views);
      if (!home && (views.some(v => v.input)
        || new URL(location.href).searchParams.get('url') === '/sae/jsp/ConsultaAtendimento.jsp')) {
        home = validarEnderecoInicial(location.href);
        try { salvarSessao(); } catch { atualizarMensagemPainel('O navegador precisa permitir armazenamento da sessão para a automação.'); }
      }
      montarPainel(views);
      // O ajuste visual do ELO nunca deve impedir a montagem ou a automação.
      for (const view of views) {
        if (!view.historyTitle) continue;
        try { corrigirBotaoVoltarHistorico(view.doc); }
        catch (error) { console.warn('[ELO ASE] Não foi possível ajustar a posição do botão Voltar.', error); }
      }
      if (focusAfterLoad?.readyState === 'complete' && panel?.ownerDocument === focusAfterLoad) {
        focarCampoTitulo(); focusAfterLoad = null;
      }
      if (!consultaEmAndamento()) {
        if (conferirHistorico(views) === 'waiting') agendarVerificacao(300);
        return;
      }
      if (!estadoValido(state)) { interromperConsulta('Tempo esgotado. Confira as mensagens do ELO e tente novamente.'); return; }
      if (verificarPrazoEtapa()) return;
      const action = escolherProximaAcao(state, views);
      if (!action) { verificarEspera(views); return; }
      if (action.kind === 'direct') { enviarConsultaDireta(); return; }
      if (action.kind === 'query') {
        enviarConsulta(action.view, state.title);
        return;
      }
      if (action.kind === 'mismatch') {
        interromperConsulta('O primeiro resultado tem inscrição diferente. Automação interrompida para conferência.');
        return;
      }
      if (action.kind === 'complete') {
        const outcome = conferirHistorico(views);
        if (outcome === 'waiting') { agendarVerificacao(300); return; }
        if (!outcome) concluirConsulta('Histórico ASE carregado. Use o botão acima para voltar.');
        return;
      }
      if (action.kind === 'noase') {
        const empty = CONFIG.turns.map(() => false);
        const detail = views.find(view => view.noAseTitle === state.title);
        const name = detail ? obterNomeEleitor(detail.doc, state.title) : '';
        const input = panel?.querySelector('[data-title]');
        const clearInput = !input || !input.value.trim() || normalizarTitulo(input.value) === state.title;
        if (clearInput) state.clearTitle = true;
        concluirConsulta(montarRelatorioTurnos(state.title, empty, name, empty, empty), true,
          montarRelatorioTurnos(state.title, empty, '', empty, empty), 'success');
        if (clearInput) limparCampoTitulo();
        return;
      }
      // Busca um elemento atual e valida de novo antes de acionar o evento nativo.
      const freshViews = coletarQuadros();
      if (!navegacaoPronta(freshViews)) {
        atualizarMensagemPainel('Aguardando o ELO concluir o carregamento interno antes de avançar…');
        agendarVerificacao(100);
        return;
      }
      const fresh = escolherProximaAcao(state, freshViews);
      if (!fresh || fresh.kind !== action.kind || !elementoVisivel(fresh.node)) return;
      state.phase = action.kind === 'result' ? 'detail' : 'history';
      state.updated = Date.now();
      salvarSessao();
      atualizarMensagemPainel(action.kind === 'result' ? 'Abrindo o primeiro resultado. Aguardando o link ASE…'
        : 'Abertura do histórico ASE solicitada. Use o botão acima para voltar.');
      atualizarBotoes();
      fresh.node.click();
      agendarVerificacao();
    } catch (error) {
      console.warn('[ELO ASE] Erro inesperado.', error);
      const detail = (typeof error === 'string' ? error
        : typeof error?.message === 'string' ? error.message : '').trim() || 'motivo não informado';
      interromperConsulta(`Automação interrompida por erro inesperado: ${detail}\nConfira o console (F12) para mais detalhes ou tente novamente.`,
        'error', 'Automação interrompida por erro inesperado. Confira o console (F12) ou tente novamente.');
    }
    finally { running = false; atualizarMonitoramento(); }
  }

  /** Restaura a sessão, executa o primeiro ciclo e trata saída e retorno pelo histórico do navegador. */
  function inicializar() {
    restaurarSessao();
    // Sem posição na sessão (aba nova), usa a última posição escolhida pelo usuário.
    if (!Number.isFinite(savedPosition?.x) || !Number.isFinite(savedPosition?.y)) savedPosition = lerPosicaoPersistida();
    if (state) {
      statusText = state.phase === 'done' ? (state.message || 'Use Voltar à consulta inicial para uma nova pesquisa.')
        : 'Continuando a consulta. Aguardando a página carregar…';
      statusTone = state.phase === 'done' && Object.hasOwn(TONS_STATUS, state.tone) ? state.tone : 'neutral';
    } else if (falhaSalva) {
      statusText = falhaSalva.message;
      statusTone = 'error';
    }
    executarCiclo();
    window.addEventListener('pagehide', () => { suspended = true; encerrarMonitoramento(); fecharPopover(); });
    window.addEventListener('pageshow', e => { if (e.persisted) { suspended = false; executarCiclo(); focarCampoTitulo(); } });
  }

  inicializar();
})();
