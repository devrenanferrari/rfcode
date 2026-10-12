'use strict';
// Provedores de modelo. Todos falam a API de chat da OpenAI (chat/completions com streaming e ferramentas),
// então o agente só precisa saber o endereço, a chave e algumas diferenças de parâmetros.
//
// Um modelo é identificado como "provedor:modelo" (ex.: "groq:llama-3.3-70b-versatile").
// Sem prefixo, vale o provedor padrão (NVIDIA), para manter compatibilidade com as configurações antigas.

const PROVIDERS = {
  nvidia: {
    name: 'NVIDIA (build.nvidia.com)', baseUrl: 'https://integrate.api.nvidia.com/v1', env: 'NVIDIA_API_KEY', keyHint: 'nvapi-',
    keyUrl: 'https://build.nvidia.com', free: true, freeNote: 'gratuito para desenvolvimento, cerca de 40 pedidos por minuto',
    // testados com chamada de ferramentas (out/2026); /models nvidia lista todos
    models: [
      // a ordem também é a preferência de reserva quando o principal atinge o limite de pedidos;
      // o número é a força usada pelo modo auto para comparar modelos de todos os provedores
      ['moonshotai/kimi-k3', 'Kimi K3: o melhor nos testes do rfcode (padrão)', 92],
      ['z-ai/glm-5.3', 'GLM 5.3: bom em tarefas longas, mais lento', 88],
      ['nvidia/nemotron-3-ultra-550b-a55b', 'o maior da NVIDIA, raciocínio', 86],
      ['nvidia/nemotron-3-super-120b-a12b', 'rápido, bom com ferramentas', 76],
      ['poolside/laguna-xs-2.1', 'especializado em código (às vezes sobrecarregado)', 70],
      ['nvidia/nemotron-3.5-lightning-30b-a3b', 'muito rápido, tarefas simples', 55],
      ['z-ai/glm-5.3-flash', 'GLM 5.3 rápido', 62],
      ['openai/gpt-oss-20b', 'leve, tarefas simples', 50],
      ['meta/muse-glimmer-30b', 'Meta, uso geral', 58],
    ],
  },
  openrouter: {
    name: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', env: 'OPENROUTER_API_KEY', keyHint: 'sk-or-',
    keyUrl: 'https://openrouter.ai/keys', headers: { 'HTTP-Referer': 'https://github.com/devrenanferrari/rfcode', 'X-Title': 'rfcode' },
    free: true, freeNote: 'modelos terminados em :free sem custo (limite diário de pedidos)',
    models: [['openrouter/auto', 'escolhe o modelo automaticamente', 0], ['openai/gpt-oss-120b:free', 'gratuito, bom com ferramentas', 73], ['openai/gpt-oss-120b', 'código aberto, pago e estável', 74]],
  },
  groq: {
    name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', env: 'GROQ_API_KEY', keyHint: 'gsk_', keyUrl: 'https://console.groq.com/keys', free: true,
    freeNote: 'gratuito com limites por minuto e por dia, respostas muito rápidas',
    models: [['openai/gpt-oss-120b', 'muito rápido', 74], ['llama-3.3-70b-versatile', 'rápido, uso geral', 60]],
  },
  openai: {
    name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', env: 'OPENAI_API_KEY', keyHint: 'sk-', keyUrl: 'https://platform.openai.com/api-keys',
    tokenParam: 'max_completion_tokens',
    models: [['gpt-4.1', 'uso geral', 80], ['gpt-4.1-mini', 'rápido e barato', 62]],
  },
  anthropic: {
    name: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com/v1', env: 'ANTHROPIC_API_KEY', keyHint: 'sk-ant-',
    keyUrl: 'https://console.anthropic.com/settings/keys', usage: false,
    models: [['claude-sonnet-5-5', 'equilíbrio entre qualidade e custo', 95], ['claude-haiku-4-5', 'rápido e barato', 68]],
  },
  gemini: {
    name: 'Google Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', env: 'GEMINI_API_KEY', keyHint: 'AIza',
    keyUrl: 'https://aistudio.google.com/apikey', free: true, usage: false, freeNote: 'camada gratuita do Google AI Studio (limites por minuto e por dia)',
    models: [['gemini-2.5-flash', 'rápido, camada gratuita', 70], ['gemini-2.5-pro', 'mais capaz', 85]],
  },
  deepseek: {
    name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', env: 'DEEPSEEK_API_KEY', keyHint: 'sk-', keyUrl: 'https://platform.deepseek.com/api_keys',
    models: [['deepseek-chat', 'uso geral, barato', 78]],
  },
  mistral: {
    name: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', env: 'MISTRAL_API_KEY', keyUrl: 'https://console.mistral.ai/api-keys', usage: false,
    free: true, freeNote: 'plano Experiment gratuito (limites baixos)',
    models: [['mistral-large-latest', 'mais capaz', 72], ['mistral-small-latest', 'rápido', 55]],
  },
  cerebras: {
    name: 'Cerebras', baseUrl: 'https://api.cerebras.ai/v1', env: 'CEREBRAS_API_KEY', keyHint: 'csk-', keyUrl: 'https://cloud.cerebras.ai',
    free: true, freeNote: 'camada gratuita com cota diária de tokens, a inferência mais rápida', usage: false,
    models: [['gpt-oss-120b', 'muito rápido, bom com ferramentas', 74], ['llama3.1-8b', 'leve', 30]],
  },
  github: {
    name: 'GitHub Models', baseUrl: 'https://models.github.ai/inference', env: ['GITHUB_TOKEN', 'GH_TOKEN'], keyCommand: 'gh auth token',
    keyUrl: 'https://github.com/settings/personal-access-tokens', free: true, usage: false,
    freeNote: 'gratuito com limites diários; usa o login do GitHub CLI (gh) ou um token com permissão models:read',
    models: [['openai/gpt-4.1', 'GPT-4.1', 80], ['openai/gpt-4.1-mini', 'rápido', 62], ['deepseek/DeepSeek-V3-0324', 'DeepSeek V3', 77]],
  },
  huggingface: {
    name: 'Hugging Face', baseUrl: 'https://router.huggingface.co/v1', env: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'], keyHint: 'hf_', keyUrl: 'https://huggingface.co/settings/tokens',
    free: true, freeNote: 'créditos mensais gratuitos, acesso a muitos modelos abertos', usage: false,
    models: [['openai/gpt-oss-120b', 'bom com ferramentas', 74], ['moonshotai/Kimi-K2-Instruct', 'Kimi K2', 76], ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'Qwen3 Coder', 79]],
  },
  sambanova: {
    name: 'SambaNova', baseUrl: 'https://api.sambanova.ai/v1', env: 'SAMBANOVA_API_KEY', keyUrl: 'https://cloud.sambanova.ai/apis',
    free: true, freeNote: 'camada gratuita com limites por minuto', usage: false,
    models: [['Meta-Llama-3.3-70B-Instruct', 'uso geral', 60], ['DeepSeek-V3-0324', 'DeepSeek V3', 77]],
  },
  cohere: {
    name: 'Cohere', baseUrl: 'https://api.cohere.ai/compatibility/v1', env: ['COHERE_API_KEY', 'CO_API_KEY'], keyUrl: 'https://dashboard.cohere.com/api-keys',
    free: true, freeNote: 'chave de teste gratuita (uso não comercial, limite mensal)', usage: false,
    models: [['command-a-03-2025', 'Command A', 65], ['command-r7b-12-2024', 'rápido', 35]],
  },
  cloudflare: {
    name: 'Cloudflare Workers AI', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1', env: ['CLOUDFLARE_API_TOKEN'],
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens', needsAccount: 'CLOUDFLARE_ACCOUNT_ID',
    free: true, freeNote: 'cota diária gratuita; pede o Account ID da Cloudflare', usage: false,
    models: [['@cf/meta/llama-3.3-70b-instruct-fp8-fast', 'Llama 3.3 70B', 60], ['@cf/openai/gpt-oss-120b', 'gpt-oss-120b', 74]],
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
const keyCmdCache = new Map();
function keyFromCommand(cmd) {
  if (!keyCmdCache.has(cmd)) {
    let v = '';
    try { v = require('child_process').execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8000, windowsHide: true }).trim(); } catch { /* sem login */ }
    keyCmdCache.set(cmd, v);
  }
  return keyCmdCache.get(cmd);
}
function keyFor(provider, cfg = {}, { command = true } = {}) {
  const p = PROVIDERS[provider];
  if (!p) return '';
  const keys = cfg.keys || {};
  if (keys[provider]) return keys[provider];
  for (const e of [].concat(p.env || [])) if (process.env[e]) return process.env[e];
  if (provider === 'nvidia') return cfg.apiKey || '';
  // GitHub Models aproveita o login do GitHub CLI
  if (command && p.keyCommand && (cfg.useKeyCommand || {})[provider] !== false) return keyFromCommand(p.keyCommand);
  return '';
}

function baseUrlFor(provider, cfg = {}) {
  const custom = (cfg.baseUrls || {})[provider];
  // ${VAR} no endereço (ex.: Account ID da Cloudflare) vem de cfg.vars ou da variável de ambiente
  const url = String(custom || PROVIDERS[provider].baseUrl || '').replace(/\$\{([A-Z0-9_]+)\}/g, (m, n) => (cfg.vars || {})[n] || process.env[n] || '');
  return /\/accounts\/\/|\/\/\//.test(url.replace(/^https?:\/\//, '')) ? '' : url.replace(/\/+$/, '');
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

// Modelos que aceitam reasoning_effort na API compatível com a OpenAI. Nos outros o esforço muda só
// a escolha do modelo (modo auto) e as instruções do agente; mandar o parâmetro poderia dar erro 400.
function supportsEffort(ep) {
  if (ep.provider === 'openai') return /^(o\d|gpt-5)/.test(ep.model);
  if (ep.provider === 'gemini') return /^gemini-(2\.5|[3-9])/.test(ep.model);
  return /gpt-oss/.test(ep.model);
}

// Corpo da requisição com as diferenças de cada provedor. effort: low | medium | high (medium = padrão do modelo).
function requestBody(ep, { messages, tools, maxTokens = 8192, temperature = 0.3, stream = true, effort }) {
  const body = { model: ep.model, messages, stream };
  if (tools && tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
  body[ep.tokenParam] = maxTokens;
  // modelos de raciocínio da OpenAI (o1, o3, gpt-5...) não aceitam temperature
  if (!(ep.provider === 'openai' && /^(o\d|gpt-5)/.test(ep.model))) body.temperature = temperature;
  if (stream && ep.usage) body.stream_options = { include_usage: true };
  if (effort && effort !== 'medium' && EFFORTS.includes(effort) && supportsEffort(ep)) body.reasoning_effort = effort;
  return body;
}

// ---------- modo auto ----------
// "auto" não é um modelo: o agente escolhe a cada passo o melhor modelo disponível entre os provedores
// configurados e troca sozinho quando um atinge o limite de pedidos (429) ou para de responder.
const AUTO = 'auto';
const EFFORTS = ['low', 'medium', 'high'];

// Candidatos do modo auto, do mais forte ao mais fraco. config.autoModels define a lista à mão.
// Sem ela: todos os modelos sugeridos dos provedores com chave, pela nota de força (terceiro item de
// cada modelo em PROVIDERS); no empate, a ordem dos provedores (NVIDIA primeiro, gratuita).
function autoCandidates(cfg = {}) {
  if (Array.isArray(cfg.autoModels) && cfg.autoModels.length) {
    return cfg.autoModels.filter((m) => { try { endpoint(m, cfg); return true; } catch { return false; } });
  }
  const out = [];
  for (const [id, p] of Object.entries(PROVIDERS)) {
    if (p.local || id === 'custom' || (p.needsKey !== false && !keyFor(id, cfg, { command: false }))) continue;
    for (const [m, , strength] of p.models) if (strength > 0) out.push({ id: formatModel(id, m), strength });
  }
  return out.sort((a, b) => b.strength - a.strength).map((x) => x.id);
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
    // keyCommand (gh) não conta como configurado sozinho: evita listar o GitHub para quem nunca pediu
    .filter(([id, p]) => !p.local && (id === 'custom' ? !!baseUrlFor(id, cfg) : !!keyFor(id, cfg, { command: (cfg.useKeyCommand || {})[id] === true })))
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
  AUTO, EFFORTS, autoCandidates, supportsEffort, listModels, detectLocal, validateKey, configuredProviders, explainError,
};
