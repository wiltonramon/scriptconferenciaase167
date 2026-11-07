# ELO | Consulta rápida do histórico ASE

Script de usuário para consultar o histórico ASE pelo título de eleitor e conferir os registros **094 (Ausência às urnas)** e **167 (Justificativa de ausência às urnas)** nas datas da eleição selecionada. Por padrão, confere os dois turnos de 2026.

**Versão atual: 1.5.40.**

O script adiciona um painel flutuante ao ELO, automatiza a abertura do histórico e apresenta a conferência por turno. As orientações de lançamento são condicionais: o usuário avalia cada caso e realiza o lançamento manualmente, quando necessário.

## Arquivos e instalação

| Arquivo | Uso |
| --- | --- |
| [elo-consulta-ase.user.js](elo-consulta-ase.user.js) | Script para instalação no gerenciador de scripts de usuário. |
| [elo-consulta-ase.user.txt](elo-consulta-ase.user.txt) | Mesmo código em texto, como alternativa quando o download de `.js` é bloqueado. |

Os arquivos `.js` e `.txt` têm conteúdo idêntico. Instale apenas uma cópia.

1. Tenha um gerenciador de scripts de usuário, como o Tampermonkey, instalado no navegador.
2. Abra o [arquivo `.user.js` em formato bruto](https://raw.githubusercontent.com/wiltonramon/scriptconferenciaase167/main/elo-consulta-ase.user.js) e confirme a instalação no gerenciador.
3. Como alternativa, abra o [arquivo `.txt` em formato bruto](https://raw.githubusercontent.com/wiltonramon/scriptconferenciaase167/main/elo-consulta-ase.user.txt), copie todo o conteúdo, crie um novo script no gerenciador e salve.
4. Acesse o ELO com sua sessão autenticada e recarregue a página.

Para atualizar manualmente, substitua todo o código do script instalado pela versão atual de um dos arquivos e recarregue o ELO. O script não declara `@updateURL` ou `@downloadURL` próprios.

## Como usar

1. Abra uma vez a tela inicial de consulta do ELO, com o campo **Inscrição / CPF**, para registrar o endereço de retorno.
2. No painel **Consulta ASE**, digite ou cole o título de eleitor.
3. Clique em **Consultar ASE** ou pressione **Enter** quando o título estiver válido.
4. Aguarde a abertura do resultado, dos dados do eleitor e do histórico ASE.
5. Leia o aviso e confira a orientação de cada turno. A mensagem também permanece no painel.
6. Para outra consulta, informe o novo título no mesmo painel. O script retorna à tela inicial e continua a pesquisa automaticamente quando necessário.

Se houver outros filtros preenchidos no formulário original do ELO, o script pede que sejam limpos antes da consulta apenas pelo título. Se o primeiro resultado pertencer a outra inscrição, a automação é interrompida para conferência.

## Painel e controles

O painel tem visual compacto, com o ano e os turnos selecionados apresentados uma única vez, no resumo de **Eleição e turnos**. A consulta fica em destaque, os botões **Voltar** e **Parar** aparecem lado a lado e a área **Acompanhamento** mantém as mensagens completas, com rolagem quando necessário. Durante a execução, o botão principal mostra **Consultando…** e o indicador mostra **Em consulta**.

- **Eleição e turnos:** clique no cabeçalho dessa seção para expandir ou recolher as opções. A seção começa fechada, com o resumo do ano e dos turnos marcados sempre visível. O estado aberto/fechado fica salvo na sessão. É necessário manter pelo menos um turno selecionado. Os seletores ficam bloqueados enquanto a consulta estiver em andamento.
- **Título formatado:** apresenta espaços a cada quatro dígitos, inclusive nos avisos, como `0656 9130 0701`.
- **Validação durante a digitação:** verifica o formato, o código de UF e os dígitos verificadores. O botão Consultar ASE permanece desativado enquanto a entrada estiver incompleta ou inválida. Essa validação não confirma a existência do cadastro no ELO.
- **Limpar título:** use o botão **×** à direita do campo ou pressione **Esc** com o foco no campo.
- **Mover painel:** arraste pelo cabeçalho. A posição é salva na sessão da aba e reaplicada ao recriar o painel.
- **Minimizar:** use o botão no cabeçalho. O painel inteiro é ocultado e fica somente uma seta pequena e discreta no canto superior direito, com destaque ao receber o mouse ou o foco do teclado.
- **Restaurar:** clique na seta para recuperar o tamanho normal, a posição anterior e o título que estava digitando. Enquanto minimizado, o painel não é reaberto automaticamente pelos resultados da consulta, e a seta acompanha a troca dos quadros internos do ELO.
- **Parar:** interrompe a consulta em andamento.
- **Voltar:** retorna ao endereço de consulta inicial registrado anteriormente.

O campo do título é limpo automaticamente quando:

- É encontrado ASE 167 em pelo menos um dos turnos.
- A leitura confirma que não há ASE 094 em nenhum dos turnos selecionados.
- A tela de detalhes confirma que o eleitor não possui o link de histórico ASE.

Outro título que já esteja sendo preparado para a próxima consulta é preservado. Uma falha de leitura não é considerada confirmação de ausência de registros.

## Selecionar a eleição

Expanda **Eleição e turnos** e use o seletor **Eleição** para escolher 2020, 2022, 2024 ou 2026. Ao mudar o ano, todos os turnos cadastrados para ele são inicialmente marcados. Depois, marque somente os turnos que deseja conferir. Por exemplo, é possível selecionar apenas o 2º turno de 2026. Recolher a seção preserva essa escolha e mantém seu resumo visível.

A preferência de ano e turnos fica salva na sessão da aba e acompanha a navegação e a recriação do painel. Durante uma consulta, os seletores ficam desativados; use **Parar** se precisar interromper a execução para mudar a seleção.

Os conjuntos disponíveis ficam no objeto `ELEICOES`, no início do código. Para adicionar outra eleição, cadastre uma nova chave e sua lista de turnos. O seletor do painel será preenchido com os conjuntos cadastrados.

A constante `ELEICAO` define apenas o valor inicial para uma sessão sem preferência salva:

```javascript
const ELEICAO = 2026; // valor inicial: os dois turnos de 2026
```

Os quatro conjuntos contêm os dois turnos. É possível conferir ambos ou selecionar apenas um. Preferências já salvas são preservadas, inclusive a seleção anterior de somente o primeiro turno de 2024.

Ao alterar o ano ou os turnos, o resultado anterior é descartado e o histórico aberto é relido no novo contexto, quando disponível. O título em digitação, o endereço de retorno e a posição do painel são preservados.

## Datas e regras de conferência

| Conjunto | Turno | Data de ocorrência | Códigos conferidos |
| --- | --- | --- | --- |
| 2020 | 1º Turno | 15/11/2020 | ASE 094 e ASE 167 |
| 2020 | 2º Turno | 29/11/2020 | ASE 094 e ASE 167 |
| 2022 | 1º Turno | 02/10/2022 | ASE 094 e ASE 167 |
| 2022 | 2º Turno | 30/10/2022 | ASE 094 e ASE 167 |
| 2024 | 1º Turno | 06/10/2024 | ASE 094 e ASE 167 |
| 2024 | 2º Turno | 27/10/2024 | ASE 094 e ASE 167 |
| 2026 (padrão) | 1º Turno | 04/10/2026 | ASE 094 e ASE 167 |
| 2026 (padrão) | 2º Turno | 25/10/2026 | ASE 094 e ASE 167 |

Somente as datas dos turnos marcados no painel participam da conferência. Registros de outras datas não completam os turnos selecionados.

A busca usa a coluna **Ocorrência**, e exige que código e data estejam na mesma linha da tabela. A data de processamento não é usada.

- **ASE 094:** o relatório identifica os registros **ATIVO**, **INATIVO** e **FACULTADO**, mas somente **ATIVO** e **FACULTADO** podem gerar orientação de lançamento do ASE 167. Um registro **INATIVO** é identificado como tal e não gera essa orientação.
- **ASE 167:** é conferida a existência do código na data correspondente, sem filtro de situação.
- **Orientação por turno:** aparece somente quando há ASE 094 **ATIVO** ou **FACULTADO** e não há ASE 167 na mesma data. O aviso orienta: `Registre o ASE 167 no 1º Turno, se for o caso.` ou o equivalente para o 2º Turno. A ausência isolada de ASE 167 não basta para gerar a orientação.
- **Sem ASE 094 em um turno:** o script informa a ausência desse registro e não recomenda lançar ASE 167 para esse turno.
- **ASE 167 em todos os turnos selecionados:** o resultado informa que não há registros a serem feitos, independentemente da existência de ASE 094.

O script usa a configuração escolhida no código; não identifica automaticamente o ano ou as datas da eleição.

## Avisos, cores e duração

**Todos os popovers duram 10 segundos**, incluindo os avisos de erro e de eleitor sem histórico ASE. Todos possuem um botão **× no canto superior direito** para fechar antes do prazo. Fechar o popover não apaga a mensagem do painel nem interrompe a consulta.

| Cor | Significado |
| --- | --- |
| Verde | ASE 167 encontrado em todos os turnos selecionados, ou conferência concluída sem pendências segundo as regras de ASE 094 e 167. Inclui o caso confirmado de eleitor sem histórico ASE. |
| Laranja | Há ASE 094 ATIVO ou FACULTADO e falta ASE 167 em pelo menos um turno correspondente. O texto identifica os turnos e apresenta orientação condicional de lançamento. ASE 094 INATIVO não gera essa orientação. |
| Amarela | Não foi possível concluir a conferência da tabela ou da situação dos registros. É necessária conferência manual. |
| Vermelha | Aviso de falha, como recusa do título pelo ELO, consulta sem resultado ou prazo de etapa excedido. |

Quando o ASE 167 é identificado em todos os turnos selecionados, o aviso é verde mesmo que a conferência do ASE 094 não esteja disponível. Nome e título identificam o resultado; se o nome não for obtido, aparece `ELEITOR(A): nome não identificado`.

### Exemplo: apenas o primeiro turno de 2024

Com apenas o primeiro turno de 2024 marcado no painel, o sucesso é apresentado no singular. O mesmo acontece ao selecionar somente um dos turnos de outra eleição:

```text
ELEITOR(A): [nome do eleitor]
TÍTULO: [título consultado]
ASE 167 registrado no 1º Turno (06/10/2024).
Não há registros a serem feitos.
```

### Exemplo: ASE 167 nos dois turnos

```text
ELEITOR(A): [nome do eleitor]
TÍTULO: [título consultado]
ASE 167 registrado nos dois turnos.
1º Turno (04/10/2026)
2º Turno (25/10/2026)
Não há registros a serem feitos.
```

### Exemplo: ASE 094 sem ASE 167 correspondente

```text
ASE 094 encontrado no 1º Turno (04/10/2026).
ASE 167 não encontrado no 1º Turno (04/10/2026).
Registre o ASE 167 no 1º Turno, se for o caso.
```

Esse trecho integra um aviso laranja com identificação do eleitor e as informações aplicáveis ao outro turno.

## Carregamento e erros

- Aguarda o carregamento dos documentos e as requisições jQuery do ELO antes de avançar, evitando interromper o carregamento interno do menu no Firefox.
- Aguarda até **4 segundos** pela identificação da tabela do histórico quando necessário.
- Aplica prazo de **45 segundos por etapa**, com mensagem correspondente ao formulário, resultado, dados do eleitor ou histórico.
- Captura os alertas de validação durante o preenchimento e o clique em Consultar, apresentando o motivo da recusa no painel e no popover.
- Em erro inesperado, mostra o motivo no painel e registra o diagnóstico completo no console do navegador, acessível por **F12**.

A detecção de consulta sem resultado usa um padrão conservador de mensagens em `CONFIG.noResultPattern`. Se o ELO mudar o texto ou a estrutura das telas, essa identificação pode precisar de ajuste.

## Organização e manutenção do código

O script permanece em um arquivo único, com funções próprias nomeadas em português e comentários de manutenção. O código está dividido em 12 seções, da configuração à inicialização.

| O que alterar | Onde procurar |
| --- | --- |
| Ano e turnos selecionados | Controles do painel; `ELEICAO` define o valor inicial |
| Conjuntos de turnos e datas disponíveis | `ELEICOES` |
| Validação e atualização do contexto | `aplicarSelecaoEleitoral`, `alterarSelecaoEleitoral` e `atualizarSelecaoPainel` |
| Códigos ASE e tempos de espera | `CONFIG` |
| Mensagens de prazo excedido | `TIMEOUT_MESSAGES` |
| Leitura dos registros por código, situação e data | `lerAsesPorTurno` |
| Cores, pendências e limpeza automática do título | `conferirHistorico` e o tratamento de eleitor sem histórico em `executarCiclo` |
| Textos dos resultados | `montarRelatorioTurnos` e `relatarAusencias` |
| HTML do painel | `obterHtmlPainel` |
| Estilos do painel | `ESTILOS_PAINEL` e `aplicarEstilosPainel` |
| Criação e montagem do painel | `criarPainel` e `montarPainel` |
| Eventos e atalho Esc | `registrarEventosPainel` e `tratarEscapeNoTitulo` |
| Posição e arraste | `restaurarPosicaoPainel` e `habilitarArrastePainel` |
| Minimização e restauração pela seta | `definirPainelRecolhido`, `exibirBotaoRestaurarPainel`, `removerBotaoRestaurarPainel` e `ESTILO_BOTAO_RESTAURAR_PAINEL` |
| Popovers, botão de fechar e temporizador | `exibirPopover` e `fecharPopover` |
| Sequência da automação | `escolherProximaAcao` e `executarCiclo` |

Os nomes das APIs externas, seletores do ELO e propriedades salvas na sessão são preservados por compatibilidade. Alterações em `KEY` ou no formato persistido exigem cuidado para não perder a continuidade de consultas iniciadas.

Os resultados salvos incluem uma assinatura da eleição, turnos, datas, códigos e situações que podem gerar orientação. Se essa configuração mudar, a seleção e a posição são recuperadas, mas uma nova consulta é solicitada. Sessões antigas sem assinatura também passam por essa validação antes de retomar uma consulta.

Ao publicar uma atualização, mantenha o mesmo código e a mesma versão nos arquivos `.js` e `.txt`. A versão 1.5.40 acrescenta os dois turnos de 2020 e o segundo turno de 2024, e impede a recuperação de resultados calculados com configurações anteriores. As situações que podem gerar orientação continuam em `CONFIG.absenceGuidanceStatuses`. O valor inicial continua sendo `ELEICAO = 2026`.

## Escopo e dados temporários

- Atua nas páginas `https://cad-elo.tse.jus.br/sae/*`, incluindo os quadros internos acessíveis.
- Depende da sessão autenticada e do acesso regular do usuário ao ELO.
- Consulta e confere registros. Não lança ASE nem altera o cadastro eleitoral.
- Não utiliza bibliotecas externas nem envia os dados consultados para outros serviços.
- Usa `sessionStorage` para manter eleição e turnos selecionados, título, etapa, resultado, endereço de retorno e posição do painel entre navegações. O nome exibido nos relatórios é omitido da mensagem salva na sessão.
- Confere as linhas disponíveis na tabela carregada; não percorre automaticamente eventual paginação do histórico.

## Licença

Distribuído sob a [licença MIT](LICENSE).
