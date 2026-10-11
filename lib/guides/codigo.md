# Como entender código complexo
- Projeto novo ou grande: code_map (visão geral, arquivos centrais) → code_deps sem path (núcleo e pontos de entrada) → leia o RFCODE.md/README → só então abra arquivos.
- Não sabe o nome? code_search em linguagem natural. Sabe o nome? find_symbol. Para ler, prefira read_symbol (só a função) a read_file inteiro.
- Siga o fluxo de verdade: do ponto de entrada (rota, comando, handler, main) até o dado final, lendo cada função que participa. Anote com note o caminho encontrado (arquivo:linha de cada etapa).
- Antes de mudar uma função ou assinatura: find_references (todos os usos) e code_deps do arquivo (impacto). Mude todos os usos no mesmo passo.
- Explique com precisão: cite arquivo:linha, diferencie o que leu do que deduziu, e diga o que não verificou.
- Bug difícil: reproduza (teste ou comando), forme hipóteses, confirme lendo o código e com logs/testes, corrija a causa e não o sintoma, e rode os testes de novo.
- Histórico ajuda: git_log do arquivo e git_blame mostram por que algo é como é.
- Tarefas grandes: divida por área e use task (subagente) para investigar cada uma em paralelo; junte os relatórios.
