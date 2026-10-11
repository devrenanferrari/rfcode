'use strict';
// Gestão da janela de contexto. Estratégia (detalhes em docs/CONTEXT.md):
// 1. medir: tokens reais da última chamada (prompt_tokens) + estimativa do que entrou depois;
// 2. compactar cedo: ao passar de COMPACT_AT da janela, antes de qualquer chamada, inclusive no meio de uma tarefa;
// 3. compactação incremental: resume só a parte antiga e mantém o trecho recente intacto (KEEP_RECENT da janela),
//    sem separar uma ação do seu resultado; o resumo anterior entra no novo;
// 4. estado determinístico: pedido atual, plano, arquivos alterados e processos em andamento entram no resumo
//    sem depender do modelo;
// 5. estouro mesmo assim (erro de contexto da API): compacta de forma agressiva e tenta de novo.

const { parseModel } = require('./providers');

const COMPACT_AT = 0.65;
const KEEP_RECENT = 0.3;
const SUMMARY_PREFIX = 'Resumo da conversa até aqui (compactada automaticamente para caber no contexto):';

// Janela de contexto em tokens. Config: contextWindow (número) ou contextWindows["provedor:modelo"].
const WINDOWS = [
  [/^openai:gpt-4\.1/, 1000000], [/^openai:gpt-5/, 400000], [/^openai:o\d/, 200000], [/^openai:/, 128000],
  [/^anthropic:/, 200000],
  [/^gemini:/, 1000000],
  [/^deepseek:/, 64000],
  [/^(ollama|lmstudio):/, 8192], // servidores locais costumam carregar o modelo com contexto pequeno
  [/^custom:/, 32768],
  [/./, 128000], // NVIDIA, OpenRouter, Groq, Mistral e o resto
];

function contextWindow(model, cfg = {}) {
  const { provider, model: id } = parseModel(model);
  const full = `${provider}:${id}`;
  const per = cfg.contextWindows || {};
  if (per[full] || per[model]) return +(per[full] || per[model]);
  if (+cfg.contextWindow > 0) return +cfg.contextWindow;
  return WINDOWS.find(([re]) => re.test(full))[1];
}

// Estimativa simples: ~3,6 caracteres por token em texto misto (português, código, JSON).
const estimateTokens = (value) => Math.ceil(JSON.stringify(value || '').length / 3.6);

// Erro de excesso de contexto costuma trazer o limite real ("maximum context length is 8192 tokens").
function windowFromError(message) {
  const a = /(\d{4,7})\s*tokens?\s*>\s*(\d{4,7})\s*maximum/i.exec(String(message || '')); // formato da Anthropic
  if (a) return +a[2];
  const m = /(?:maximum context length|context (?:length|window)[^0-9]{0,40}|limit(?: of)?)\D{0,20}(\d{4,7})\s*tokens/i.exec(String(message || ''));
  return m ? +m[1] : 0;
}

// Onde cortar: tudo antes de `index` vira resumo; o trecho final (cerca de keepTokens) fica intacto.
// O corte só cai numa mensagem do usuário ou do assistente (nunca entre uma ação e o resultado dela).
// keepTokens = 0: resume tudo (comando /compact). Devolve -1 se não há o que resumir.
function splitPoint(messages, keepTokens) {
  if (keepTokens <= 0) return messages.length >= 2 ? messages.length : -1;
  // mantém do fim para o começo enquanto couber; uma mensagem que estouraria o limite fica de fora (vai para o resumo)
  let acc = 0, i = messages.length;
  while (i > 0) {
    const t = estimateTokens(messages[i - 1]);
    if (acc + t > keepTokens && i < messages.length) break;
    acc += t;
    i--;
  }
  // resultados de ferramenta ficam junto da chamada que os gerou: o corte avança até o próximo começo válido
  while (i < messages.length && messages[i].role === 'tool') i++;
  if (i <= 1 || i >= messages.length) return -1;
  return i;
}

const isRealUser = (m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[') && !m.content.startsWith(SUMMARY_PREFIX);

// Estado que não pode se perder na compactação. Montado a partir do agente, sem passar pelo modelo.
function stateNote(agent, head) {
  const parts = [];
  const lastReal = [...head].reverse().find(isRealUser);
  if (lastReal) parts.push(`Pedido do usuário mais recente antes deste ponto (literal):\n${lastReal.content.split('\n--- Begin file:')[0].slice(0, 4000)}`);
  if (agent.notes && agent.notes.length) parts.push(`Anotações de trabalho (registradas com a ferramenta note, literais):\n${agent.notes.map((n) => '- ' + n).join('\n')}`);
  if (agent.plan && agent.plan.steps && agent.plan.steps.length) {
    const icon = { done: '[x]', in_progress: '[>]', pending: '[ ]' };
    parts.push(`Plano atual: ${agent.plan.goal || ''}\n${agent.plan.steps.map((s) => `${icon[s.status] || '[ ]'} ${s.text}`).join('\n')}`);
  }
  if (agent.touched && agent.touched.size) parts.push(`Arquivos criados ou alterados nesta conversa: ${[...agent.touched].slice(-60).join(', ')}`);
  const bg = agent.bg ? [...agent.bg.entries()].filter(([, b]) => !b.done) : [];
  if (bg.length) parts.push(`Comandos rodando em segundo plano: ${bg.map(([id, b]) => `${id} (${b.command})`).join('; ')}`);
  return parts.length ? `\n\n## Estado registrado pelo rfcode\n${parts.join('\n\n')}` : '';
}

// Prompt de resumo com a tarefa em andamento: o resumo preserva exatamente o que ela vai precisar.
function compactPrompt(task) {
  const t = task ? `Tarefa em andamento (pedido do usuário): "${String(task).split('\n--- Begin file:')[0].slice(0, 1500)}"\n`
    + 'Preserve literalmente todos os dados que podem ser necessários para concluí-la: números, valores, trechos, nomes, caminhos e resultados parciais.\n\n' : '';
  return t + COMPACT_PROMPT;
}

const COMPACT_PROMPT = `Resuma a conversa acima para que o trabalho continue sem perder nada importante. Se houver um resumo anterior no começo, incorpore-o.
Use exatamente estas seções, em tópicos curtos e densos:
## Pedidos e objetivo
## Decisões e preferências do usuário
## O que já foi feito (arquivos, comandos e resultados, com caminhos)
## Informações importantes (nomes, valores, erros encontrados, endereços)
## Estado atual e próximos passos
Não chame ferramentas. Não invente nada que não esteja na conversa.`;

module.exports = { COMPACT_AT, KEEP_RECENT, SUMMARY_PREFIX, COMPACT_PROMPT, compactPrompt, contextWindow, estimateTokens, windowFromError, splitPoint, stateNote, isRealUser };
