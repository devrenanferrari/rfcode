# Changelog

## 1.14.1

- Missões: conclusão reconhecida mesmo com markdown ("**MISSÃO CONCLUÍDA**"); o diário descreve as últimas ações quando o ciclo termina no limite de passos; o limite de passos deixa de aparecer como erro; estado ao vivo no /missao status durante o ciclo; opção --passos.
- Navegador: reconecta sozinho quando a conexão com o Chrome cai; leituras e navegação são repetidas, cliques e digitação não (para não enviar duas vezes).
- Vídeo: espera a página ficar pronta antes de injetar o gravador (falhava em máquinas lentas).

## 1.14.0

- Missões: tarefas longas (até dias) em segundo plano, em ciclos com contexto limpo e estado salvo em disco, commits de segurança numa branch própria, computador acordado, espera e nova tentativa em falhas de rede, detecção de ciclos sem progresso e conclusão só depois de verificar. Comandos `/missao` e `rfcode missao`.
- Agendamentos em português ("dias úteis às 8h", "toda segunda às 14h", "a cada 30 minutos", "amanhã às 7h") pelo Agendador de Tarefas do Windows ou pelo cron. Comando `/agendar`.
- Dashboards interativos em um único HTML, sem internet: indicadores, gráficos SVG, tabelas com ordenação e busca, filtros e exportação. Abrem ao lado do chat no VS Code ou no navegador.
- Inteligência de código: mapa de símbolos em 12 linguagens, definição, referências, leitura de um símbolo, grafo de dependências com impacto e busca por significado com embeddings da NVIDIA. Comando `/entender`.
- Skills no formato SKILL.md (compatível com o Claude Code), carregadas sob demanda ou por palavra-chave. Comando `/skills`.
- Login OAuth nos conectores MCP remotos (descoberta, registro automático e PKCE), `/mcp login` e 16 novos conectores oficiais verificados: Notion, Linear, Atlassian, Sentry, Asana, Stripe, Vercel, Canva, Figma, PayPal, Intercom, monday.com, Webflow, Cloudflare, Supabase e Zapier.
- Modo automação: `rfcode -p` com `--json`, `--output`, `--max-steps`, entrada por pipe e código de saída 1 em erro; GitHub Action para revisar pull requests e corrigir testes (docs/AUTOMACAO.md).
- `/uso` com os tokens por dia, semana, mês, modelo e pasta; `/export` salva a conversa em Markdown.

## 1.13.0

- Conectores MCP (stdio, HTTP e SSE) no formato do Claude Code e do VS Code, com catálogo pronto: GitHub, Power BI (servidor oficial da Microsoft), Fabric IQ, Microsoft Learn, Context7, PostgreSQL, SQLite, Jira e Confluence, Notion, Slack, Stripe, Supabase, Playwright. Comando `/mcp`.
- `data_query`: SQL direto em CSV, Excel, JSON e SQLite, com descrição das colunas e gravação do resultado em Excel.
- `create_xlsx`: planilhas Excel formatadas (cabeçalho, filtro, formatos, fórmulas e totais) e leitura de Excel com datas e números.
- Git completo: branches, push e pull, stash, merge e rebase com conflitos, show, blame e GitHub (pull requests, issues, Actions). Comandos `/commit` e `/pr`.
- `http_request` para APIs REST, com segredos por referência ({{NOME}}) escondidos nas respostas.
- Recursos para empresas: política gerenciada pela TI, auditoria em JSON, hooks antes de ferramentas, depois de edições e ao terminar.
- Guias de uso (Power BI, dados, git, APIs, conectores) que entram no prompt só quando o assunto aparece.
- Novos provedores gratuitos: Cerebras, GitHub Models, Hugging Face, SambaNova, Cohere e Cloudflare Workers AI. Novos modelos da NVIDIA testados, entre eles Kimi K3.
- Configuração: provedores gratuitos primeiro, primeira execução sem exigir a chave da NVIDIA e comando `/config`.
- Regra `**/arquivo` passa a valer também na raiz do projeto.
- Resiliência: texto corrompido do provedor é descartado, erros dentro do stream aparecem, o limite de pedidos (429) é respeitado com esperas maiores e, se o modelo continuar falhando, a tarefa segue num modelo reserva (`fallbackModels`).
- Kimi K3 passa a ser o modelo padrão da NVIDIA, depois de ser o mais eficiente nas tarefas de referência.
- create_pptx aceita mais variações de formato enviadas pelos modelos (sinônimos de campos, JSON em spec_file).

## 1.12.0

- Apresentações com gráficos nativos do PowerPoint, editáveis: colunas, empilhado, empilhado 100%, barras, linha, pizza, rosca e cascata, com rótulos diretos, seta de CAGR e seta de diferença.
- Diagramas: processo, linha do tempo, funil, pirâmide, matriz 2x2 com pontos, ciclo, cartões, hub, Venn, tamanho de mercado (TAM/SAM/SOM), tabela e agenda.
- Conclusão em destaque, fonte e notas do apresentador em qualquer slide; variação nos indicadores; temas consultoria e papel.
- Revisão automática do roteiro: aponta slides só de texto, títulos que não dizem a conclusão, falta de fontes e gráficos repetidos.
- create_pptx aceita a apresentação em arquivo JSON (spec_file) e corrige formatos comuns enviados pelo modelo; tipos desconhecidos geram erro claro em vez de slide em branco.
- Ferramentas carregadas sob demanda: PowerPoint, navegador, vídeo e controle do PC entram só quando o pedido precisa, reduzindo cerca de 3 mil tokens por chamada.
- Arquivo não encontrado sugere nomes parecidos da mesma pasta.
- Comandos no Windows gravam e leem em UTF-8 (redirecionamento com > e saída do Python).
- Correção de JSON com colchetes trocados ou sobrando.

## 1.11.0

- Gestão de contexto: compactação incremental antes de cada chamada ao modelo (também no meio de tarefas longas), mantendo literal o trecho recente e sem separar ações dos seus resultados.
- O resumo sabe qual é a tarefa em andamento e preserva os dados que ela precisa; pedido atual, plano, anotações, arquivos alterados e processos em segundo plano entram no resumo sem depender do modelo.
- Ferramenta `note` para anotações de trabalho que nunca são resumidas.
- Recuperação automática quando a API recusa por excesso de contexto, usando o limite informado no erro.
- Janela de contexto por provedor e por modelo, configurável em `contextWindow` e `contextWindows`.
- O rodapé mostra a ocupação do contexto, além do total de tokens.
- O plano sai da barra fixa ao fim da resposta e fica guardado na conversa.

## 1.10.0

- Vários provedores de modelo: NVIDIA, OpenRouter, Groq, OpenAI, Anthropic, Gemini, DeepSeek, Mistral, Ollama, LM Studio e servidores compatíveis com a API da OpenAI (`/provider`, `/models`).
- Seletor de modelos agrupado por provedor, com detecção de Ollama e LM Studio.
- Conversas salvas a cada passo; tarefas interrompidas podem ser retomadas ao reabrir o VS Code ou o terminal.
- Mensagens enviadas durante o trabalho entram em fila e são consideradas no passo seguinte.
- `/doctor` e `rfcode --doctor` para diagnóstico do ambiente.
- Log de erros em `~/.rfcode/logs/rfcode.log`, sem chaves de API.
- Mensagens claras para chave recusada, modelo aposentado e falta de crédito.
- Guia de contribuição, política de segurança, modelos de issue e análise CodeQL.

## 1.9.1

- Revisão dos textos da extensão, do terminal e da documentação.
- Comandos agrupados na categoria rfcode da paleta de comandos.

## 1.9.0

- Nova interface no terminal: logo, informações de modelo e pasta, indicador de progresso, formatação de markdown e resumo de uso ao final de cada resposta.
- Corrigido travamento na exibição de caminhos muito longos.
- Publisher alterado para `renanferrari`.

## 1.8.1

- Capturas de tela no README.
- Nome de exibição alterado para "rfcode".
- Testes automatizados em Windows, Linux e macOS e publicação de releases pelo GitHub Actions.

## 1.8.0

- Pesquisa na web (`web_search`) com DuckDuckGo e Bing, filtro de relevância e suporte opcional à Brave Search API.
- Subagentes (`task`) para pesquisas em arquivos, git, documentos e web.
- Perguntas ao usuário com opções (`ask_user`).
- Memória entre conversas (`remember`, `/memory`) em `~/.rfcode/MEMORIA.md`.
- Regras de permissão (`allow`/`deny`) e opção Sempre permitir no pedido de aprovação.
- Visualização do diff no editor antes da aprovação.
- Diagnósticos do VS Code como ferramenta (`get_diagnostics`).
- Processos em segundo plano (`command_output`, `command_stop`).
- Resumo automático de conversas longas, nova tentativa em respostas vazias e leitura paginada de páginas longas.

## 1.7.1

- Tela inicial simplificada.

## 1.6.2

- O cartão do controle remoto é fechado quando o celular se conecta.
- Removido o aviso de firewall exibido quando não é possível verificar as regras.

## 1.6.1

- Controle remoto: o QR code passa a usar o endereço da rede principal, ignorando adaptadores virtuais.
- Porta fixa 7433 e opção para liberar a porta no firewall do Windows.

## 1.6.0

- Comandos `/` no painel com autocompletar: `/help`, `/new`, `/history`, `/model`, `/auto`, `/undo`, `/plan`, `/go`, `/init`, `/review`, `/compact`, `/remote` e `/key`.
- Comandos personalizados em `.rfcode/commands/` e `~/.rfcode/commands/`.
- Modo plano (`/plan`, `/go`).
- Controle remoto pelo celular na rede local.
- `/compact` para resumir a conversa.
- Os mesmos comandos no terminal.

## 1.5.0

- Histórico de conversas no painel, com busca.
- Geração de PowerPoint e Word; leitura de PDF, Word, PowerPoint e Excel.
- Geração de vídeos narrados.
- `multi_edit`, correção de argumentos JSON inválidos e CSV compatível com o Excel.

## 1.4.0

- Ferramenta de navegador (Chrome DevTools Protocol), com confirmação obrigatória para envios, pagamentos e exclusões.
- Redução do uso de contexto em tarefas longas.

## 1.3.0

- Novo painel de chat: tela inicial com sugestões, cartões de ação, diffs, plano fixo e botão de copiar código.
