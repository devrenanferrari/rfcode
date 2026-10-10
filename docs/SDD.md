# rfcode: Software Design Document (SDD)

> Documento vivo. É a fonte de verdade do que o rfcode deve ser e o roteiro do loop de auto-melhoria (`npm run self-improve`).
> O loop lê o backlog (seção 7), implementa a primeira tarefa `[ ]`, roda os testes e só faz commit se tudo passar.

## 1. Visão

O rfcode é um agente de programação e de controle do PC, no estilo Claude Code, que roda de graça com os modelos da NVIDIA (build.nvidia.com).
Ele deve ser **útil de verdade**: entende o projeto, edita código com segurança, usa git, roda testes e opera programas no Windows.
Também deve ser **agradável de usar**: interface bonita, identidade visual própria e respostas rápidas.

Público: estudantes e desenvolvedores que querem um agente de código sem pagar por API.

## 2. Princípios

1. **Sem dependências de runtime.** Só Node ≥ 18 e APIs do sistema. Nada de `npm install` para usar.
2. **Segurança primeiro.** Toda ação que muda arquivos, roda comandos ou mexe no PC passa por aprovação (ou pelo modo auto, escolhido pelo usuário).
3. **A chave é do usuário.** O rfcode sempre pede a API key da NVIDIA a quem usa e nunca embute uma chave no código.
4. **Privacidade da tela.** A tela é lida localmente (OCR e UI Automation). Imagens da tela não são enviadas para a API.
5. **Um núcleo, várias interfaces.** `lib/agent.js` é compartilhado pela CLI e pela extensão. Lógica nova vai para `lib/` e as interfaces só exibem.
6. **Testável.** Toda funcionalidade nova em `lib/` vem com testes em `test/` (`node:test`, sem rede, com `fetch` simulado quando preciso).
7. **Português do Brasil** em toda a interface e nas mensagens.

## 3. Arquitetura

```
┌──────────────┐   ┌───────────────────────────┐
│ bin/rfcode.js│   │ extension/extension.js    │
│ CLI terminal │   │ VS Code: webview (media/) │
└──────┬───────┘   └────────────┬──────────────┘
       │      hooks (eventos)   │
       └──────────┬─────────────┘
           ┌──────▼───────┐
           │ lib/agent.js │  loop do agente, streaming SSE, ferramentas de código
           └──┬────────┬──┘
              │        │
      ┌───────▼──┐  ┌──▼─────────────┐
      │ lib/pc.js│  │ API NVIDIA     │  integrate.api.nvidia.com/v1 (OpenAI-compatível)
      │ pc.ps1   │  └────────────────┘
      └──────────┘  controle do PC (Windows)
```

### 3.1 Núcleo (`lib/agent.js`)
- `class Agent({ apiKey, model, cwd, tools?, systemExtra? })`
- `send(texto, hooks)`: roda o loop até o modelo parar de chamar ferramentas. Tem limite de 50 passos, refaz a chamada em 429/5xx e para em 401/403.
- Os hooks são `onThinking`, `onResponseStart`, `onReasoning`, `onText`, `onAssistantEnd`, `onToolCall`, `onToolResult`, `onCommandOutput`, `approve`, `onRetry`, `onError`, `onAborted` e `onDone`.
- Ferramentas de código: `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep` e `run_command`.
- Ferramentas git (`lib/git.js`): `git_status`, `git_diff`, `git_log` e `git_commit` (este pede aprovação).
- Plano visível: `update_plan({ goal, steps, why })` vira o hook `onPlan`. O texto que o modelo escreve junto de uma chamada chega como `reason` em `onToolCall`. O uso de tokens chega por `onUsage`.
- **Exemplo de referência** para ferramentas novas: `lib/git.js` + `test/git.test.js`. Para simular a API sem rede, veja `test/plan.test.js`.
- Para criar uma ferramenta nova:
  1. adicione a definição em `TOOL_DEFS`;
  2. crie o método com o mesmo nome em `Agent`;
  3. trate o nome em `describeCall`;
  4. se ela muda algo, coloque o nome em `NEEDS_APPROVAL`.

### 3.2 Controle do PC (`lib/pc.js` + `lib/pc.ps1`)
- Ferramentas: `windows`, `screen_text`, `screenshot`, `ui_elements`, `ui_click`, `ui_set_text`, `mouse`, `keyboard`, `open`, `clipboard` e `wait`.
- `pc.ps1` deve ser **somente ASCII** e acessar os argumentos como `$a['nome']`.

### 3.3 Interfaces
- **CLI:** REPL com comandos `/` e cores ANSI.
- **Extensão:** painel webview na barra lateral. O protocolo de mensagens fica documentado em `extension/extension.js` (`onMessage`) e `media/chat.js`. A chave fica em `context.secrets`.

### 3.4 Configuração
- `~/.rfcode/config.json` guarda `{ apiKey, model }`. A chave do config tem prioridade sobre `NVIDIA_API_KEY`.
- Na extensão: `rfcode.model` e `rfcode.autoApprove`.

## 4. Requisitos de qualidade (portões do loop)

Uma mudança só é aceita se cumprir todos os itens abaixo:
1. `npm test` passa.
2. O número de testes não diminui.
3. Os arquivos protegidos não foram alterados: `test/core.test.js`, `scripts/self-improve.js`, `scripts/dashboard.js` e `docs/SDD.md` (o SDD só é atualizado pelo runner e pelo painel).
4. `package.json` mantém `"test": "node --test \"test/**/*.test.js\""`.
5. A mudança não está vazia.

## 5. Modelos

| Modelo | Uso |
|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | padrão: rápido e bom com ferramentas |
| `z-ai/glm-5.3` | tarefas difíceis de código (mais lento) |
| `openai/gpt-oss-20b` | respostas rápidas e simples |

## 6. Processo de auto-melhoria

`npm run painel` abre a **Central de auto-melhoria** (http://127.0.0.1:4517), por onde o administrador acompanha e dirige tudo.
Também dá para rodar só o loop: `npm run self-improve -- --iterations 3 [--model ID] [--task T05]`.

### 6.1 Como uma tarefa é executada
1. O loop trabalha numa **git worktree** separada (`.worktrees/self-improve`, branch `self-improve`) e junta as novidades de `main` antes de começar.
2. Escolhe a tarefa: a marcada como "a seguir" no painel; se não houver, a primeira `[ ]` do backlog.
3. O agente recebe:
   - só as ferramentas de código, git de leitura e `update_plan`, sem controle do PC;
   - a **direção do administrador** (foco), como prioridade máxima;
   - o motivo da falha anterior, se houver.
4. **Transparência obrigatória:**
   - o agente declara o objetivo e o plano com `update_plan` e atualiza a cada passo, dizendo por quê;
   - antes de cada ação, escreve o que vai fazer e por quê.
5. Política automática:
   - **edições:** só dentro da worktree e fora dos arquivos protegidos;
   - **comandos:** só testes e git de leitura.
6. **Validação com reparo:** o runner confere os portões da seção 4. Se falhar, o agente recebe a falha e tem até 2 rodadas de reparo na mesma tarefa.
7. **Veredito:**
   - passou → commit na branch e `[x]`;
   - falhou → descarta e guarda o motivo, e na 2ª falha marca `[!]`.
8. **Nunca** faz push nem merge. O administrador revisa os diffs e aceita no painel.

### 6.2 O que o painel mostra
- **Agora:** tarefa, alvo (objetivo), tentativa, modelo, fase (Preparar → Entender → Implementar → Testar → Validar → Commit), "fazendo agora e por quê" e o plano com progresso.
- **Código em construção:** arquivos alterados (+/−) e as funções, ferramentas e testes que o agente está escrevendo (detectados no diff), além do diff ao vivo.
- **Linha do tempo:** cada ação com o motivo e o resultado, as negações da política, os testes, os reparos e o veredito.
- **Resultado:** testes, tokens, ações e reparos.
- **Para revisar:** commits da branch com diff, e o botão de merge.
- **Rodadas:** o histórico, que dá para reabrir.

### 6.3 Como o administrador dirige
- **Direção:** um texto livre que vira prioridade máxima no prompt do agente (`.self-improve/focus.md`).
- **Fazer a seguir / Rodar só esta:** escolhe a próxima tarefa.
- **Nova tarefa:** adiciona ao SDD (commit em `main`).
- **Reabrir:** devolve uma tarefa bloqueada ao backlog.
- **Iniciar / Parar** a rodada e **Aceitar melhorias** (merge).

### 6.4 Dados
- Eventos de cada rodada: `.self-improve/runs/<id>.jsonl`. Tipos: run_start, task_start, phase, plan, say, tool, tool_result, denied, code, usage, tests, repair, verdict, blocked, warn, error, run_end.
- Índice das rodadas: `.self-improve/runs/index.json`. Estado das tentativas: `.self-improve/state.json`. Controle (parar, próxima tarefa): `.self-improve/control.json`.

## 7. Backlog

Formato: `### [ ] Tnn: título`. Estados: `[ ]` pendente, `[x]` feito, `[!]` bloqueado.
Cada tarefa traz critérios de aceite. Os testes novos vão em `test/<tema>.test.js`.

### [x] T01: Ferramentas git de leitura
> Feito à mão em 2026-10-10 como implementação de referência (o loop deve seguir este padrão).
Crie `lib/git.js` com funções que rodam git via `child_process.execFile` (sem shell) no `cwd` do agente:
- `git_status`: `git status --short --branch`;
- `git_diff({ path?, staged? })`: diff limitado a 20 000 caracteres;
- `git_log({ limit? })`: `git log --oneline -n <limit>`, com padrão 15.

Registre as três funções como ferramentas no `Agent` (definições em `TOOL_DEFS`, métodos no Agent e rótulos em `describeCall`, como `Git(status)`). Fora de um repositório git, elas devem devolver uma mensagem amigável.
**Aceite:** `test/git.test.js` cria um repositório temporário (`git init`, commit), altera um arquivo e verifica que `git_status` mostra o arquivo modificado, que `git_diff` contém a linha alterada e que `git_log` mostra o commit.

### [x] T02: Ferramenta git_commit (com aprovação)
> Feito à mão em 2026-10-10 como implementação de referência (o loop deve seguir este padrão).
Em `lib/git.js`, adicione `git_commit({ message, files? })`. Ela faz `git add` dos `files` (ou `-A`) e depois `git commit -m`. Coloque `git_commit` em `NEEDS_APPROVAL`. Mensagem vazia deve dar erro.
**Aceite:** um teste num repositório temporário confirma que o commit foi criado com a mensagem certa e que mensagem vazia lança erro.

### [ ] T03: Desfazer alterações (checkpoints)
Crie `lib/checkpoints.js`. Antes de cada `write_file` e `edit_file`, o Agent guarda o conteúdo anterior do arquivo (ou a informação de que ele não existia) numa pilha em memória. `agent.undo()` desfaz a última alteração (restaura ou apaga o arquivo) e devolve uma descrição. Na CLI, crie o comando `/undo`.
**Aceite:** teste que escreve, edita e desfaz duas vezes, voltando ao estado original (inclusive apagando um arquivo que foi criado).

### [x] T04: Contagem de tokens
> Feito à mão em 2026-10-10 como implementação de referência (o loop deve seguir este padrão).
Envie `stream_options: { include_usage: true }` na chamada e leia `usage` do último chunk. Acumule em `agent.usage = { prompt, completion, total }` e chame o novo hook opcional `onUsage(usage)`. A CLI mostra o total depois de cada resposta (texto cinza).
**Aceite:** teste com `fetch` simulado que manda um chunk com `usage` e confere `agent.usage`.

### [ ] T05: Menções @arquivo
Crie `lib/mentions.js` com `expandMentions(texto, cwd)`. Para cada `@caminho` de arquivo existente, a função anexa o conteúdo ao fim da mensagem num bloco com o nome do arquivo (limite de 20 000 caracteres por arquivo). Use essa função em `Agent.send` antes de enviar ao modelo.
**Aceite:** teste com arquivo temporário: o texto expandido contém o conteúdo, e `@inexistente` fica inalterado.

### [ ] T06: Ferramenta web_fetch
Adicione a ferramenta `web_fetch({ url })`. Ela baixa a URL (timeout de 20 s), converte HTML em texto (remove `script`/`style`, tags e entidades básicas) e devolve até 20 000 caracteres. Só aceita `http` e `https`.
**Aceite:** teste com `fetch` simulado devolvendo HTML: o resultado não tem tags nem script, e `file://` é rejeitado.

### [ ] T07: Sessões salvas e retomada
Crie `lib/sessions.js` para salvar `agent.messages` em `~/.rfcode/sessions/<data>-<id>.json` (respeitando `RFCODE_HOME`) depois de cada resposta, e para listar e carregar sessões. Na CLI, crie `/sessions` (lista as 10 últimas) e `/resume <n>`.
**Aceite:** teste com `RFCODE_HOME` temporário: salva, lista e carrega a mesma conversa.

### [ ] T08: Compactação de contexto
Quando o histórico passar de 120 000 caracteres, substitua as mensagens antigas (todas menos as 6 últimas) por um resumo. O resumo é gerado com uma chamada sem ferramentas ao mesmo modelo e entra como uma mensagem `user` com o prefixo "Resumo da conversa anterior:". Ele nunca pode separar um par `assistant(tool_calls)`/`tool`.
**Aceite:** teste com `fetch` simulado: depois da compactação, o histórico fica menor, começa com o resumo e continua válido (cada `tool` tem o `assistant` correspondente).

### [x] T09: Ferramenta de plano (todo list)
> Feito à mão em 2026-10-10 como `update_plan` (goal, steps, why), exibido na CLI, no painel do VS Code e na central de auto-melhoria.
Adicione a ferramenta `todo_write({ items: [{ text, status: pending|in_progress|done }] })`. Ela guarda `agent.todos` e chama o hook `onTodos(items)`. O prompt do sistema deve orientar o modelo a usar a ferramenta em tarefas com 3 ou mais passos. A CLI mostra a lista com ☐ ◐ ☑ e o painel mostra a lista fixa acima do campo de texto.
**Aceite:** teste com `fetch` simulado que chama `todo_write` e confere `agent.todos` e o hook.

### [ ] T10: Painel: identidade visual e logo
Crie o logo do rfcode em SVG (`media/logo.svg`): um símbolo `>` estilizado com as letras "rf", em verde NVIDIA `#76B900` sobre grafite. Use esse logo no cabeçalho do painel e na tela de boas-vindas. Defina variáveis CSS de marca (`--rf-accent`) e aplique o acento nos botões principais, no cartão ativo e nos links, mantendo o tema do VS Code. A tela de boas-vindas deve mostrar 4 sugestões clicáveis ("Explique este projeto", "Encontre bugs", "Escreva testes", "Mostre o git status") que preenchem e enviam a mensagem.
**Aceite:** o arquivo `media/logo.svg` existe e é um SVG válido. Um teste lê `media/chat.js` e confirma que as sugestões existem (strings presentes).

### [ ] T11: Painel: botão copiar e linguagem nos blocos de código
Nos blocos de código renderizados em `media/chat.js`, mostre o nome da linguagem e um botão "Copiar" (use `navigator.clipboard.writeText`). Mova o renderizador de markdown para `media/markdown.js`, como módulo UMD que funciona no navegador (`window.rfMarkdown`) e no Node (`module.exports`), para poder ser testado.
**Aceite:** `test/markdown.test.js` testa títulos, listas, código inline, blocos com linguagem e escape de HTML (`<script>` vira texto).

### [ ] T12: Painel: comandos / e histórico
No campo de texto do painel:
- `/clear` limpa a conversa;
- `/model <id>` troca o modelo;
- `/undo` desfaz (depende de T03);
- `/help` lista os comandos;
- ↑ e ↓ navegam pelas mensagens enviadas.

A extensão trata as novas mensagens do webview.
**Aceite:** a lógica de parsing fica em `media/commands.js` (UMD) e é testada em `test/commands.test.js`.

### [ ] T13: Diff no editor do VS Code
Quando o agente pedir aprovação de `edit_file` ou `write_file` na extensão, o cartão ganha o botão "Ver diff". Ele abre `vscode.diff` entre o arquivo atual e a versão proposta (documento virtual por `TextDocumentContentProvider` com esquema `rfcode-proposed`).
**Aceite:** a função que calcula o conteúdo proposto (aplicar `old_string` → `new_string`) fica em `lib/` e tem teste.

### [ ] T14: Comando /init (RFCODE.md)
Na CLI, crie `/init`. Ele pede ao agente para analisar o projeto e escrever `RFCODE.md` com: visão geral, como rodar, como testar, estrutura e convenções. O prompt fica em `lib/prompts.js`.
**Aceite:** teste que confere que `lib/prompts.js` exporta `INIT_PROMPT` com as seções exigidas.

### [ ] T15: Robustez de tool calls
Se os argumentos de uma ferramenta vierem com JSON inválido, tente consertar o JSON (remover crases ou markdown em volta, vírgula sobrando, aspas simples) antes de devolver o erro. Se o modelo responder vazio (sem texto e sem ferramentas) duas vezes seguidas, encerre com uma mensagem clara.
**Aceite:** testes para o reparo de JSON (`lib/jsonfix.js`) com pelo menos 5 casos.

### [ ] T16: Modo plano (planejar antes de executar)
Crie um modo em que o agente investiga o código e propõe um plano (com `update_plan`) **sem editar nada**, e só executa depois que o usuário aprova. Na CLI, `/plan <pedido>` entra no modo e `/go` aprova. No Agent, adicione a opção `planOnly`: enquanto estiver ativa, as ferramentas que mudam algo são negadas com a mensagem "modo plano: apenas investigue e proponha o plano".
**Aceite:** teste com `fetch` simulado: com `planOnly`, um `write_file` é negado e o arquivo não é criado; com `planOnly` desligado, o mesmo pedido cria o arquivo.

### [ ] T17: Permissões configuráveis
Leia `~/.rfcode/settings.json` (respeitando `RFCODE_HOME`) com `{ "allow": ["run_command:npm test", "edit_file:src/**"], "deny": ["run_command:rm *"] }`. As regras `allow` dispensam a aprovação e as `deny` negam sempre; os padrões usam `*` e `**`. Crie `lib/permissions.js` com `decide(tool, args, rules)`, que retorna 'allow', 'deny' ou 'ask', e use no Agent antes de chamar `approve`.
**Aceite:** `test/permissions.test.js` com pelo menos 6 casos (allow, deny, deny vence allow, glob de caminho, comando com argumentos, ask padrão).

### [ ] T18: Histórico de entradas na CLI
Salve as últimas 200 entradas da CLI em `~/.rfcode/history` e carregue no readline (setas ↑ e ↓ entre sessões). Crie `lib/history.js` com `load()` e `append(line)`, ignorando linhas vazias e duplicadas em sequência.
**Aceite:** teste com `RFCODE_HOME` temporário para append, load, limite de 200 e o caso de duplicadas.
