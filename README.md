# rfcode

Agente de código e de controle do PC, no estilo Claude Code, que usa os modelos gratuitos da NVIDIA (`integrate.api.nvidia.com`).
Funciona como **extensão do VS Code** (painel de chat na barra lateral) e como **CLI** no terminal. Não tem dependências.

## API key

Na primeira vez, o rfcode pede uma API key da NVIDIA (crie a sua em https://build.nvidia.com → "Get API Key") e valida a chave antes de aceitar.
- Extensão: a chave fica no armazenamento seguro do VS Code. Para trocar, use o comando `rfcode: Configurar API key da NVIDIA`.
- CLI: a chave fica em `~/.rfcode/config.json`. Para trocar, use `/key` ou `rfcode --key`.
- A extensão reaproveita a chave da CLI se ela já existir.

## Extensão do VS Code

Instalar ou atualizar:
```powershell
code --install-extension C:\Users\user\Desktop\Projetos\rfcode\rfcode-1.1.0.vsix --force
```
Para gerar o pacote de novo: `npx @vscode/vsce package --allow-missing-repository --skip-license`.

- Clique no ícone do **rfcode** na barra de atividades (à esquerda) ou rode `Ctrl+Shift+P` → `rfcode: Abrir chat`.
- Enter envia a mensagem e Shift+Enter quebra a linha.
- Edições, comandos e ações no PC mostram um cartão com **Permitir**, **Permitir tudo** e **Negar**. A caixa **auto** no topo aprova tudo automaticamente.
- Clique no nome de um arquivo num cartão para abrir o arquivo no editor.
- O seletor no topo troca o modelo. Também dá para mudar em Configurações → `rfcode.model`.
- No editor, selecione um trecho, clique com o botão direito e escolha **rfcode: Perguntar sobre a seleção**.
- `rfcode: Abrir no terminal` abre a versão CLI.

## CLI

```powershell
cd C:\Users\user\Desktop\Projetos\rfcode; npm link   # uma vez
rfcode                        # modo interativo na pasta atual
rfcode "explique este projeto"
rfcode -p "rode os testes"    # executa e sai (aprova tudo)
```
Comandos: `/help`, `/model`, `/models`, `/key`, `/clear`, `/auto`, `/think`, `/cd`, `/exit`. Ctrl+C interrompe a resposta.

## Ferramentas do agente

**Código e sistema:** `read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`, `run_command` (PowerShell).

**Controle do PC (Windows):**
| Ferramenta | O que faz |
|---|---|
| `windows` | lista janelas; foca, minimiza, maximiza, restaura ou fecha uma janela |
| `screen_text` | lê o texto da tela, de uma janela, de uma região ou de uma imagem por OCR local, com as coordenadas de cada linha |
| `screenshot` | salva um print em PNG |
| `ui_elements` | lista botões, campos e menus de uma janela (UI Automation) com coordenadas |
| `ui_click` / `ui_set_text` | clica num elemento ou preenche um campo pelo nome |
| `mouse` | move, clica, dá duplo clique, clique direito, rola e arrasta |
| `keyboard` | digita texto e pressiona atalhos (`ctrl+s`, `win+r`, `alt+tab`…) |
| `open` | abre programas, arquivos, pastas e URLs |
| `clipboard` | lê ou define a área de transferência |
| `wait` | espera um tempo |

A tela é lida **localmente**: OCR do Windows e UI Automation. Nenhuma imagem da tela é enviada para a NVIDIA; o modelo recebe só o texto e as coordenadas.
Programas Win32 antigos (como o Bloco de Notas clássico) expõem poucos elementos no `ui_elements`. Nesses casos o agente usa `screen_text` + `mouse`.

Se existir `RFCODE.md`, `CLAUDE.md` ou `AGENTS.md` na pasta, o conteúdo entra como instruções do projeto.

## Central de auto-melhoria (painel do administrador)

```powershell
npm run painel        # ou: rfcode --painel   ·   VS Code: "rfcode: Painel de auto-melhoria"
```
O painel abre em http://127.0.0.1:4517. Ele só aceita acessos do próprio computador. Nele você:
- **define a direção**: um texto de foco que o agente recebe como prioridade máxima;
- **escolhe o que fazer**: "Fazer a seguir", "Rodar só esta", criar uma tarefa nova no SDD ou reabrir uma bloqueada;
- **inicia e para** rodadas, escolhendo o modelo e quantas tarefas;
- **acompanha ao vivo**:
  - a tarefa e o alvo dela;
  - a fase (Preparar → Entender → Implementar → Testar → Validar → Commit);
  - o que o agente está fazendo agora e por quê;
  - o plano com progresso;
  - os arquivos e as **funções, ferramentas e testes que ele está escrevendo**;
  - a linha do tempo com o motivo de cada ação;
  - os testes, os tokens e as rodadas de reparo;
- **revisa e aceita**: vê o diff de cada commit da branch `self-improve` e faz o merge com um clique.

As rodadas antigas ficam no histórico e podem ser reabertas.

## SDD e auto-melhoria

O `docs/SDD.md` é o documento de design: visão, arquitetura, regras de qualidade e o **backlog** de melhorias.
O próprio rfcode implementa esse backlog num loop:

```powershell
npm run self-improve -- --iterations 3            # ou: rfcode --self-improve --iterations 3
npm run self-improve -- --task T05 --model z-ai/glm-5.3
```
No VS Code, use `Ctrl+Shift+P` → **rfcode: Auto-melhoria (loop do SDD)**.

Como o loop funciona:
- trabalha numa git worktree separada (branch `self-improve`), então a versão instalada não é afetada;
- usa só as ferramentas de código, sem controle do PC;
- só pode rodar testes e comandos git de leitura;
- não pode editar os testes de base, o SDD nem o próprio script;
- uma tarefa só vira commit se `npm test` passar e o número de testes não diminuir;
- uma tarefa que falha duas vezes é marcada `[!]` para revisão humana;
- **nunca faz push nem merge.** Para revisar: `git log --stat main..self-improve`. Para aceitar: `git merge self-improve`.

O log de cada rodada fica em `.self-improve/log.md`. Para acrescentar tarefas, edite a seção 7 do SDD no `main` e faça commit. A cada rodada, o loop junta as novidades de `main` na branch `self-improve`.

## Modelos testados (com tool calling)

- `nvidia/nemotron-3-super-120b-a12b`: padrão, rápido
- `z-ai/glm-5.3`: mais forte em código, mais lento
- `openai/gpt-oss-20b`: muito rápido

## Estrutura

```
lib/agent.js         núcleo: ferramentas de código, streaming da API e loop do agente
lib/pc.js, pc.ps1    controle do PC (Windows)
bin/rfcode.js        CLI
extension/           extensão do VS Code
media/               interface do painel (webview) e ícones
```
