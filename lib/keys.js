'use strict';
// Guia de chaves: como obter a chave de cada provedor e de cada ferramenta, e o que já está configurado.
// Usado pela tela inicial do painel, por /chaves no painel e na CLI.

const providers = require('./providers');

const NVIDIA_STEPS = [
  { text: 'Abra build.nvidia.com e entre com sua conta NVIDIA. Se não tiver, crie uma de graça (pode pedir para confirmar o e-mail e o celular).', url: 'https://build.nvidia.com' },
  { text: 'No menu do seu perfil, abra Settings > API Keys e clique em Generate API Key.', url: 'https://build.nvidia.com/settings/api-keys' },
  { text: 'Copie a chave na hora (ela começa com nvapi- e não aparece de novo) e cole aqui.' },
];

// Outros provedores sugeridos na tela inicial: gratuitos primeiro.
const ALTERNATIVES = ['groq', 'gemini', 'openrouter', 'github', 'openai', 'anthropic', 'ollama'];

// Ferramentas que usam chave ou login próprio. Nenhuma é obrigatória.
const TOOL_KEYS = [
  {
    id: 'search', name: 'Pesquisa na web (Brave Search)', configKey: 'searchApiKey', env: 'BRAVE_API_KEY', url: 'https://api-search.brave.com/app/keys',
    why: 'Deixa a pesquisa na web mais estável. Sem ela o rfcode pesquisa pelo DuckDuckGo e pelo Bing.',
    steps: 'Crie a conta em api-search.brave.com, escolha um plano em Subscriptions e copie a chave em API Keys.',
  },
  {
    id: 'github', name: 'GitHub', url: 'https://cli.github.com',
    why: 'Usado em /pr, no conector do GitHub e nos modelos do GitHub Models.',
    steps: 'Instale o GitHub CLI e rode "gh auth login" no terminal. Outra opção é um token em github.com/settings/personal-access-tokens na variável GITHUB_TOKEN.',
  },
  {
    id: 'connectors', name: 'Conectores (Notion, Jira, Slack, Stripe...)', url: '',
    why: 'Cada conector pede o que precisa quando você o adiciona.',
    steps: 'Use /mcp para ver a lista e /mcp add <nome>. Os oficiais só pedem login no navegador (/mcp login <nome>); os outros dizem qual token criar e onde.',
  },
];

function toolConfigured(id, cfg = {}, { env = process.env, cwd = process.cwd() } = {}) {
  if (id === 'search') return !!(env.BRAVE_API_KEY || cfg.searchApiKey);
  if (id === 'github') return !!providers.keyFor('github', cfg, { command: true });
  if (id === 'connectors') return Object.keys(require('./mcp').loadMcpConfig(cwd)).length > 0;
  return false;
}

// Estado de tudo, pronto para a tela: provedores (com link da chave) e ferramentas.
function keysStatus(cfg = {}, { nvidiaKey, cwd } = {}) {
  const nv = nvidiaKey !== undefined ? !!nvidiaKey : !!(cfg.apiKey || process.env.NVIDIA_API_KEY);
  const prov = ['nvidia', ...ALTERNATIVES].map((id) => {
    const p = providers.PROVIDERS[id];
    const ready = id === 'nvidia' ? nv : p.needsKey === false ? null : !!providers.keyFor(id, cfg, { command: false });
    return { id, name: p.name, url: p.keyUrl || '', free: !!p.free, local: !!p.local, note: p.freeNote || (p.local ? 'roda no seu computador' : ''), ready };
  });
  const tools = TOOL_KEYS.map((t) => ({ id: t.id, name: t.name, url: t.url, why: t.why, steps: t.steps, ready: toolConfigured(t.id, cfg, { cwd }), canPaste: !!t.configKey }));
  return { providers: prov, tools, nvidiaSteps: NVIDIA_STEPS };
}

// Texto para a CLI (e para quem prefere ler no chat).
function formatKeysGuide(status) {
  const mark = (r) => (r === true ? '[ok]' : r === null ? '[--]' : '[  ]');
  const lines = ['Modelos de IA (precisa de pelo menos um):'];
  for (const p of status.providers) lines.push(`  ${mark(p.ready)} ${p.name}${p.free ? ' (grátis)' : ''}${p.url ? '  ' + p.url : ''}`);
  lines.push('', 'Como obter a chave da NVIDIA (grátis):');
  status.nvidiaSteps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.text}${s.url ? '  ' + s.url : ''}`));
  lines.push('  Depois use /key. Outros provedores: /provider <nome>.', '', 'Ferramentas (opcionais):');
  for (const t of status.tools) {
    lines.push(`  ${mark(t.ready)} ${t.name}${t.url ? '  ' + t.url : ''}`, `       ${t.why}`, `       ${t.steps}`);
  }
  return lines.join('\n');
}

function saveToolKey(id, key, cfg) {
  const t = TOOL_KEYS.find((x) => x.id === id);
  if (!t || !t.configKey) throw new Error(`A ferramenta ${id} não recebe chave por aqui.`);
  if (key) cfg[t.configKey] = key; else delete cfg[t.configKey];
  return cfg;
}

module.exports = { NVIDIA_STEPS, ALTERNATIVES, TOOL_KEYS, keysStatus, formatKeysGuide, saveToolKey, toolConfigured };
