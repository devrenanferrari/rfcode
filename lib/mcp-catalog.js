'use strict';
// Conectores prontos: /mcp add <id>. Cada um diz o que precisa (variáveis/segredos) e onde conseguir.
// Segredos usam {{NOME}}: o valor vem da variável de ambiente ou de "secrets" no ~/.rfcode/config.json.

const CATALOG = [
  { id: 'github', name: 'GitHub', desc: 'repositórios, issues, pull requests, Actions e código (servidor oficial remoto)',
    config: { type: 'http', url: 'https://api.githubcopilot.com/mcp/', tokenCommand: 'gh auth token', keywords: ['github', 'issue', 'pull request'] },
    needs: 'GitHub CLI logado ("gh auth login"); ou troque tokenCommand por headers: { "Authorization": "Bearer {{GITHUB_TOKEN}}" } com um token pessoal.' },
  { id: 'powerbi', name: 'Power BI (local)', desc: 'cria e altera modelos semânticos: tabelas, colunas, medidas DAX, relacionamentos, RLS; roda e valida DAX. Funciona com Power BI Desktop, PBIP (TMDL) e Fabric',
    config: { command: 'npx', args: ['-y', '@microsoft/powerbi-modeling-mcp@latest', '--start'], keywords: ['power bi', 'powerbi', 'dax', 'pbix', 'pbip', 'medida', 'modelo semântico'], timeout: 300000 },
    needs: 'Node.js. Na primeira chamada o servidor pede para aceitar a licença (ferramenta accept_eula). Login Microsoft interativo; para automação use --authmode=serviceprincipal com AZURE_CLIENT_ID, AZURE_TENANT_ID e AZURE_CLIENT_SECRET.' },
  { id: 'powerbi-remoto', name: 'Power BI (hospedado)', desc: 'mesmas operações de modelagem direto nos workspaces do Fabric, sem instalar nada (prévia)',
    config: { type: 'http', url: 'https://api.fabric.microsoft.com/v1/mcp/powerbi/authoring', tokenCommand: 'az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv', keywords: ['power bi', 'fabric', 'dax'] },
    needs: 'Azure CLI logado ("az login") e permissão de escrita no modelo semântico.' },
  { id: 'fabric-iq', name: 'Fabric IQ', desc: 'perguntas em linguagem natural sobre os modelos do Power BI, respeitando RLS',
    config: { type: 'http', url: 'https://fabriciq.svc.cloud.microsoft/v1/mcp/FabricIQ', tokenCommand: 'az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv', keywords: ['fabric', 'power bi'] },
    needs: 'Azure CLI logado ("az login") e Fabric IQ habilitado no tenant.' },
  { id: 'microsoft-docs', name: 'Microsoft Learn', desc: 'documentação oficial da Microsoft (Azure, .NET, Power BI, M365), sem chave',
    config: { type: 'http', url: 'https://learn.microsoft.com/api/mcp', trust: true, keywords: ['microsoft', 'azure', '.net', 'docs'] }, needs: 'nada' },
  { id: 'context7', name: 'Context7', desc: 'documentação atualizada de bibliotecas e frameworks para programar', config: { type: 'http', url: 'https://mcp.context7.com/mcp', trust: true, keywords: ['documentação', 'biblioteca', 'framework'] }, needs: 'nada (limite gratuito)' },
  { id: 'postgres', name: 'PostgreSQL', desc: 'consulta bancos PostgreSQL (somente leitura)', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-postgres', '{{POSTGRES_URL}}'], keywords: ['postgres', 'banco', 'sql'] },
    needs: 'POSTGRES_URL, ex.: postgresql://usuario:senha@host:5432/banco' },
  { id: 'sqlite', name: 'SQLite', desc: 'lê e altera um banco SQLite', config: { command: 'uvx', args: ['mcp-server-sqlite', '--db-path', '{{SQLITE_PATH}}'] }, needs: 'uv (Python) e SQLITE_PATH' },
  { id: 'jira', name: 'Jira e Confluence', desc: 'issues, sprints, comentários e páginas do Confluence (Atlassian Cloud ou Server)',
    config: { command: 'uvx', args: ['mcp-atlassian'], env: { JIRA_URL: '{{JIRA_URL}}', JIRA_USERNAME: '{{JIRA_USERNAME}}', JIRA_API_TOKEN: '{{JIRA_API_TOKEN}}', CONFLUENCE_URL: '{{CONFLUENCE_URL}}', CONFLUENCE_USERNAME: '{{JIRA_USERNAME}}', CONFLUENCE_API_TOKEN: '{{JIRA_API_TOKEN}}' }, keywords: ['jira', 'confluence', 'sprint', 'ticket'] },
    needs: 'uv (Python), JIRA_URL, JIRA_USERNAME, JIRA_API_TOKEN (id.atlassian.com → Segurança → Tokens de API) e CONFLUENCE_URL' },
  { id: 'notion', name: 'Notion', desc: 'páginas, bancos de dados e busca no Notion', config: { command: 'npx', args: ['-y', '@notionhq/notion-mcp-server'], env: { NOTION_TOKEN: '{{NOTION_TOKEN}}' }, keywords: ['notion'] },
    needs: 'NOTION_TOKEN de uma integração interna (notion.so/my-integrations), com as páginas compartilhadas com ela' },
  { id: 'slack', name: 'Slack', desc: 'canais, mensagens e threads', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-slack'], env: { SLACK_BOT_TOKEN: '{{SLACK_BOT_TOKEN}}', SLACK_TEAM_ID: '{{SLACK_TEAM_ID}}' }, keywords: ['slack', 'canal'] },
    needs: 'SLACK_BOT_TOKEN (xoxb-...) de um app Slack e SLACK_TEAM_ID' },
  { id: 'stripe', name: 'Stripe', desc: 'clientes, pagamentos, assinaturas e faturas', config: { command: 'npx', args: ['-y', '@stripe/mcp', '--tools=all', '--api-key={{STRIPE_SECRET_KEY}}'], keywords: ['stripe', 'pagamento', 'fatura'] },
    needs: 'STRIPE_SECRET_KEY (prefira uma chave restrita)' },
  { id: 'supabase', name: 'Supabase', desc: 'tabelas, SQL, migrações e logs de um projeto Supabase', config: { command: 'npx', args: ['-y', '@supabase/mcp-server-supabase@latest', '--read-only'], env: { SUPABASE_ACCESS_TOKEN: '{{SUPABASE_ACCESS_TOKEN}}' }, keywords: ['supabase'] },
    needs: 'SUPABASE_ACCESS_TOKEN (supabase.com/dashboard/account/tokens); tire --read-only para permitir alterações' },
  { id: 'playwright', name: 'Playwright', desc: 'navegador automatizado da Microsoft (alternativa ao navegador embutido)', config: { command: 'npx', args: ['-y', '@playwright/mcp@latest'] }, needs: 'Node.js' },
  { id: 'filesystem', name: 'Arquivos', desc: 'acesso a outra pasta do computador', config: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '{{PASTA}}'] }, needs: 'PASTA: caminho da pasta liberada' },
];

module.exports = { CATALOG };
