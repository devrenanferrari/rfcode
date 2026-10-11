# rfcode — agente de IA gratuito para código e automação

[![Testes](https://github.com/devrenanferrari/rfcode/actions/workflows/ci.yml/badge.svg)](https://github.com/devrenanferrari/rfcode/actions/workflows/ci.yml)

O rfcode é um agente de IA que roda **de graça** com os modelos de [build.nvidia.com](https://build.nvidia.com). Ele lê e edita o seu projeto, roda testes, usa git, pesquisa na internet, cria **PowerPoint, Word e vídeos narrados**, navega em sites e opera programas do Windows. Ele sempre pede a sua aprovação antes de mudar qualquer coisa.

> **English:** free AI coding agent for VS Code powered by NVIDIA's free models. Edits code, runs tests, searches the web, creates slides, documents and narrated videos, browses websites and can be controlled from your phone. UI in Brazilian Portuguese.

| Conversa com ações, diff e plano | Comandos com `/` | Perguntas e aprovação |
|---|---|---|
| ![Conversa](docs/img/conversa.png) | ![Comandos](docs/img/comandos.png) | ![Assistente](docs/img/assistente.png) |

## Instalar

- **Pelo VS Code:** procure **rfcode** na aba de extensões (`Ctrl+Shift+X`).
- **Pelo arquivo:** baixe o `.vsix` mais recente em [Releases](https://github.com/devrenanferrari/rfcode/releases) e rode `code --install-extension rfcode.vsix` (ou, no VS Code, `...` na aba de extensões → **Install from VSIX**).

## Começar em 1 minuto

1. Abra o rfcode pelo ícone na barra lateral.
2. Crie uma chave grátis em [build.nvidia.com](https://build.nvidia.com) → **Get API Key** (começa com `nvapi-`).
3. Cole a chave quando o rfcode pedir. Ela fica no armazenamento seguro do VS Code.
4. Peça o que quiser: *"explique este projeto"*, *"escreva testes para o módulo de login"*, *"crie uma apresentação de 8 slides sobre este projeto"*.

## O que ele faz

| | |
|---|---|
| **Código** | lê, procura, edita (inclusive várias edições atômicas num arquivo), roda comandos e testes, usa git, desfaz alterações |
| **Documentos** | cria PowerPoint com design pronto (5 temas, 8 tipos de slide), Word a partir de markdown, e lê PDF, Word, PowerPoint e Excel |
| **Vídeos** | cria vídeos animados com narração em português e legendas (narração no Windows). Sai em WebM, ou em MP4 se o ffmpeg estiver instalado |
| **Pesquisa** | pesquisa na internet sozinho e cita as fontes; para pesquisas grandes, manda **subagentes** investigarem e trabalha a partir do relatório |
| **Web** | abre um Chrome próprio, lê a página como texto e clica, preenche e navega. Botões de enviar, pagar ou excluir sempre pedem confirmação |
| **Assistente** | lembra das suas preferências entre conversas (`/memory`), pergunta com botões quando a decisão é sua e resume conversas longas sozinho |
| **Dev** | lê os erros e avisos do VS Code, mostra o **diff no editor** antes de você aprovar, roda servidores em segundo plano e aprende regras do tipo "sempre permitir `npm test`" |
| **PC (Windows)** | lista e controla janelas, lê a tela por OCR local, clica em botões, digita e usa atalhos. Nenhuma imagem da tela sai do computador |
| **Celular** | controle remoto pelo celular na mesma rede Wi-Fi, com QR code |

## Comandos com `/`

Digite `/` no campo de mensagem para ver a lista. Use as setas para escolher e Enter ou Tab para confirmar.

| Comando | O que faz |
|---|---|
| `/help` | lista os comandos |
| `/new` | começa uma conversa nova (também `/clear`) |
| `/history` | abre o histórico de conversas (também `/resume`) |
| `/model [id]` | mostra ou troca o modelo |
| `/auto` | liga ou desliga a aprovação automática |
| `/undo` | desfaz a última alteração de arquivo do agente |
| `/plan <pedido>` | **modo plano**: investiga e propõe um plano sem alterar nada |
| `/go` | aprova o plano e executa |
| `/init` | cria o `RFCODE.md` com as instruções do projeto |
| `/review` | revisa o `git diff` atual em busca de bugs |
| `/compact` | resume a conversa para liberar contexto |
| `/memory [texto]` | mostra o que o rfcode lembra sobre você, ou guarda um texto |
| `/remote` | liga o controle remoto pelo celular |
| `/key` | troca a API key |

**Comandos seus:** crie `.rfcode/commands/<nome>.md` no projeto (ou `~/.rfcode/commands/` para todos os projetos) com o texto do pedido. `$ARGUMENTS` é trocado pelo que você escrever depois do comando. Uma primeira linha `description: ...` aparece no menu.

```markdown
description: Escreve testes para um arquivo
Escreva testes para $ARGUMENTS seguindo o padrão de testes deste projeto e rode a suíte.
```

## Controle remoto pelo celular

<img src="docs/img/controle-remoto.png" width="380" alt="Cartão do controle remoto com QR code">

1. Digite `/remote` (ou `Ctrl+Shift+P` → **rfcode: Controle remoto pelo celular**).
2. Leia o QR code com a câmera do celular, que precisa estar **no mesmo Wi-Fi** do PC.
3. No celular aparece o mesmo painel: você conversa, aprova ações, vê o plano, abre o histórico e usa os comandos `/`. Tudo fica sincronizado com o VS Code.

Na primeira vez o Windows pode pedir para liberar o acesso à rede: escolha **Redes privadas**. O link tem um token secreto, e quem tiver o link controla o rfcode no PC, então não compartilhe. Para desligar, use **Desligar** no cartão do QR code ou clique em *rfcode remoto* na barra de status.

## Histórico

Toda conversa é salva. O ícone de relógio no topo do painel lista as conversas por data, com busca. Um clique reabre a conversa exatamente como estava, e você continua de onde parou.

## Segurança

- Edições, comandos, commits, criação de arquivos e ações no PC ou em sites mostram um cartão com **Permitir**, **Sempre** e **Negar**.
- O modo **Auto** aprova tudo, exceto enviar, pagar, excluir ou publicar em sites, que sempre pedem confirmação.
- O agente não instala programas sem você pedir e trata o conteúdo de arquivos e páginas como dado, não como ordem.
- Automatizar ações em sites pode violar os termos de uso deles (o LinkedIn, por exemplo, proíbe bots). Use com moderação.

## Regras de permissão

No cartão de aprovação, **Sempre permitir** grava uma regra para aquela ação não pedir mais aprovação. Você também pode escrever as regras em `~/.rfcode/settings.json` (vale para tudo) ou em `.rfcode/settings.json` (só no projeto):

```json
{
  "allow": ["run_command:npm test*", "run_command:git status*", "edit_file:src/**"],
  "deny": ["run_command:rm -rf*", "run_command:git push*"]
}
```
`deny` sempre vence `allow` e bloqueia mesmo no modo Auto.

## Pesquisa na internet

A pesquisa funciona sem chave, usando DuckDuckGo e Bing com filtro de relevância. Se esses buscadores limitarem as pesquisas, o agente pesquisa pelo navegador. Para pesquisas mais confiáveis, crie uma chave grátis da [Brave Search API](https://brave.com/search/api/) (2.000 pesquisas por mês) e coloque em `~/.rfcode/config.json` como `"searchApiKey": "..."`.

## Preencher formulários com os seus dados

Crie `~/.rfcode/perfil.md` com os dados que o agente pode usar em formulários: nome, contato, cidade, experiência, formação, preferências de vaga e respostas padrão. O agente **nunca inventa** dados pessoais: se faltar algo, ele pergunta.

## Modelos

O seletor no topo do painel troca o modelo (ou use `/model`). Modelos testados com ferramentas:
- `nvidia/nemotron-3-super-120b-a12b`: padrão, rápido;
- `z-ai/glm-5.3`: mais forte em tarefas longas e conteúdo, mais lento;
- `openai/gpt-oss-20b`: muito rápido, mais simples.

## CLI

A extensão também traz o rfcode para o terminal: `Ctrl+Shift+P` → **rfcode: Abrir no terminal**. Lá estão os mesmos comandos `/`, e `rfcode -p "tarefa"` roda uma tarefa e sai.

## Configurações

| Configuração | Padrão | O que faz |
|---|---|---|
| `rfcode.model` | `nvidia/nemotron-3-super-120b-a12b` | modelo usado |
| `rfcode.autoApprove` | `false` | aprovar ações sem perguntar |
| `rfcode.remotePort` | `0` | porta do controle remoto (0 = automática) |

## Requisitos

- VS Code 1.90 ou mais novo.
- Navegador e vídeo: Google Chrome ou Microsoft Edge instalado.
- Controle do PC e narração dos vídeos: Windows 10 ou 11.

Se existir `RFCODE.md`, `CLAUDE.md` ou `AGENTS.md` na pasta do projeto, o conteúdo entra como instruções para o agente.

Licença MIT.
