# Desenvolvimento do rfcode

## Rodar a partir do código

```powershell
git clone <repo> rfcode; cd rfcode
npm test                     # testes (node:test, sem dependências)
npm link                     # deixa o comando "rfcode" disponível no terminal
npx @vscode/vsce package     # gera o .vsix da extensão
code --install-extension rfcode-<versão>.vsix --force
```
Depois de instalar um `.vsix` novo, recarregue o VS Code (`Ctrl+Shift+P` → "Reload Window").

## Estrutura

```
bin/rfcode.js        CLI
extension/           extensão do VS Code (painel, comandos, controle remoto)
media/               interface do painel (chat.js, chat.css, markdown.js) e ícones
lib/agent.js         núcleo: ferramentas, loop do agente, fila de mensagens e retomada
lib/providers.js     provedores de modelo (NVIDIA, OpenRouter, Groq, OpenAI, Anthropic, Gemini, locais...)
lib/doctor.js        diagnóstico do ambiente (/doctor)
lib/log.js           log de erros em ~/.rfcode/logs (sem chaves)
lib/tui.js           visual do terminal
lib/commands.js      comandos "/" (embutidos e personalizados)
lib/browser.js       navegador via Chrome DevTools Protocol
lib/office.js        PowerPoint, Word e leitura de documentos (lib/zip.js por baixo)
lib/pptx-visuals.js  gráficos e diagramas dos slides, desenhados com formas nativas
lib/xlsx.js          leitura e escrita de Excel
lib/data.js          data_query (SQLite em memória) e create_xlsx
lib/mcp.js           cliente de conectores MCP; lib/mcp-catalog.js tem os prontos
lib/enterprise.js    política da TI, auditoria e hooks
lib/tools/           módulos de ferramentas registrados em MODULES (agent.js): dados, git completo, HTTP
lib/guides/          guias por assunto que entram no prompt quando o assunto aparece
lib/video.js         vídeo narrado (voz do Windows + gravação no Chrome)
lib/remote.js        servidor do controle remoto (lib/qr.js gera o QR code)
lib/panel.js         HTML do painel, compartilhado pela webview e pelo celular
lib/pc.js, pc.ps1    controle do PC (Windows)
lib/sessions.js      conversas salvas e histórico
docs/SDD.md          documento de design e backlog
```

## Publicar no Marketplace

1. Crie um publisher em https://marketplace.visualstudio.com/manage (o ID precisa ser igual ao campo `publisher` do `package.json`).
2. Crie um Personal Access Token no Azure DevOps (https://dev.azure.com → User settings → Personal access tokens) com **Organization: All accessible organizations** e escopo **Marketplace → Manage**.
3. `npx @vscode/vsce login <publisher>` e cole o token.
4. `npx @vscode/vsce publish` (ou `publish minor` para subir a versão e publicar).

Para o Open VSX (Cursor, VSCodium, Windsurf): crie uma conta em https://open-vsx.org, gere um token e rode `npx ovsx publish rfcode-<versão>.vsix -p <token>`.

## Comandos de desenvolvimento na extensão

Ative `rfcode.developerMode` nas configurações para usar **rfcode: Auto-melhoria** e **rfcode: Painel de auto-melhoria**. Aponte `rfcode.repoPath` para o clone do repositório.

## Central de auto-melhoria (painel do administrador)

```powershell
npm run painel        # ou: rfcode --painel
```
O painel abre em http://127.0.0.1:4517 e só aceita acessos do próprio computador. Nele você:
- **define a direção**: um texto de foco que o agente recebe como prioridade máxima;
- **escolhe o que fazer**: "Fazer a seguir", "Rodar só esta", criar uma tarefa nova no SDD ou reabrir uma bloqueada;
- **inicia e para** rodadas, escolhendo o modelo e quantas tarefas;
- **acompanha ao vivo** a fase, o plano, os arquivos alterados, a linha do tempo, os testes e os tokens;
- **revisa e aceita**: vê o diff de cada commit da branch `self-improve` e faz o merge com um clique.

## SDD e auto-melhoria

O `docs/SDD.md` é o documento de design: visão, arquitetura, regras de qualidade e o **backlog** de melhorias. O próprio rfcode implementa esse backlog num loop:

```powershell
npm run self-improve -- --iterations 3
npm run self-improve -- --task T05 --model z-ai/glm-5.3
```

Como o loop funciona:
- trabalha numa git worktree separada (branch `self-improve`), então a versão instalada não é afetada;
- usa só as ferramentas de código, sem controle do PC;
- só pode rodar testes e comandos git de leitura;
- não pode editar os testes de base, o SDD nem o próprio script;
- uma tarefa só vira commit se `npm test` passar e o número de testes não diminuir;
- uma tarefa que falha duas vezes é marcada `[!]` para revisão humana;
- **nunca faz push nem merge.** Para revisar: `git log --stat main..self-improve`. Para aceitar: `git merge self-improve`.
