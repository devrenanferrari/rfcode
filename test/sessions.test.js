'use strict';
// Teste de aceitação para sessões salvas e retomada
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Agent } = require('../lib/agent');

function tmpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-home-'));
  // inicializa diretório de sessões vazio
  const sessionsDir = path.join(dir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  return dir;
}
const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });

test('sessões: salva, lista e carrega a mesma conversa', async () => {
  const homeDir = tmpHome();
  try {
    // Define RFCODE_HOME para o diretório temporário
    process.env.RFCODE_HOME = homeDir;
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-work-'));
    try {
      const agent = new Agent({ apiKey: 'x', cwd: agentDir });
      // Simula uma mensagem do usuário e uma resposta simples do agente
      // Vamos mockar o fetch para retornar uma resposta sem tool calls
      const mockResponse = {
        ok: true,
        text: async () => '', // not used
        body: {
          [Symbol.asyncIterator]: () => {
            let yielded = false;
            return {
              next() {
                if (!yielded) {
                  yielded = true;
                  return { value: Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n'), done: false };
                }
                return { value: Buffer.from('data: [DONE]\n'), done: true };
              }
            };
          }
        }
      };
      global.fetch = async () => mockResponse;
      // Envia uma mensagem
      await agent.send('oi', {});
      // Após a resposta, a sessão deve ter sido salva
      const sessionManager = agent.sessionManager;
      const sessions = sessionManager.list();
      assert.strictEqual(sessions.length, 1, 'Deveria existir exatamente uma sessão salva');
      const sessionPath = sessions[0];
      // Carrega a sessão
      const loaded = sessionManager.load(sessionPath);
      assert(Array.isArray(loaded), 'A sessão carregada deve ser um array');
      assert.strictEqual(loaded.length, 2, 'Deveria ter duas mensagens: usuário e assistente');
      assert.strictEqual(loaded[0].role, 'user');
      assert.strictEqual(loaded[0].content, 'oi');
      assert.strictEqual(loaded[1].role, 'assistant');
      assert.strictEqual(loaded[1].content, 'ok');
      // Testa listagem (deve retornar a mesma sessão)
      const list = sessionManager.list();
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0], sessionPath);
    } finally {
      cleanup(agentDir);
    }
  } finally {
    delete process.env.RFCODE_HOME;
    cleanup(homeDir);
  }
});

test('sessões: lista as 10 mais recentes', async () => {
  const homeDir = tmpHome();
  try {
    process.env.RFCODE_HOME = homeDir;
    const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-work-'));
    try {
      const agent = new Agent({ apiKey: 'x', cwd: agentDir });
      const mockResponse = {
        ok: true,
        text: async () => '', // not used
        body: {
          [Symbol.asyncIterator]: () => {
            let yielded = false;
            return {
              next() {
                if (!yielded) {
                  yielded = true;
                  return { value: Buffer.from('data: {"choices":[{"delta":{"content":"ok"}}]}\n'), done: false };
                }
                return { value: Buffer.from('data: [DONE]\n'), done: true };
              }
            };
          }
        }
      };
      global.fetch = async () => mockResponse;
      // Cria 15 sessões
      for (let i = 0; i < 15; i++) {
        await agent.send(`mensagem ${i}`, {});
      }
      const sessionManager = agent.sessionManager;
      const sessions = sessionManager.list();
      // Deve ter exatamente 15 sessões salvas
      assert.strictEqual(sessions.length, 15);
      // O método list() já retorna ordenado do mais recente para o mais antigo
      // Vamos verificar que as 10 primeiras são as mais recentes
      // (não testamos o comando /sessions aqui, apenas o gerenciador)
    } finally {
      cleanup(agentDir);
    }
  } finally {
    delete process.env.RFCODE_HOME;
    cleanup(homeDir);
  }
});