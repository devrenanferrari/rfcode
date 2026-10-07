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
3. Os arquivos protegidos não foram alterados: `test/core.test.js`, `scripts/self-improve.js` e `docs/SDD.md` (o SDD só é atualizado pelo próprio runner).
4. `package.json` mantém `"test": "node --test \"test/**/*.test.js\""`.
5. A mudança não está vazia.

## 5. Modelos

| Modelo | Uso |
|---|---|
| `nvidia/nemotron-3-super-120b-a12b` | padrão: rápido e bom com ferramentas |
| `z-ai/glm-5.3` | tarefas difíceis de código (mais lento) |
| `openai/gpt-oss-20b` | respostas rápidas e simples |

## 6. Processo de auto-melhoria

`npm run self-improve -- --iterations 3 [--model z-ai/glm-5.3]`

1. Trabalha numa **git worktree** separada (`.worktrees/self-improve`, branch `self-improve`). A versão instalada não é tocada.
2. Pega a primeira tarefa `[ ]` do backlog e dá ao agente só as ferramentas de código, sem controle do PC.
3. Política de aprovação automática:
   - **edições:** só dentro da worktree e fora dos arquivos protegidos;
   - **comandos:** só `npm test`, `node --test …`, `node --check …` e `git status/diff/log/show`.
4. No fim, o runner roda os testes e confere os portões da seção 4.
   - Se tudo passar, faz commit e marca `[x]`.
   - Se algo falhar, descarta a mudança. Depois de 2 falhas na mesma tarefa, ela é marcada como `[!]` (bloqueada para revisão humana).
5. **Nunca** faz push nem merge. Para revisar: `git log main..self-improve`. Para aceitar: `git merge self-improve`.
6. O log de cada execução fica em `.self-improve/log.md`.

## 7. Backlog

Formato: `### [ ] Tnn: título`. Estados: `[ ]` pendente, `[x]` feito, `[!]` bloqueado.
Cada tarefa traz critérios de aceite. Os testes novos vão em `test/<tema>.test.js`.

### [ ] T01: Ferramentas git de leitura
Crie `lib/git.js` com funções que rodam git via `child_process.execFile` (sem shell) no `cwd` do agente:
- `git_status`: `git status --short --branch`;
- `git_diff({ path?, staged? })`: diff limitado a 20 000 caracteres;
- `git_log({ limit? })`: `git log --oneline -n <limit>`, com padrão 15.

Registre as três funções como ferramentas no `Agent` (definições em `TOOL_DEFS`, métodos no Agent e rótulos em `describeCall`, como `Git(status)`). Fora de um repositório git, elas devem devolver uma mensagem amigável.
**Aceite:** `test/git.test.js` cria um repositório temporário (`git init`, commit), altera um arquivo e verifica que `git_status` mostra o arquivo modificado, que `git_diff` contém a linha alterada e que `git_log` mostra o commit.

### [ ] T02: Ferramenta git_commit (com aprovação)
Em `lib/git.js`, adicione `git_commit({ message, files? })`. Ela faz `git add` dos `files` (ou `-A`) e depois `git commit -m`. Coloque `git_commit` em `NEEDS_APPROVAL`. Mensagem vazia deve dar erro.
**Aceite:** um teste num repositório temporário confirma que o commit foi criado com a mensagem certa e que mensagem vazia lança erro.

### [ ] T03: Desfazer alterações (checkpoints)
Crie `lib/checkpoints.js`. Antes de cada `write_file` e `edit_file`, o Agent guarda o conteúdo anterior do arquivo (ou a informação de que ele não existia) numa pilha em memória. `agent.undo()` desfaz a última alteração (restaura ou apaga o arquivo) e devolve uma descrição. Na CLI, crie o comando `/undo`.
**Aceite:** teste que escreve, edita e desfaz duas vezes, voltando ao estado original (inclusive apagando um arquivo que foi criado).

### [ ] T04: Contagem de tokens
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

### [ ] T09: Ferramenta de plano (todo list)
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
