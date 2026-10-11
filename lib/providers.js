'use strict';
// Provedores de modelo. Todos falam a API de chat da OpenAI (chat/completions com streaming e ferramentas),
// então o agente só precisa saber o endereço, a chave e algumas diferenças de parâmetros.
//
// Um modelo é identificado como "provedor:modelo" (ex.: "groq:llama-3.3-70b-versatile").
// Sem prefixo, vale o provedor padrão (NVIDIA), para manter compatibilidade com as configurações antigas.

const PROVIDERS = {
  nvidia: {
    name: 'NVIDIA (build.nvidia.com)', baseUrl: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY', keyHint: 'nvapi-',
    keyUrl: 'https://build.nvidia.com', free: true,
    models: [
      ['nvidia/nemotron-3-super-120b-a12b', 'rápido, bom com ferramentas (padrão)'],
      ['z-ai/glm-5.3', 'melhor em tarefas longas, mais lento'],
      ['openai/gpt-oss-20b', 'muito rápido, tarefas simples'],
      ['nvidia/nemotron-3-ultra-550b-a55b', 'grande, lento'],
    ],
  },
  openrouter: {
    name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', keyHint: 'sk-or-',
    keyUrl: 'https://openrouter.ai/keys', headers: { 'HTTP-Referer': 'https://github.com/devrenanferrari/rfcode', 'X-Title': 'rfcode' },
    models: [['openrouter/auto', 'escolhe o modelo automaticamente'], ['openai/gpt-oss-120b', 'código aberto, bom com ferramentas']],
  },
  groq: {
    name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', keyHint: 'gsk_', keyUrl: 'https://console.groq.com/keys', free: true,
    models: [['openai/gpt-oss-120b', 'muito rápido'], ['llama-3.3-70b-versatile', 'rápido, uso geral']],
  },
  openai: {
    name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', keyHint: 'sk-', keyUrl: 'https://platform.openai.com/api-keys',
    tokenParam: 'max_completion_tokens',
    models: [['gpt-4.1', 'uso geral'], ['gpt-4.1-mini', 'rápido e barato']],
  },
  anthropic: {
    name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', env: 'ANTHROPIC_API_KEY', keyHint: 'sk-ant-',
    keyUrl: 'https://console.anthropic.com/settings/keys', usage: false,
    models: [['claude-sonnet-5-5', 'equilíbrio entre qualidade e custo'], ['claude-haiku-4-5', 'rápido e barato']],
  },
  gemini: {
    name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', keyHint: 'AIza',
    keyUrl: 'https://aistudio.google.com/apikey', free: true, usage: false,
    models: [['gemini-2.5-flash', 'rápido, camada gratuita'], ['gemini-2.5-pro', 'mais capaz']],
  },
  deepseek: {
    name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', keyHint: 'sk-', keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [['deepseek-chat', 'uso geral, barato']],
  },
  mistral: {
    name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys', usage: false,
    models: [['mistral-large-latest', 'mais capaz'], ['mistral-small-latest', 'rápido']],
  },
  ollama: {
    name: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', local: true, needsKey: false, usage: false, free: true,
    models: [['qwen3:8b', 'roda no PC, sem internet']],
  },
  lmstudio: {
    name: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', local: true, needsKey: false, usage: false, free: true,
    models: [],
  },
  custom: {
    name: 'Personalizado (compatível com OpenAI)', baseUrl: '', env: 'RFCODE_CUSTOM_API_KEY', needsKey: false,
    models: [],
  },
};

const DEFAULT_PROVIDER = 'nvidia';
const DEFAULT_MODEL = PROVIDERS.nvidia.models[0][0];

// "groq:llama-3.3-70b" -> { provider: 'groq', model: 'llama-3.3-70b' }. Só o primeiro ":" separa
// (modelos do Ollama e do OpenRouter também usam ":"). Sem prefixo conhecido, é da NVIDIA.
function parseModel(spec) {
  const s = String(spec || DEFAULT_MODEL).trim();
  const i = s.indexOf(':');
  if (i > 0 && PROVIDERS[s.slice(0, i)]) return { provider: s.slice(0, i), model: s.slice(i + 1) };
  return { provider: DEFAULT_PROVIDER, model: s };
}

const formatModel = (provider, model) => (provider === DEFAULT_PROVIDER ? model : `${provider}:${model}`);

// Chave do provedor: config.keys[provedor] > variável de ambiente > (NVIDIA) apiKey antigo do config.
function keyFor(provider, cfg = {}) {
  const p = PROVIDERS[provider];
  if (!p) return '';
  const keys = cfg.keys || {};
  if (keys[provider]) return keys[provider];
  if (p.env && process.env[p.env]) return process.env[p.env];
  if (provider === 'nvidia') return cfg.apiKey || '';
  return '';
}

function baseUrlFor(provider, cfg = {}) {
  const custom = (cfg.baseUrls || {})[provider];
  return String(custom || PROVIDERS[provider].baseUrl || '').replace(/\/+$/, '');
}

// Tudo o que o agente precisa para chamar o modelo.
function endpoint(spec, cfg = {}) {
  const { provider, model } = parseModel(spec);
  const p = PROVIDERS[provider];
  const key = keyFor(provider, cfg);
  const baseUrl = baseUrlFor(provider, cfg);
  if (!baseUrl) throw new Error(`Configure o endereço do provedor "${provider}" (/provider ${provider}).`);
  if (p.needsKey !== false && !key) throw new Error(`Falta a API key de ${p.name}. Use /provider ${provider} para configurar.`);
  const headers = { 'Content-Type': 'application/json', ...(p.headers || {}) };
  if (key) headers.Authorization = `Bearer ${key}`;
  return { provider, model, name: p.name, url: `${baseUrl}/chat/completions`, baseUrl, headers, tokenParam: p.tokenParam || 'max_tokens', usage: p.usage !== false };
}

// Corpo da requisição com as diferenças de cada provedor.
function requestBody(ep, { messages, tools, maxTokens = 8192, temperature = 0.3, stream = true }) {
  const body = { model: ep.model, messages, stream };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  body[ep.tokenParam] = maxTokens;
  // modelos de raciocínio da OpenAI (o1, o3, gpt-5...) não aceitam temperature
  if (!(ep.provider === 'openai' && /^(o\d|gpt-5)/.test(ep.model))) body.temperature = temperature;
  if (stream && ep.usage) body.stream_options = { include_usage: true };
  return body;
}

// Lista os modelos que o provedor oferece (GET /models). [] se não der.
async function listModels(provider, cfg = {}, { timeout = 8000 } = {}) {
  try {
    const ep = endpoint(formatModel(provider, 'x'), cfg);
    const res = await fetch(`${ep.baseUrl}/models`, { headers: ep.headers, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.data || j.models || []).map((m) => String(m.id || m.name || '').replace(/^models\//, '')).filter(Boolean).sort();
  } catch { return []; }
}

// Servidores locais ligados agora (Ollama, LM Studio).
async function detectLocal() {
  const out = [];
  for (const id of ['ollama', 'lmstudio']) {
    const models = await listModels(id, {}, { timeout: 600 });
    if (models.length) out.push({ provider: id, models });
  }
  return out;
}

// 'ok' | 'invalid' | 'offline'
async function validateKey(provider, key, cfg = {}) {
  const p = PROVIDERS[provider];
  if (!p) return 'invalid';
  try {
    const res = await fetch(`${baseUrlFor(provider, cfg)}/models`, {
      headers: { ...(p.headers || {}), ...(key ? { Authorization: `Bearer ${key}` } : {}) },
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) return 'invalid';
    // a NVIDIA lista modelos sem exigir chave: confirma com uma chamada mínima
    if (provider === 'nvidia') {
      const r = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'openai/gpt-oss-20b', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
        signal: AbortSignal.timeout(30000),
      });
      return r.status === 401 || r.status === 403 ? 'invalid' : 'ok';
    }
    return 'ok';
  } catch {
    return 'offline';
  }
}

// Provedores na nuvem prontos para uso (com chave) e os modelos sugeridos de cada um.
// Os locais (Ollama, LM Studio) entram só quando detectLocal() os encontra rodando.
function configuredProviders(cfg = {}) {
  return Object.entries(PROVIDERS)
    .filter(([id, p]) => !p.local && (id === 'custom' ? !!baseUrlFor(id, cfg) : !!keyFor(id, cfg)))
    .map(([id, p]) => ({ id, name: p.name, models: p.models.map(([m, d]) => ({ id: formatModel(id, m), desc: d })) }));
}

// Mensagem amigável para erros comuns de API (modelo aposentado, sem crédito, limite).
function explainError(status, body, ep) {
  const text = String(body || '');
  if (status === 401 || status === 403) return `Chave inválida ou sem acesso ao modelo ${ep.model} em ${ep.name} (${status}). Troque a chave com /provider ${ep.provider} ou escolha outro modelo.`;
  if (status === 404 || status === 410 || /not found|does not exist|end of life|deprecated|decommission/i.test(text)) {
    return `O modelo "${ep.model}" não está disponível em ${ep.name} (pode ter sido aposentado). Escolha outro com /models.`;
  }
  if (status === 402 || /insufficient|credit|quota|billing/i.test(text)) return `Sem crédito ou cota em ${ep.name}. Verifique a conta do provedor ou troque de modelo.`;
  return null;
}

module.exports = {
  PROVIDERS, DEFAULT_PROVIDER, DEFAULT_MODEL, parseModel, formatModel, keyFor, baseUrlFor, endpoint, requestBody,
  listModels, detectLocal, validateKey, configuredProviders, explainError,
};
