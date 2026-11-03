# ELO | Consulta rápida do histórico ASE

Consulte o histórico ASE pelo título de eleitor e confira a existência do **ASE 167 (Justificativa de ausência às urnas)** nas datas dos dois turnos das Eleições Gerais de 2026.

O script adiciona um painel flutuante ao ELO, automatiza a abertura do histórico e apresenta o resultado da conferência em um aviso centralizado.

## Funcionalidades

- **Consulta pelo título:** aceita os 12 números da inscrição, com ou sem espaços.
- **Navegação automática:** preenche o formulário do ELO, consulta a inscrição, abre o primeiro resultado e acessa o histórico ASE.
- **Conferência dos dois turnos:** procura o código 167 e a data de ocorrência na mesma linha da tabela.
- **Aviso com identificação:** mostra nome e título do eleitor, quando o nome estiver disponível no cabeçalho do histórico.
- **Resultado por turno:** informa se encontrou os registros dos dois turnos, apenas de um deles ou de nenhum.
- **Orientação condicional:** quando faltar um registro, indica o turno e orienta seu lançamento manual, se for o caso.
- **Nova consulta a partir do histórico:** basta digitar outro título no painel e consultar. O retorno à tela inicial e a continuação da pesquisa são automáticos.
- **Campo pronto para a próxima pesquisa:** quando encontra os dois registros, limpa o título consultado e posiciona o cursor no campo, preservando outro título que o usuário já tenha começado a digitar.
- **Painel móvel e recolhível:** permite arrastar pelo cabeçalho e recolher os controles.
- **Controles de navegação:** inclui botões para interromper a automação e voltar à consulta inicial.

## Datas verificadas

| Turno | Código ASE | Data de ocorrência |
| --- | --- | --- |
| 1º turno de 2026 | 167 | 04/10/2026 |
| 2º turno de 2026 | 167 | 25/10/2026 |

A busca considera a coluna **Ocorrência**, não a data de processamento. Registros com situação **ATIVO** ou **INATIVO** contam como encontrados: a conferência verifica a existência do lançamento naquela data.

**As datas são fixas para as Eleições Gerais de 2026.** O script não identifica automaticamente o ano ou as datas de outras eleições.

## Como usar

1. Instale o script em um gerenciador de scripts de usuário, como o Tampermonkey.
2. Acesse o ELO com sua sessão autenticada e abra a tela de Atendimento, que contém o campo **Inscrição / CPF**.
3. No painel **Consulta rápida ASE**, digite o título de eleitor.
4. Clique em **Consultar ASE** ou pressione **Enter**.
5. Aguarde a abertura do histórico e leia o resultado da conferência.
6. Para pesquisar outra pessoa, digite o novo título no mesmo painel. Não é necessário voltar manualmente à tela inicial.

Se existirem outros filtros preenchidos no formulário original do ELO, o script pedirá que sejam limpos antes da pesquisa somente pelo título.

## Avisos e resultados

O aviso da conferência dos turnos fica centralizado por **10 segundos**. Sua largura se ajusta ao texto, respeitando o espaço disponível na tela. A mensagem também permanece no painel.

Quando o cadastro não apresenta o link para o histórico ASE, o script informa que não encontrou nenhum ASE para o eleitor. Esse aviso específico dura **3 segundos** e também permanece no painel.

Se não conseguir identificar a tabela do histórico, o script solicita conferência manual, sem interpretar a falha de leitura como ausência de registros.

## Escopo e funcionamento

- Funciona nas páginas do ELO em `https://cad-elo.tse.jus.br/sae/*`, incluindo a navegação pelos quadros internos da aplicação.
- Depende do acesso regular do usuário ao sistema e da estrutura das telas do ELO.
- O script **consulta e confere registros**. Não lança ASE, não altera dados cadastrais e não decide sobre a necessidade do lançamento.
- Não utiliza bibliotecas externas nem envia os dados consultados para serviços externos ao ELO.
- Mantém dados temporários da consulta no armazenamento de sessão do navegador para continuar a automação entre páginas.

## Versão 1.4.7

Inclui proteção do novo título em digitação, eliminação de gravação duplicada na conclusão e melhoria no tratamento de erros de leitura da página.
