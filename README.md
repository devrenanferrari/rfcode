# rfcode

[![Testes](https://github.com/devrenanferrari/rfcode/actions/workflows/ci.yml/badge.svg)](https://github.com/devrenanferrari/rfcode/actions/workflows/ci.yml)

Agente de IA para VS Code e terminal que usa os modelos gratuitos de [build.nvidia.com](https://build.nvidia.com). Lê e edita projetos, executa comandos e testes, usa git, pesquisa na web, gera documentos e vídeos e automatiza tarefas no Windows. Toda ação que altera arquivos ou o sistema passa por aprovação.

AI agent for VS Code and the terminal, powered by the free models on build.nvidia.com. The interface is in Brazilian Portuguese.

| Conversa | Comandos | Aprovação |
|---|---|---|
| ![Conversa](docs/img/conversa.png) | ![Comandos](docs/img/comandos.png) | ![Aprovação](docs/img/assistente.png) |

## Instalação

Pelo VS Code: procure por rfcode na aba de extensões (`Ctrl+Shift+X`).

Pelo arquivo: baixe o `.vsix` em [Releases](https://github.com/devrenanferrari/rfcode/releases) e instale com `code --install-extension rfcode.vsix`.

Na primeira execução, o rfcode pede uma API key da NVIDIA. Gere a sua em [build.nvidia.com](https://build.nvidia.com) (Get API Key). A chave fica no armazenamento seguro do VS Code.

## Recursos

- Código: leitura, busca, edição (incluindo várias edições atômicas no mesmo arquivo), execução de comandos e testes, git e desfazer.
- Documentos: gera PowerPoint (5 temas, 8 tipos de slide) e Word a partir de markdown; lê PDF, Word, PowerPoint e Excel.
- Vídeo: gera vídeos com narração em português e legendas. Saída em WebM, ou MP4 quando o ffmpeg está instalado.
- Pesquisa: busca na web com citação das fontes e subagentes para pesquisas mais amplas.
- Navegador: controla uma instância própria do Chrome. Envio de formulários, pagamentos e exclusões sempre exigem confirmação.
- Memória: guarda preferências do usuário entre conversas (`/memory`).
- Desenvolvimento: lê os diagnósticos do VS Code, abre o diff no editor antes da aprovação e executa processos em segundo plano.
- Windows: controle de janelas, leitura de tela por OCR local, cliques e teclado. Nenhuma imagem da tela é enviada para fora do computador.
- Controle remoto: uso pelo celular na mesma rede, com pareamento por QR code.

## Comandos

Digite `/` no campo de mensagem para abrir a lista.

| Comando | Descrição |
|---|---|
| `/help` | Lista os comandos |
| `/new` | Inicia uma conversa (alias: `/clear`) |
| `/history` | Abre o histórico (alias: `/resume`) |
| `/model [id]` | Mostra ou troca o modelo |
| `/auto` | Liga ou desliga a aprovação automática |
| `/undo` | Desfaz a última alteração de arquivo |
| `/plan <pedido>` | Investiga e propõe um plano sem alterar nada |
| `/go` | Executa o plano aprovado |
| `/init` | Cria o `RFCODE.md` com as instruções do projeto |
| `/review` | Revisa o `git diff` atual |
| `/compact` | Resume a conversa para liberar contexto |
| `/memory [texto]` | Mostra ou acrescenta itens na memória |
| `/remote` | Liga o controle remoto |
| `/key` | Troca a API key |

Comandos personalizados ficam em `.rfcode/commands/<nome>.md` (projeto) ou `~/.rfcode/commands/` (usuário). O conteúdo do arquivo é o pedido, e `$ARGUMENTS` é substituído pelo texto digitado depois do comando. Uma primeira linha `description: ...` define a descrição exibida no menu.

```markdown
description: Escreve testes para um arquivo
Escreva testes para $ARGUMENTS seguindo o padrão do projeto e execute a suíte.
```

## Controle remoto

<img src="docs/img/controle-remoto.png" width="380" alt="Cartão do controle remoto com QR code">

Execute `/remote` e leia o QR code com o celular conectado à mesma rede. O celular abre o mesmo painel do VS Code, com conversa, aprovações, plano, histórico e comandos sincronizados.

O link contém um token de acesso e dá controle sobre o rfcode no computador. Não o compartilhe. Para desligar, use o botão Desligar no cartão ou o item rfcode remoto na barra de status. Na primeira vez, o Windows pode pedir permissão de rede; escolha Redes privadas.

## Permissões

Edições, comandos, commits, criação de arquivos e ações no navegador ou no Windows exibem um pedido de aprovação. O modo Auto aprova tudo, exceto envios, pagamentos e exclusões em sites.

A opção Sempre permitir, no pedido de aprovação, grava uma regra. As regras também podem ser escritas em `~/.rfcode/settings.json` (todos os projetos) ou `.rfcode/settings.json` (projeto atual):

```json
{
  "allow": ["run_command:npm test*", "run_command:git status*", "edit_file:src/**"],
  "deny": ["run_command:rm -rf*", "run_command:git push*"]
}
```

Regras `deny` têm prioridade sobre `allow` e valem também no modo Auto.

Automatizar ações em sites pode violar os termos de uso de alguns serviços. Verifique antes de usar.

## Pesquisa na web

A pesquisa usa DuckDuckGo e Bing, sem necessidade de chave. Esses serviços podem limitar consultas automatizadas; nesse caso o agente pesquisa pelo navegador. Para mais estabilidade, configure uma chave da [Brave Search API](https://brave.com/search/api/) em `~/.rfcode/config.json` como `"searchApiKey": "..."`.

## Dados para formulários

O arquivo `~/.rfcode/perfil.md` pode conter os dados que o agente usa ao preencher formulários (contato, formação, experiência, preferências). Dados ausentes são solicitados ao usuário, nunca inventados.

## Modelos

O modelo é escolhido no seletor do painel ou com `/model`. Modelos testados com chamadas de ferramenta:

- `nvidia/nemotron-3-super-120b-a12b`: padrão, rápido.
- `z-ai/glm-5.3`: melhor em tarefas longas, mais lento.
- `openai/gpt-oss-20b`: muito rápido, para tarefas simples.

## Terminal

A extensão inclui a versão de terminal: `Ctrl+Shift+P` → rfcode: Abrir no terminal. Os comandos `/` são os mesmos. Para executar uma tarefa e sair: `rfcode -p "tarefa"`.

## Configurações

| Configuração | Padrão | Descrição |
|---|---|---|
| `rfcode.model` | `nvidia/nemotron-3-super-120b-a12b` | Modelo usado |
| `rfcode.autoApprove` | `false` | Aprova ações sem perguntar |
| `rfcode.remotePort` | `7433` | Porta do controle remoto |

Arquivos `RFCODE.md`, `CLAUDE.md` ou `AGENTS.md` na raiz do projeto são lidos como instruções para o agente.

## Requisitos

- VS Code 1.90 ou superior.
- Google Chrome ou Microsoft Edge, para o navegador e a geração de vídeo.
- Windows 10 ou 11, para o controle do sistema e a narração de vídeos.

## Licença

MIT
