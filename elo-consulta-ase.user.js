// ==UserScript==
// @name         ELO | Consulta rápida do histórico ASE
// @namespace    https://cad-elo.tse.jus.br/
// @version      1.5.19
// @description  Consulta uma inscrição, abre o primeiro resultado e o histórico ASE, com painel flutuante e retorno à consulta inicial.
// @match        https://cad-elo.tse.jus.br/sae/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';
  // Um controlador por janela. Os quadros são acompanhados pelo controlador superior.
  try { if (window.top !== window.self && window.top.location.origin === location.origin) return; }
  catch { return; }

  const KEY = 'elo.consultaASE.v1';
  const PANEL = 'elo-consulta-ase-painel';
  const LIMIT = 120000;
  // Ajuste aqui a cada eleição: código do ASE e datas dos turnos.
  const CONFIG = Object.freeze({
    aseCode: '167',
    absenceAseCode: '094',
    turns: Object.freeze([
      Object.freeze({label:'1º turno', date:'04/10/2026'}),
      Object.freeze({label:'2º turno', date:'25/10/2026'})
    ]),
    stepTimeoutMs: 45000,  // espera máxima em cada etapa (consulta, resultado, detalhe, histórico)
    historyRetryMs: 4000,  // tempo para a tabela do histórico aparecer antes de acusar falha
    noResultDelayMs: 1500, // o aviso de "sem resultado" precisa persistir por esse tempo
    // Padrão conservador. Ajuste se a mensagem real do ELO tiver outra redação.
    noResultPattern: /^(?:nenhum (?:registro|eleitor|resultado)(?: foi)? (?:encontrado|localizado)|n[ãa]o (?:foi encontrado|foi localizado) nenhum (?:registro|eleitor|resultado))[.!]?$/i
  });
  const checkedHistories = new WeakMap();
  const historyWaits = new WeakMap();
  let state = null;
  let home = null;
  let panel = null;
  let statusText = 'Informe o título e clique em Consultar ASE.';
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

  function normalizeTitle(value) {
    const raw = String(value ?? '').trim();
    if (!/^[\d\s.\-]+$/.test(raw)) return null;
    const digits = raw.replace(/\D/g, '');
    return /^\d{12}$/.test(digits) ? digits : null;
  }

  function formatTitle(value) {
    // Preserva dígitos excedentes para que a validação recuse o número inteiro.
    return String(value ?? '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
  }

  function isValidTitle(value) {
    const title = normalizeTitle(value);
    if (!title || /^(\d)\1{11}$/.test(title)) return false;
    const uf = Number(title.slice(8, 10));
    if (uf < 1 || uf > 28) return false;
    const digits = Array.from(title, Number);
    // Módulo 11: pesos 2 a 9 no sequencial e 7, 8, 9 no código de UF + DV.
    // SP e MG usam 1 quando o resto original é zero; resto 10 resulta em zero.
    const checkDigit = sum => {
      const remainder = sum % 11;
      return remainder === 10 ? 0 : remainder === 0 && uf <= 2 ? 1 : remainder;
    };
    const first = checkDigit(digits.slice(0, 8).reduce((sum, digit, index) => sum + digit * (index + 2), 0));
    const second = checkDigit(digits[8] * 7 + digits[9] * 8 + first * 9);
    return digits[10] === first && digits[11] === second;
  }

  function formatTitleInput(event) {
    const input = event.currentTarget;
    const position = input.selectionStart ?? input.value.length;
    const digitsBefore = input.value.slice(0, position).replace(/\D/g, '').length;
    const formatted = formatTitle(input.value);
    let caret = 0;
    let digits = 0;
    while (caret < formatted.length && digits < digitsBefore) {
      if (/\d/.test(formatted[caret])) digits++;
      caret++;
    }
    if (event.inputType === 'deleteContentForward' && formatted[caret] === ' ') caret++;
    input.value = formatted;
    input.setSelectionRange(caret, caret);
    updateButtons();
  }

  function validState(value) {
    return Boolean(value && ['query', 'results', 'detail', 'history', 'done'].includes(value.phase)
      && /^\d{12}$/.test(value.title) && Number.isFinite(value.updated)
      && Date.now() - value.updated >= 0 && Date.now() - value.updated < LIMIT);
  }

  function safeHome(value) {
    try {
      const url = new URL(value, location.origin);
      return url.origin === location.origin && url.pathname.startsWith('/sae/') ? url.href : null;
    } catch { return null; }
  }

  function store() {
    // Salva a próxima etapa ANTES de um clique que possa trocar de página.
    window.sessionStorage.setItem(KEY, JSON.stringify({state, home, position:savedPosition}));
  }

  function restore() {
    try {
      const saved = JSON.parse(window.sessionStorage.getItem(KEY) || 'null');
      if (!saved) return;
      home = safeHome(saved.home);
      savedPosition = saved.position;
      if (validState(saved.state)) state = saved.state;
      else if (saved.state) statusText = 'Consulta anterior expirada. Inicie uma nova consulta.';
    } catch { statusText = 'Não foi possível recuperar a consulta anterior.'; }
  }

  function visible(node) {
    if (!node?.isConnected || node.disabled || node.getAttribute('aria-disabled') === 'true'
      || node.classList?.contains('ui-state-disabled')) return false;
    const win = node.ownerDocument?.defaultView;
    if (!win) return false;
    const style = win.getComputedStyle(node);
    return style.display !== 'none' && style.visibility !== 'hidden'
      && style.visibility !== 'collapse' && node.getClientRects().length > 0;
  }

  function electorTitle(cells) {
    const label = cells.find(cell => /^Inscrição:\s*$/i.test(cell.textContent.trim()));
    return normalizeTitle(label?.nextElementSibling?.textContent);
  }

  function callTitle(link, argumentIndex) {
    const args = (link.getAttribute('onclick') || '').match(/\(\s*['"](\d+)['"](?:\s*,\s*['"]([^'"]*)['"])?/);
    return normalizeTitle(args?.[argumentIndex + 1]);
  }

  function missingAseTitle(doc, aseLinks) {
    // O ELO omite o link ASE quando o eleitor não possui esses registros.
    // Só conclui ausência depois do carregamento completo dos detalhes.
    if (doc.readyState !== 'complete' || aseLinks.length) return null;
    const cells = Array.from(doc.querySelectorAll('td'));
    const history = cells.some(cell => /^Histórico:\s*$/i.test(cell.textContent.trim()));
    return history ? electorTitle(cells) : null;
  }

  function loadedHistoryTitle(doc) {
    if (doc.readyState !== 'complete') return null;
    // Pré-filtro barato: innerText força cálculo de layout, então só é lido se o texto parece estar na página.
    if (!/Hist\S{0,3}rico\s*ASE/i.test(doc.body?.textContent || '')) return null;
    if (!/^\s*Histórico\s+ASE\s*$/im.test(doc.body?.innerText || '')) return null;
    return electorTitle(Array.from(doc.querySelectorAll('td')));
  }

  function readTurnASEs(doc, code = CONFIG.aseCode, requiredStatus = '') {
    // Cada código e data precisam estar na mesma linha da tabela de histórico.
    const rows = Array.from(doc.querySelectorAll('tr'));
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

  function electorName(doc, title) {
    // Usa a linha de identificação do mesmo título, sem confundir outros <font> da página.
    for (const row of doc.querySelectorAll('tr')) {
      const cells = Array.from(row.cells);
      if (electorTitle(cells) !== title) continue;
      const label = cells.find(cell => /^Nome:\s*$/i.test(cell.textContent.trim()));
      const name = label?.nextElementSibling?.textContent.replace(/\s+/g, ' ').trim();
      if (name) return name;
    }
    return '';
  }

  function absenceReport(found) {
    if (!found) return `Não foi possível conferir o ASE ${CONFIG.absenceAseCode}. Confira manualmente a situação dos registros no ELO.`;
    return CONFIG.turns.filter((_, index) => !found[index])
      .map(turn => `O eleitor não teve ausência registrada no ${turn.label} (${turn.date}).`).join('\n');
  }

  function turnReport(title, found, name = '', absenceFound) {
    const heading = `ELEITOR: ${name}\nTÍTULO: ${formatTitle(title)}`;
    const absence = absenceFound === undefined ? '' : absenceReport(absenceFound);
    if (!found) {
      return heading + '\nNão foi possível identificar a tabela do histórico ASE. Confira manualmente os registros dos turnos.'
        + (absence ? `\n${absence}` : '');
    }
    const sections = CONFIG.turns.map((turn, index) => {
      const label = turn.label.replace(/turno/gi, 'Turno');
      const lines = [];
      if (absenceFound?.[index]) {
        lines.push(`ASE ${CONFIG.absenceAseCode} encontrado em: ${label} (${turn.date}).`);
      }
      if (found[index]) {
        lines.push(`ASE ${CONFIG.aseCode} registrado para o ${label}.`);
      } else if (absenceFound?.[index]) {
        lines.push(`ASE ${CONFIG.aseCode} não encontrado para o ${label} (${turn.date}).`);
        lines.push(`Registre o ASE ${CONFIG.aseCode} para o ${label}.`);
      } else if (!absenceFound) {
        lines.push(`ASE ${CONFIG.aseCode} não encontrado para o ${label} (${turn.date}).`);
      }
      return lines.join('\n');
    });
    if (absence) sections.push(absence);
    return heading + '\n' + sections.filter(Boolean).join('\n\n');
  }

  function verifyHistory(views) {
    // Retorna true quando relatou o histórico, 'waiting' quando aguarda a tabela e false quando não havia o que fazer.
    const history = views.find(view => view.doc && view.historyTitle
      && (!busy() || (state.phase === 'history' && state.title === view.historyTitle)));
    // O cache evita avisos repetidos em repouso, mas não substitui uma nova consulta.
    if (!history || (!busy() && checkedHistories.get(history.doc) === history.historyTitle)) return false;
    const found = readTurnASEs(history.doc);
    if (!found) {
      // O documento já terminou de carregar. Só aguarda se a tabela ainda não existe.
      let waiting = historyWaits.get(history.doc);
      if (!waiting || waiting.title !== history.historyTitle) {
        waiting = {title:history.historyTitle, since:Date.now()};
        historyWaits.set(history.doc, waiting);
      }
      if (Date.now() - waiting.since < CONFIG.historyRetryMs) {
        setStatus('Lendo o histórico ASE…');
        return 'waiting';
      }
    }
    const absenceFound = readTurnASEs(history.doc, CONFIG.absenceAseCode, ['ATIVO', 'INATIVO']);
    const message = turnReport(history.historyTitle, found, electorName(history.doc, history.historyTitle), absenceFound);
    // Uma pendência exige 094 ATIVO/INATIVO e ausência de 167 na mesma data.
    const pending = Boolean(found && absenceFound?.some((absence, index) => absence && !found[index]));
    const tone = !found || !absenceFound ? 'warning' : pending ? 'pending' : 'success';
    const input = panel?.querySelector('[data-title]');
    // Preserva outro título que já esteja sendo preparado para a próxima consulta.
    const clearInput = Boolean(found?.some(Boolean)) && (!input || !input.value.trim()
      || normalizeTitle(input.value) === history.historyTitle);
    const saveCleared = clearInput && state?.title === history.historyTitle && !state.clearTitle;
    if (saveCleared) state.clearTitle = true;
    // O nome do eleitor aparece só na tela; o que fica salvo na sessão não o contém.
    if (busy()) finish(message, false, turnReport(history.historyTitle, found, '', absenceFound));
    else {
      setStatus(message);
      if (saveCleared) store();
    }
    showPopover(message, history.doc, 10000, tone);
    // Marca a leitura após concluir a atualização do aviso.
    checkedHistories.set(history.doc, history.historyTitle);
    historyWaits.delete(history.doc);
    if (clearInput) {
      if (input) input.value = '';
      updateButtons();
      setCollapsed(false);
      focusTitleInput();
    }
    return true;
  }

  function busy() {
    return Boolean(state && state.phase !== 'done');
  }

  function scheduleTick(delay = 0) {
    if (suspended) return;
    const due = Date.now() + delay;
    if (pendingTick !== null) {
      // Um evento de carregamento não deve ficar atrás de uma retentativa atrasada.
      if (due >= pendingTickDue) return;
      window.clearTimeout(pendingTick);
    }
    pendingTickDue = due;
    pendingTick = window.setTimeout(() => {
      pendingTick = null; pendingTickDue = 0; tick();
    }, delay);
  }

  function ownMutation(record) {
    const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    return Boolean(element?.closest?.('#' + PANEL + ',[data-elo-ase-popover]'));
  }

  function detachMonitor(doc, monitor) {
    monitor.observer?.disconnect();
    doc.removeEventListener('load', monitor.onLoad, true);
    doc.removeEventListener('readystatechange', monitor.onReady);
  }

  function syncMonitoring(views) {
    const currentDocs = new Set(views.map(view => view.doc));
    if (focusAfterLoad && !currentDocs.has(focusAfterLoad)) focusAfterLoad = null;
    // Libera referências a documentos substituídos durante a navegação.
    for (const [doc, monitor] of monitors) {
      if (!currentDocs.has(doc)) { detachMonitor(doc, monitor); monitors.delete(doc); }
    }
    for (const doc of currentDocs) {
      if (monitors.has(doc)) continue;
      const onLoad = event => {
        if (event.target === doc || /^(I?FRAME)$/.test(event.target?.tagName || '')) scheduleTick();
      };
      const onReady = () => { if (doc.readyState !== 'loading') scheduleTick(); };
      doc.addEventListener('load', onLoad, true);
      doc.addEventListener('readystatechange', onReady);
      monitors.set(doc, {onLoad, onReady, observer:null});
    }
  }

  function refreshActivity() {
    const active = !suspended && busy();
    if (active && timer === null) timer = window.setInterval(() => scheduleTick(), 800);
    else if (!active && timer !== null) { window.clearInterval(timer); timer = null; }
    for (const [doc, monitor] of monitors) {
      if (active && !monitor.observer) {
        monitor.observer = new MutationObserver(records => {
          if (records.some(record => !ownMutation(record))) scheduleTick(80);
        });
        monitor.observer.observe(doc.documentElement, {childList:true, subtree:true, attributes:true,
          attributeFilter:['class', 'style', 'disabled', 'aria-disabled', 'onclick']});
      } else if (!active && monitor.observer) {
        monitor.observer.disconnect(); monitor.observer = null;
      }
    }
  }

  function cleanupMonitoring() {
    if (timer !== null) window.clearInterval(timer);
    if (pendingTick !== null) window.clearTimeout(pendingTick);
    timer = null; pendingTick = null; pendingTickDue = 0; focusAfterLoad = null;
    for (const [doc, monitor] of monitors) detachMonitor(doc, monitor);
    monitors.clear();
  }

  function fixHistoryBackButton(doc) {
    if (!doc.querySelector('a[name="btn_voltar"] img[name="img_btn_voltar"]')
      || doc.querySelector('style[data-elo-ase-back-fix]')) return;
    // A tabela do ELO usa position:absolute e z-index:2, cobrindo o botão nativo.
    const style = doc.createElement('style');
    style.setAttribute('data-elo-ase-back-fix', '');
    style.textContent = 'a[name="btn_voltar"] img[name="img_btn_voltar"] { position:relative; z-index:3; }';
    (doc.head || doc.documentElement).append(style);
  }

  function collect() {
    const views = [];
    function visit(win, depth) {
      if (depth > 6) return;
      let doc;
      try {
        doc = win.document;
        if (!doc.documentElement) return;
      } catch { return; } // O acesso a quadros de outra origem pode ser recusado.
      const links = Array.from(doc.querySelectorAll('a[onclick]'));
      const firstResult = links.find(a => /^\s*consEleitor\s*\(/.test(a.getAttribute('onclick') || '') && visible(a));
      const aseLinks = links.filter(a => /^\s*ConsultaHistoricoFase\s*\(/.test(a.getAttribute('onclick') || ''));
      // Verifica a existência de ASE antes de filtrar links disponíveis para clique.
      const ase = aseLinks.find(a => (!state || callTitle(a, 1) === state.title) && visible(a));
      const historyTitle = loadedHistoryTitle(doc);
      views.push({win, doc, input:doc.querySelector('#num_inscricao_cpf'),
        consult:doc.querySelector('input[name="btn_consultar"]'),
        result:firstResult ? {node:firstResult, title:callTitle(firstResult, 0)} : null,
        ase:ase ? {node:ase, title:callTitle(ase, 1)} : null,
        noAseTitle:state?.phase === 'detail' ? missingAseTitle(doc, aseLinks) : null,
        historyTitle});
      for (const frame of doc.querySelectorAll('frame,iframe')) {
        if (frame.contentWindow) visit(frame.contentWindow, depth + 1);
      }
    }
    visit(window, 0);
    return views;
  }

  function queryReady(view) {
    return Boolean(view?.doc?.readyState === 'complete' && visible(view.input) && visible(view.consult));
  }

  function navigationReady(views) {
    return views.every(view => {
      try {
        // load_menu() continua por AJAX depois do load. Navegar antes pode abortá-lo.
        return view.doc.readyState === 'complete' && !(view.win.jQuery?.active > 0);
      } catch { return false; } // Um quadro em troca de documento será relido.
    });
  }

  function chooseAction(current, views) {
    if (!current || current.phase === 'done') return null;
    if (current.phase === 'query') {
      const view = views.find(queryReady);
      return view ? {kind:'query', view} : null;
    }
    if (current.phase === 'history') {
      return views.some(v => v.historyTitle === current.title) ? {kind:'complete'} : null;
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

  function setStatus(text) {
    statusText = text;
    const status = panel?.querySelector('[data-status]');
    if (status && status.textContent !== text) status.textContent = text;
  }

  function clearPopover() {
    if (popoverTimer !== null) window.clearTimeout(popoverTimer);
    popoverTimer = null;
    popover?.remove();
    popover = null;
  }

  function showPopover(message, doc, duration = 3000, tone = 'warning') {
    clearPopover();
    if (doc?.body?.tagName !== 'BODY') return;
    popover = doc.createElement('div');
    popover.setAttribute('role', 'alert');
    popover.setAttribute('data-elo-ase-popover', '');
    popover.style.cssText = 'position:fixed;inset:auto;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;box-sizing:border-box;width:max-content;min-width:min(520px,calc(100vw - 32px));max-width:calc(100vw - 32px);padding:24px 28px;border:2px solid #c58a14;border-radius:12px;background:#fff8e6;color:#593b00;box-shadow:0 10px 40px #0004;font:600 18px/1.5 Arial,sans-serif;text-align:center;z-index:2147483647;pointer-events:none;overflow-wrap:anywhere';
    popover.style.whiteSpace = 'pre-line';
    if (tone === 'success') {
      popover.style.background = '#edf9f0'; popover.style.borderColor = '#278046'; popover.style.color = '#14562b';
    } else if (tone === 'pending') {
      popover.style.background = '#fff0df'; popover.style.borderColor = '#d96b00'; popover.style.color = '#7a3500';
    } else if (tone === 'error') {
      popover.style.background = '#fdecec'; popover.style.borderColor = '#b3261e'; popover.style.color = '#6b130e';
    }
    popover.textContent = message;
    doc.body.append(popover);
    // A camada superior mantém o aviso à frente do painel, quando disponível.
    if (typeof popover.showPopover === 'function') {
      popover.setAttribute('popover', 'manual');
      try { popover.showPopover(); }
      catch { popover.removeAttribute('popover'); }
    }
    popoverTimer = window.setTimeout(clearPopover, duration);
  }

  function stop(message) {
    clearPopover();
    state = null;
    noResultSince = 0;
    refreshActivity();
    try { store(); } catch { /* Ainda permite parar se o armazenamento estiver indisponível. */ }
    setStatus(message);
    updateButtons();
  }

  function updateButtons() {
    if (!panel) return;
    const active = busy();
    const input = panel.querySelector('[data-title]');
    const valid = isValidTitle(input.value);
    const length = input.value.replace(/\D/g, '').length;
    const invalid = length >= 12 && !valid;
    const feedback = panel.querySelector('[data-title-feedback]');
    const message = !length ? 'Digite os 12 dígitos do título.'
      : length < 12 ? `Complete o título: faltam ${12 - length} dígito(s).`
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
    submit.style.opacity = submit.disabled ? '0.55' : '1';
    submit.style.cursor = submit.disabled ? 'not-allowed' : 'pointer';
    panel.querySelector('[data-cancel]').disabled = !active;
    panel.querySelector('[data-return]').disabled = !home;
  }

  function start(event) {
    event.preventDefault();
    if (busy()) return;
    const title = normalizeTitle(panel.querySelector('[data-title]').value);
    if (!isValidTitle(title)) { updateButtons(); focusTitleInput(); return; }
    const view = collect().find(v => visible(v.input) && visible(v.consult));
    if (view) { submitQuery(view, title); return; }
    const destination = safeHome(home);
    if (!destination) { setStatus('Abra uma vez a tela inicial de consulta para registrar o retorno automático.'); return; }
    // Preserva o título antes de recarregar a tela inicial, sem clicar no histórico antigo.
    state = {phase:'query', title, updated:Date.now()};
    try {
      store();
      clearPopover();
      setStatus('Abrindo a consulta inicial. A nova pesquisa continuará automaticamente…');
      updateButtons();
      refreshActivity();
      window.location.assign(destination);
    } catch (error) { stop('Não foi possível iniciar a nova consulta. ' + error.message); }
  }

  function submitQuery(view, title) {
    if (!isValidTitle(title)) {
      failWith('Título inválido. Corrija os números para consultar.');
      return;
    }
    const views = collect();
    if (!queryReady(view) || !navigationReady(views)) {
      // O body.onload do ELO inicializa e limpa o formulário. Aguarda antes de preencher.
      const changed = state?.phase !== 'query' || state.title !== title;
      if (changed) {
        state = {phase:'query', title, updated:Date.now()};
      }
      try {
        // O estado já salvo não muda durante as retentativas de carregamento.
        if (changed) store();
        setStatus('Aguardando o ELO concluir o carregamento interno para consultar…');
        updateButtons();
        refreshActivity();
        scheduleTick(100);
      } catch (error) { stop('Não foi possível preparar a consulta. ' + error.message); }
      return;
    }
    const otherText = Array.from(view.input.form?.querySelectorAll('input[type="text"]') || [])
      .some(input => input !== view.input && input.value.trim());
    if (otherText) {
      stop('Limpe os outros filtros da página antes de consultar apenas pelo título.');
      return;
    }
    home = safeHome(location.href);
    state = {phase:'results', title, updated:Date.now()};
    noResultSince = 0;
    try {
      store();
      view.input.focus();
      const setter = Object.getOwnPropertyDescriptor(view.win.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(view.input, title);
      else view.input.value = title;
      // O ELO avisa título inválido com alert(). Captura a mensagem para tratá-la aqui.
      const alerts = [];
      const wins = views.map(item => item.win);
      withCapturedAlerts(wins, alerts, () => {
        view.input.dispatchEvent(new view.win.Event('input', {bubbles:true}));
        // Não simula teclas: rotinas legadas podem exigir dados que Event não possui.
        view.input.dispatchEvent(new view.win.Event('change', {bubbles:true}));
        view.input.blur(); // Executa o onblur nativo do ELO antes da consulta.
      });
      if (alerts.length) { rejectQuery(title, alerts); return; }
      // A validação nativa pode cancelar ou corrigir a inscrição.
      if (view.input.value.replace(/\D/g, '') !== title) {
        throw new Error('O ELO alterou ou limpou o título digitado. Confira os números e tente de novo.');
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
      setStatus('Consultando inscrição. Aguardando o resultado…');
      updateButtons();
      if (!visible(view.consult) || !visible(view.input)) throw new Error('O formulário mudou. Tente novamente.');
      clearPopover();
      refreshActivity();
      withCapturedAlerts(wins, alerts, () => view.consult.click());
      if (alerts.length) { rejectQuery(title, alerts); return; }
      scheduleTick();
    } catch (error) { stop('Consulta interrompida. ' + error.message); }
  }

  function withCapturedAlerts(wins, messages, action) {
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

  function rejectQuery(title, alerts) {
    const reason = alerts.filter(Boolean).join(' ') || 'título recusado.';
    const message = `O ELO recusou o título ${formatTitle(title)}: ${reason}`;
    stop(message);
    setCollapsed(false);
    showPopover(message + '\nCorrija o título e consulte novamente.', panel?.ownerDocument, 8000, 'error');
    focusTitleInput(true);
  }

  function returnHome() {
    if (!home) { setStatus('Abra a tela inicial de consulta para registrar o retorno.'); return; }
    const destination = safeHome(home);
    if (!destination) { stop('Endereço de retorno inválido.'); return; }
    stop('Voltando à consulta inicial…');
    window.location.assign(destination);
  }

  function setCollapsed(collapsed) {
    if (!panel) return;
    panel.querySelector('[data-body]').hidden = collapsed;
    const button = panel.querySelector('[data-collapse]');
    button.textContent = collapsed ? '+' : '−';
    button.setAttribute('aria-label', collapsed ? 'Expandir painel' : 'Recolher painel');
  }

  function finish(message, noAse = false, storedMessage = message) {
    state.phase = 'done';
    state.message = storedMessage;
    state.updated = Date.now();
    store();
    setStatus(message);
    if (noAse) {
      setCollapsed(false);
      showPopover(message, panel?.ownerDocument, 10000, 'success');
    }
    updateButtons();
  }

  function focusTitleInput(select = false) {
    const input = panel?.querySelector('[data-title]');
    if (input?.isConnected && !panel.querySelector('[data-body]').hidden) {
      input.focus({preventScroll:true});
      if (select) input.select();
    }
  }

  function clearTitleInput() {
    const input = panel?.querySelector('[data-title]');
    if (!input) return;
    input.value = '';
    updateButtons();
    // Evita restaurar o título apagado quando o painel for recriado.
    if (state && !state.clearTitle) {
      state.clearTitle = true;
      try { store(); } catch { /* A limpeza do campo continua disponível. */ }
    }
    focusTitleInput();
  }

  function isolatePanelEvents(element) {
    // Os tratadores globais legados do ELO não conhecem os controles deste painel.
    // Interrompe só a propagação: digitação, foco e envio por Enter continuam nativos.
    for (const type of ['keydown', 'keypress', 'keyup', 'click', 'dblclick',
      'mousedown', 'mouseup', 'mouseover', 'mouseout', 'input', 'change',
      'focusin', 'focusout', 'submit']) {
      element.addEventListener(type, event => event.stopPropagation());
    }
  }

  function mount(views) {
    const host = views.find(v => v.win.name === 'principal' && v.doc.body?.tagName === 'BODY')
      || views.find(v => v.doc.body?.tagName === 'BODY' && (v.input || v.result || v.ase))
      || views.find(v => v.doc.body?.tagName === 'BODY');
    if (!host) return;
    if (panel?.isConnected && panel.ownerDocument === host.doc) return;
    // Mantém a edição em andamento quando o ELO substitui o quadro do painel.
    const previousInput = panel?.querySelector('[data-title]');
    const draft = previousInput ? previousInput.value
      : state && !state.clearTitle ? formatTitle(state.title) : '';
    panel?.remove();
    const doc = host.doc;
    panel = doc.createElement('section');
    panel.id = PANEL;
    panel.setAttribute('aria-label', 'Consulta rápida ASE');
    panel.style.cssText = 'position:fixed;top:80px;right:20px;width:292px;max-width:calc(100vw - 24px);z-index:2147483647;background:#fff;color:#182333;border:1px solid #b7c6d5;border-radius:10px;box-shadow:0 5px 24px #0003;font:14px Arial,sans-serif;box-sizing:border-box;overflow:hidden;text-align:left';
    panel.innerHTML = `<div data-handle style="background:#174975;color:white;padding:12px 14px;cursor:move;touch-action:none;font-weight:bold;display:flex;justify-content:space-between;align-items:center">Consulta rápida ASE<button type="button" data-collapse aria-label="Recolher painel" style="background:transparent;color:white;border:0;font-size:20px;cursor:pointer">−</button></div>
      <div data-body style="padding:14px"><form data-form><label style="display:block;margin-bottom:7px" for="elo-ase-titulo">Título de eleitor</label><div style="position:relative"><input id="elo-ase-titulo" aria-describedby="elo-ase-titulo-feedback" data-title type="text" inputmode="numeric" autocomplete="off" maxlength="20" placeholder="0000 0000 0000" style="box-sizing:border-box;width:100%;font:18px Arial;padding:9px 38px 9px 9px;border:1px solid #a6b6c5;border-radius:5px"><button data-clear-title type="button" aria-label="Limpar título" title="Limpar título (Esc)" style="position:absolute;right:4px;top:50%;transform:translateY(-50%);width:30px;height:30px;padding:0;border:0;border-radius:4px;background:transparent;color:#526577;font:20px Arial,sans-serif;cursor:pointer">×</button></div><p id="elo-ase-titulo-feedback" data-title-feedback aria-live="polite" style="font-size:12px;line-height:1.4;margin:6px 0 0;color:#526577">Digite os 12 dígitos do título.</p><button disabled data-submit type="submit" style="width:100%;padding:10px;margin-top:10px;border:0;border-radius:5px;background:#174975;color:white;font-weight:bold;cursor:pointer">Consultar ASE</button></form><button data-return type="button" style="width:100%;padding:9px;margin-top:8px;cursor:pointer">Voltar à consulta inicial</button><button data-cancel type="button" style="width:100%;padding:7px;margin-top:6px;cursor:pointer">Parar automação</button><p data-status role="status" aria-live="polite" style="font-size:12px;line-height:1.45;margin:12px 0 0"></p></div>`;
    isolatePanelEvents(panel);
    doc.body.append(panel);
    panel.querySelector('[data-title]').value = draft;
    panel.querySelector('[data-title]').addEventListener('input', formatTitleInput);
    panel.querySelector('[data-title]').addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      clearTitleInput();
    });
    panel.querySelector('[data-clear-title]').addEventListener('click', clearTitleInput);
    panel.querySelector('[data-status]').textContent = statusText;
    panel.querySelector('[data-form]').addEventListener('submit', start);
    panel.querySelector('[data-return]').addEventListener('click', returnHome);
    panel.querySelector('[data-cancel]').addEventListener('click', () => stop('Automação interrompida. Você pode voltar à consulta inicial.'));
    panel.querySelector('[data-collapse]').addEventListener('click', () => {
      setCollapsed(!panel.querySelector('[data-body]').hidden);
    });
    if (Number.isFinite(savedPosition?.x) && Number.isFinite(savedPosition?.y)) {
      panel.style.right = 'auto';
      panel.style.left = Math.max(0, Math.min(savedPosition.x, host.win.innerWidth - 300)) + 'px';
      panel.style.top = Math.max(0, Math.min(savedPosition.y, host.win.innerHeight - 50)) + 'px';
    }
    const handle = panel.querySelector('[data-handle]');
    let drag = null;
    handle.addEventListener('pointerdown', e => {
      if (e.target.closest('button') || e.button !== 0) return;
      const rect = panel.getBoundingClientRect();
      drag = {x:e.clientX - rect.left, y:e.clientY - rect.top};
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    handle.addEventListener('pointermove', e => {
      if (!drag) return;
      const x = Math.max(0, Math.min(e.clientX - drag.x, host.win.innerWidth - panel.offsetWidth));
      const y = Math.max(0, Math.min(e.clientY - drag.y, host.win.innerHeight - 44));
      panel.style.right = 'auto'; panel.style.left = x + 'px'; panel.style.top = y + 'px';
      savedPosition = {x, y};
    });
    function endDrag() { if (drag) { drag = null; try { store(); } catch {} } }
    handle.addEventListener('pointerup', endDrag);
    handle.addEventListener('pointercancel', endDrag);
    updateButtons();
    focusTitleInput();
    // O monitor existente reaplica o foco quando este documento terminar de carregar.
    focusAfterLoad = doc.readyState === 'complete' ? null : doc;
  }

  const TIMEOUT_MESSAGES = Object.freeze({
    query: 'O formulário de consulta do ELO não ficou disponível. Volte à consulta inicial e tente de novo.',
    results: 'O ELO não abriu o resultado da consulta a tempo. Confira o título e tente de novo.',
    detail: 'O detalhe do eleitor não carregou, ou o link do ASE não foi reconhecido. Confira a tela do ELO.',
    history: 'O histórico ASE não carregou a tempo. Confira a tela do ELO.'
  });

  function noResultMessage(doc) {
    if (doc.readyState !== 'complete') return false;
    // Evita confundir mensagens do painel, alertas antigos ou textos de outros campos.
    return Array.from(doc.querySelectorAll('td,p,div,span,[role="alert"]')).some(node => {
      if (node.closest('#' + PANEL + ',[data-elo-ase-popover]')) return false;
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      // Consulta estilos e dimensões apenas quando o texto pode ser a mensagem esperada.
      return CONFIG.noResultPattern.test(text) && visible(node);
    });
  }

  function failWith(message) {
    stop(message);
    setCollapsed(false);
    showPopover(message, panel?.ownerDocument, 8000, 'error');
    focusTitleInput(true);
  }

  function checkWaiting(views) {
    if (checkStepTimeout()) return;
    if (state.phase === 'results') {
      if (views.some(view => noResultMessage(view.doc))) {
        // Exige que o aviso persista, para não confundir com a tela ainda carregando.
        noResultSince = noResultSince || Date.now();
        if (Date.now() - noResultSince >= CONFIG.noResultDelayMs) {
          failWith(`O ELO não retornou nenhum eleitor para o título ${formatTitle(state.title)}. Confira o número digitado.`);
        }
        return;
      }
      noResultSince = 0;
    }
  }

  function checkStepTimeout() {
    if (!busy() || Date.now() - state.updated <= CONFIG.stepTimeoutMs) return false;
    failWith(TIMEOUT_MESSAGES[state.phase] || 'Tempo esgotado. Confira as mensagens do ELO e tente de novo.');
    return true;
  }

  function tick() {
    if (suspended || running) return;
    running = true;
    try {
      const views = collect();
      syncMonitoring(views);
      if (!home && (views.some(v => v.input)
        || new URL(location.href).searchParams.get('url') === '/sae/jsp/ConsultaAtendimento.jsp')) {
        home = safeHome(location.href);
        try { store(); } catch { setStatus('O navegador precisa permitir armazenamento da sessão para a automação.'); }
      }
      mount(views);
      // O ajuste visual do ELO nunca deve impedir a montagem ou a automação.
      for (const view of views) {
        if (!view.historyTitle) continue;
        try { fixHistoryBackButton(view.doc); }
        catch (error) { console.warn('[ELO ASE] Não foi possível ajustar a posição do botão Voltar.', error); }
      }
      if (focusAfterLoad?.readyState === 'complete' && panel?.ownerDocument === focusAfterLoad) {
        focusTitleInput(); focusAfterLoad = null;
      }
      if (!busy()) {
        if (verifyHistory(views) === 'waiting') scheduleTick(300);
        return;
      }
      if (!validState(state)) { stop('Tempo esgotado. Confira as mensagens do ELO e tente novamente.'); return; }
      if (checkStepTimeout()) return;
      const action = chooseAction(state, views);
      if (!action) { checkWaiting(views); return; }
      if (action.kind === 'query') {
        submitQuery(action.view, state.title);
        return;
      }
      if (action.kind === 'mismatch') {
        stop('O primeiro resultado tem inscrição diferente. Automação interrompida para conferência.');
        return;
      }
      if (action.kind === 'complete') {
        const outcome = verifyHistory(views);
        if (outcome === 'waiting') { scheduleTick(300); return; }
        if (!outcome) finish('Histórico ASE carregado. Use o botão acima para voltar.');
        return;
      }
      if (action.kind === 'noase') {
        const empty = CONFIG.turns.map(() => false);
        const detail = views.find(view => view.noAseTitle === state.title);
        const name = detail ? electorName(detail.doc, state.title) : '';
        finish(turnReport(state.title, empty, name, empty), true,
          turnReport(state.title, empty, '', empty));
        return;
      }
      // Busca um elemento atual e valida de novo antes de acionar o evento nativo.
      const freshViews = collect();
      if (!navigationReady(freshViews)) {
        setStatus('Aguardando o ELO concluir o carregamento interno antes de avançar…');
        scheduleTick(100);
        return;
      }
      const fresh = chooseAction(state, freshViews);
      if (!fresh || fresh.kind !== action.kind || !visible(fresh.node)) return;
      state.phase = action.kind === 'result' ? 'detail' : 'history';
      state.updated = Date.now();
      store();
      setStatus(action.kind === 'result' ? 'Abrindo o primeiro resultado. Aguardando o link ASE…'
        : 'Abertura do histórico ASE solicitada. Use o botão acima para voltar.');
      updateButtons();
      fresh.node.click();
      scheduleTick();
    } catch (error) { stop('Automação interrompida. ' + error.message); }
    finally { running = false; refreshActivity(); }
  }

  function boot() {
    restore();
    if (state) statusText = state.phase === 'done' ? (state.message || 'Use Voltar à consulta inicial para uma nova pesquisa.')
      : 'Continuando a consulta. Aguardando a página carregar…';
    tick();
    window.addEventListener('pagehide', () => { suspended = true; cleanupMonitoring(); clearPopover(); });
    window.addEventListener('pageshow', e => { if (e.persisted) { suspended = false; tick(); focusTitleInput(); } });
  }
  boot();
})();
