# rfcode nas empresas

Guia para usar o rfcode em equipe: conectar sistemas da empresa, controlar o que o agente pode fazer e auditar o que ele fez.

## Visão geral

| Recurso | Para quê | Onde configura |
| --- | --- | --- |
| Conectores (MCP) | GitHub, Power BI, Jira, Confluence, Notion, Slack, bancos de dados e qualquer servidor MCP | `/mcp`, `mcp.json` |
| APIs REST | Sistemas internos, ERPs e CRMs sem conector pronto | ferramenta `http_request` + `secrets` |
| Dados | SQL direto em CSV, Excel, JSON e SQLite | ferramenta `data_query` |
| Regras | Liberar o que é seguro e bloquear o que não pode | `settings.json` |
| Hooks | Rodar lint/testes depois de editar, bloquear ações, avisar ao terminar | `settings.json` |
| Política | Regras da TI que o usuário não consegue mudar | `policy.json` da máquina |
| Auditoria | Registro de cada ação do agente | `~/.rfcode/logs/auditoria-AAAA-MM.jsonl` |
| Instruções do projeto | Convenções que o agente segue | `RFCODE.md` (ou `AGENTS.md`, `CLAUDE.md`) |

Use `/config` para ver tudo que está ativo e onde fica cada arquivo.

## Conectores (MCP)

O rfcode fala MCP (Model Context Protocol), o mesmo padrão do Claude Code, VS Code e Cursor. Ele lê, nesta ordem:

1. `~/.rfcode/mcp.json` (seus conectores)
2. `.rfcode/mcp.json` no projeto
3. `.mcp.json` no projeto (formato do Claude Code)
4. `.vscode/mcp.json` no projeto (formato do VS Code)

Conectores prontos (`/mcp add <id>`):

| id | Sistema | O que precisa |
| --- | --- | --- |
| `github` | GitHub (servidor oficial remoto) | GitHub CLI logado (`gh auth login`) |
| `powerbi` | Power BI: modelos semânticos, medidas DAX, relacionamentos, RLS (servidor oficial da Microsoft, local) | Node.js; Power BI Desktop aberto, pasta PBIP ou workspace do Fabric |
| `powerbi-remoto` | Power BI hospedado no Fabric | Azure CLI logado (`az login`) |
| `fabric-iq` | Perguntas sobre os modelos do Power BI | Azure CLI logado e Fabric IQ habilitado |
| `microsoft-docs` | Documentação da Microsoft | nada |
| `context7` | Documentação de bibliotecas | nada |
| `postgres` | PostgreSQL (leitura) | `POSTGRES_URL` |
| `sqlite` | SQLite | uv e `SQLITE_PATH` |
| `jira` | Jira e Confluence | uv, `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`, `CONFLUENCE_URL` |
| `notion` | Notion | `NOTION_TOKEN` |
| `slack` | Slack | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` |
| `stripe` | Stripe | `STRIPE_SECRET_KEY` |
| `supabase` | Supabase | `SUPABASE_ACCESS_TOKEN` |
| `playwright` | Navegador automatizado | Node.js |
| `filesystem` | Outra pasta do computador | `PASTA` |

Formato do arquivo:

```json
{
  "mcpServers": {
    "erp": {
      "command": "npx",
      "args": ["-y", "@empresa/erp-mcp"],
      "env": { "ERP_TOKEN": "{{ERP_TOKEN}}" },
      "keywords": ["pedido", "nota fiscal"]
    },
    "crm": {
      "type": "http",
      "url": "https://mcp.empresa.com/crm",
      "headers": { "Authorization": "Bearer {{CRM_TOKEN}}" }
    },
    "github": {
      "type": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "tokenCommand": "gh auth token"
    }
  }
}
```

- `command` + `args` + `env`: servidor local (stdio). `type: "http"` + `url` + `headers`: servidor remoto. `type: "sse"` para servidores antigos.
- `tokenCommand`: o token vem de um comando (`gh auth token`, `az account get-access-token ...`) e não fica gravado.
- `keywords`: palavras que fazem o rfcode carregar as ferramentas desse conector quando há muitos conectores.
- `trust: true`: dispensa aprovação para todas as ferramentas do conector. Sem isso, só as ferramentas marcadas como leitura rodam sem aprovação.
- `timeout`: tempo máximo por chamada, em milissegundos (padrão 180000).

Comandos: `/mcp` (estado e catálogo), `/mcp add <id>` (ou `/mcp add <nome> <comando|URL>`), `/mcp add <id> projeto` (grava no projeto), `/mcp tools [nome]`, `/mcp remove <nome>`, `/mcp reload`.

### Power BI na prática

1. `/mcp add powerbi` e abra o relatório no Power BI Desktop.
2. Peça, por exemplo: "conecte no meu Power BI aberto, revise as medidas e crie medidas de receita acumulada no ano e variação contra o ano anterior".
3. Na primeira vez o servidor pede para aceitar a licença da Microsoft; o rfcode pergunta antes.
4. O rfcode lê o modelo, cria as medidas com formato e pasta, valida com consultas DAX e mostra os números para você conferir.

Sem o conector, o rfcode ainda ajuda: prepara as tabelas no formato estrela com `data_query` (salvas em Excel), escreve as medidas DAX, edita projetos PBIP (TMDL) e gera o tema JSON do relatório.

## Segredos

Tokens nunca vão na conversa. Use `{{NOME}}` em conectores e em `http_request`; o valor vem de:

1. `"secrets"` em `~/.rfcode/config.json`: `{ "secrets": { "ERP_TOKEN": "..." } }`
2. variável de ambiente com o mesmo nome

As respostas das APIs são exibidas com o segredo trocado por `***`.

## Regras de permissão

`~/.rfcode/settings.json` (vale para tudo) e `.rfcode/settings.json` (só o projeto):

```json
{
  "allow": [
    "run_command:npm test*",
    "run_command:git status",
    "http_request:GET https://api.empresa.com/**",
    "mcp__jira__jira_get_issue",
    "github:pr_view"
  ],
  "deny": [
    "run_command:rm -rf*",
    "write_file:**/.env",
    "http_request:DELETE **"
  ]
}
```

`deny` sempre vence `allow`. `*` não atravessa `/`; `**` atravessa.

## Hooks

```json
{
  "hooks": {
    "postEdit": [{ "command": "npx eslint --fix \"$RFCODE_FILE\"", "files": "\\.(js|ts)$" }],
    "preTool": [{ "match": "run_command", "command": "node scripts/valida-comando.js" }],
    "onDone": ["powershell -c \"[console]::beep(800,200)\""]
  }
}
```

- `preTool`: roda antes da ferramenta (`match` aceita nomes separados por `|` e `*`). Recebe o evento em JSON na entrada padrão. Saindo com código 2, a ação é bloqueada e a mensagem de erro vai para o agente.
- `postEdit`: roda depois de cada edição de arquivo (`files` filtra por expressão regular). Se falhar, a saída vai para o agente corrigir.
- `onDone`: roda ao fim de cada tarefa (notificação, relatório, sincronização).
- Variáveis disponíveis: `RFCODE_TOOL`, `RFCODE_FILE`, `RFCODE_EVENT`.

## Política da empresa

Arquivo da máquina, administrado pela TI:

- Windows: `C:\ProgramData\rfcode\policy.json`
- macOS: `/Library/Application Support/rfcode/policy.json`
- Linux: `/etc/rfcode/policy.json`
- ou o caminho em `RFCODE_POLICY`

```json
{
  "message": "Política de TI da Empresa X",
  "allowedProviders": ["nvidia", "ollama"],
  "disabledTools": ["browser", "pc", "create_video"],
  "allowedMcpServers": ["github", "jira", "powerbi"],
  "deny": ["run_command:*curl*", "http_request:* https://*.externo.com/**"],
  "disableAutoApprove": true,
  "audit": true,
  "auditDir": "\\\\servidor\\auditoria\\rfcode",
  "hooks": { "preTool": [{ "match": "run_command", "command": "C:\\TI\\valida.exe" }] }
}
```

- `allowedProviders`: só esses provedores de modelo funcionam (ex.: só modelos locais).
- `disabledTools`: ferramentas ou grupos (`browser`, `pc`, `office`, `video`, `git`, `api`, `dados`) removidos do agente.
- `allowedMcpServers`: só esses conectores são carregados.
- `deny`: regras somadas às do usuário, que não podem ser liberadas por `allow`.
- `disableAutoApprove`: toda ação que pede aprovação pede sempre, mesmo com `/auto`.
- `audit` e `auditDir`: liga a auditoria e define a pasta (pode ser compartilhada).
- `hooks`: hooks obrigatórios, somados aos do usuário.

## Auditoria

Cada ação vira uma linha JSON em `auditoria-AAAA-MM.jsonl`:

```json
{"ts":"2026-10-11T14:02:11.120Z","user":"maria","host":"NB-123","cwd":"C:\\projetos\\loja","model":"moonshotai/kimi-k3","tool":"run_command","action":"Run(npm test)","approved":true,"error":false,"result":"..."}
```

Chaves e tokens são removidos antes de gravar. Para desligar no seu computador: `"audit": false` no `config.json` (a política da empresa pode obrigar).

## Instruções do projeto

`/init` cria o `RFCODE.md` com o que o agente precisa saber do projeto: comandos de build e teste, estrutura, convenções. O rfcode também lê `AGENTS.md` e `CLAUDE.md`. Vale versionar esse arquivo para o time inteiro.

## Modelos e provedores

`/provider` lista os provedores, com os gratuitos primeiro: NVIDIA, Groq, Gemini, Cerebras, GitHub Models (usa o login do `gh`), OpenRouter (modelos `:free`), Hugging Face, SambaNova, Cohere, Mistral e Cloudflare. Para dados que não podem sair da empresa, use Ollama ou LM Studio (modelo local) e restrinja com `allowedProviders`.
