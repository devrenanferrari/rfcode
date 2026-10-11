# Changelog

## 1.9.0
- Terminal redesenhado: logo em pixel art, cartão com modelo e pasta, spinner com tempo, ações com ícones, diffs coloridos, respostas com markdown formatado e resumo de tokens e tempo.
- Corrige travamento do banner em pastas com caminho muito longo.
- Publicado no VS Code Marketplace como renanferrari.rfcode.

## 1.8.1
- Prints da extensão no README e na página do Marketplace.
- Nome de exibição sem marcas de terceiros.
- Testes automáticos em Windows, Linux e macOS e publicação automática a cada versão (GitHub Actions).

## 1.8.0
- **Pesquisa na internet** (`web_search`) sem chave: DuckDuckGo, Bing e Chrome com filtro de relevância; Brave Search API opcional.
- **Subagentes** (`task`): pesquisas amplas em arquivos, git, documentos e web, sem encher o contexto principal.
- **Perguntas com botões** (`ask_user`) quando a decisão é do usuário.
- **Memória** entre conversas (`remember`, `/memory`), guardada em ~/.rfcode/MEMORIA.md.
- **Regras de permissão** (allow/deny) e botão "Sempre permitir" no cartão de aprovação.
- **Ver diff** no editor antes de aprovar edições.
- **Diagnósticos do VS Code** como ferramenta (`get_diagnostics`).
- **Comandos em segundo plano** (servidores, watch) com `command_output` e `command_stop`.
- Resumo automático de conversas longas, nova tentativa quando o modelo responde vazio e leitura de páginas longas por partes.

## 1.7.1
- Tela inicial mais limpa: só a logo e o título (sem o subtítulo).

## 1.6.2
- O cartão do QR code some quando o celular conecta (o ícone de celular no topo mostra de novo).
- Sem permissão para ler o firewall, o rfcode não acusa mais bloqueio falso; mostra só um link de ajuda.

## 1.6.1
- Controle remoto: o QR code usa o IP da rede de verdade (antes podia pegar o adaptador do VirtualBox).
- Porta fixa 7433 e botão "Liberar no firewall" quando o Windows bloqueia o celular (regra só para essa porta e só para a rede local).

## 1.6.0
- Comandos com `/` no painel, com menu de autocompletar: `/help`, `/new`, `/history`, `/model`, `/auto`, `/undo`, `/plan`, `/go`, `/init`, `/review`, `/compact`, `/remote` e `/key`.
- Comandos personalizados em `.rfcode/commands/<nome>.md` (projeto) e `~/.rfcode/commands/` (usuário).
- Modo plano: o agente investiga e propõe um plano sem alterar nada; `/go` executa.
- Controle remoto pelo celular na rede local, com QR code, aprovações sincronizadas e o mesmo painel do VS Code.
- `/compact` resume a conversa para liberar contexto.
- Os mesmos comandos novos na CLI.

## 1.5.0
- Histórico de conversas no painel, com busca e reabertura.
- Criação de PowerPoint e Word, e leitura de PDF, Word, PowerPoint e Excel.
- Vídeos narrados com legendas, emoji e imagens.
- `multi_edit`, conserto automático de JSON quebrado e CSV com acentos corretos no Excel.

## 1.4.0
- Ferramenta de navegador (Chrome DevTools Protocol), com confirmação obrigatória para enviar, pagar ou excluir.
- Economia de contexto em tarefas longas.

## 1.3.0
- Painel de chat redesenhado: tela inicial com sugestões, cartões de ação, diffs, plano fixo e botão de copiar código.
