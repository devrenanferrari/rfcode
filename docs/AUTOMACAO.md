# Automação, CI e tarefas longas

## Modo automação (`rfcode -p`)

```bash
rfcode -p "rode os testes e corrija o que falhar"            # executa e sai (código 0 ok, 1 erro)
git diff | rfcode -p "revise este diff procurando bugs"       # a entrada padrão vira contexto
rfcode -p "gere o resumo da semana" --output resumo.md        # grava a resposta final
rfcode -p "atualize as dependências" --json                   # eventos em JSON, um por linha
rfcode -p "..." --model groq:openai/gpt-oss-120b --max-steps 40
```

Com `--json`, cada linha é um evento: `tool`, `tool_result`, `plan`, `info`, `retry`, `error` e, no fim, `done` com `ok`, `text`, `model`, `tokens`, `seconds` e `files` (arquivos alterados).

No modo automação não há perguntas: ações são aprovadas automaticamente, mas regras `deny`, a política da empresa e os hooks continuam valendo. Conectores que precisam de login avisam em vez de abrir o navegador.

## GitHub Actions

Revisão automática de pull requests:

```yaml
name: Revisão do rfcode
on: pull_request
permissions:
  contents: read
  pull-requests: write
jobs:
  revisar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: devrenanferrari/rfcode@v1.14.0
        with:
          prompt: Revise as mudanças deste pull request procurando bugs reais, falhas de segurança e casos de borda. Cite arquivo e linha. Seja objetivo.
          nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
          diff-as-input: 'true'
          comment-on-pr: 'true'
```

Corrigir testes quebrados todas as noites e abrir um pull request:

```yaml
name: Correção noturna
on:
  schedule: [{ cron: '0 3 * * *' }]
permissions:
  contents: write
  pull-requests: write
jobs:
  corrigir:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: devrenanferrari/rfcode@v1.14.0
        with:
          prompt: Rode os testes. Se algum falhar, corrija a causa, rode de novo e abra um pull request com /pr. Se tudo passar, não faça nada.
          nvidia-api-key: ${{ secrets.NVIDIA_API_KEY }}
          max-steps: '120'
```

Outros provedores: defina a variável do provedor no job (`GROQ_API_KEY`, `OPENAI_API_KEY`...) e passe `model: groq:openai/gpt-oss-120b`.

## Missões: tarefas de horas ou dias

```bash
rfcode missao "Migre o projeto de JavaScript para TypeScript, com tipos em todos os módulos e os testes passando" --horas 24
rfcode missao status          # o que está fazendo agora, plano, ciclos, ações, tokens
rfcode missao parar           # para ao fim da ação atual
rfcode missao retomar         # continua de onde parou (depois de reiniciar o computador, por exemplo)
rfcode missao lista
```

No painel e no terminal interativo: `/missao <objetivo> --horas 24`, `/missao status`, `/missao parar`, `/missoes`.

Como uma missão aguenta horas:

- Trabalha em ciclos. Cada ciclo começa com o contexto limpo e recebe do disco o objetivo, o plano, as anotações e o diário dos ciclos anteriores. Conversas enormes perdem qualidade; o estado em disco não.
- Roda num processo próprio: fechar o terminal ou o VS Code não interrompe. O computador não entra em suspensão enquanto ela roda.
- Commit de segurança ao fim de cada ciclo numa branch própria (`rfcode/missao-<id>`); a sua branch não é tocada.
- Falhas de rede ou do provedor: espera e tenta de novo (1, 2, 5, 10, 20, 30 minutos), com troca para um modelo reserva.
- Ciclos sem progresso: pede mudança de estratégia; depois de seis, pausa para revisão humana.
- Não pede aprovação e não faz nada irreversível (enviar, pagar, apagar, publicar): prepara e registra como pendência para uma pessoa.
- Só termina quando o plano está completo e verificado; uma conclusão com passos pendentes é recusada.
- Ao terminar: `relatorio.md` com o que foi feito, decisões, pendências e números, aviso do sistema e hooks `onDone`.

Tudo fica em `.rfcode/missoes/<id>/`: `missao.json` (estado), `diario.md` (o que aconteceu em cada ciclo), `log.txt` (cada ação) e `relatorio.md`.

Dicas para um bom objetivo: diga o resultado esperado e como saber que terminou ("pronto quando npm test passar e o README estiver completo"), o que não pode mudar e onde estão as referências.
