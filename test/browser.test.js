'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Browser, findChrome, browserMustConfirm, browserNeedsApproval, browserDescribe } = require('../lib/browser');
const { compactHistory, systemPrompt } = require('../lib/agent');

test('browser: só ações que mudam algo pedem aprovação', () => {
  assert.ok(browserNeedsApproval({ action: 'click', ref: 1 }));
  assert.ok(browserNeedsApproval({ action: 'type', ref: 1, text: 'x' }));
  assert.ok(browserNeedsApproval({ action: 'open', url: 'https://x.dev' }));
  assert.ok(!browserNeedsApproval({ action: 'read' }));
  assert.ok(!browserNeedsApproval({ action: 'scroll' }));
});

test('browser: botões de enviar/pagar/excluir exigem confirmação mesmo no auto', () => {
  const fake = { label: (ref) => ({ 1: 'botão "Enviar candidatura"', 2: 'botão "Próximo"', 3: 'botão "Submit application"', 4: 'link "Excluir conta"' }[ref] || '') };
  assert.ok(browserMustConfirm({ action: 'click', ref: 1 }, fake));
  assert.ok(!browserMustConfirm({ action: 'click', ref: 2 }, fake));
  assert.ok(browserMustConfirm({ action: 'click', ref: 3 }, fake));
  assert.ok(browserMustConfirm({ action: 'click', ref: 4 }, fake));
  assert.ok(!browserMustConfirm({ action: 'read' }, fake));
  assert.match(browserDescribe({ action: 'click', ref: 1 }, fake), /Browser\(click \[1\] botão "Enviar candidatura"\)/);
});

test('compactHistory encurta só saídas antigas e barulhentas', () => {
  const big = 'x'.repeat(5000);
  const msgs = [{ role: 'user', content: 'oi' }];
  for (let i = 0; i < 7; i++) {
    msgs.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'browser', arguments: '{}' } }] });
    msgs.push({ role: 'tool', tool_call_id: 'c' + i, name: 'browser', content: big });
  }
  msgs.push({ role: 'tool', tool_call_id: 'r', name: 'read_file', content: big });
  const out = compactHistory(msgs);
  const tools = out.filter((m) => m.role === 'tool' && m.name === 'browser');
  assert.ok(tools[0].content.length < 1000, 'antiga encurtada');
  assert.match(tools[0].content, /saída antiga encurtada/);
  assert.strictEqual(tools[6].content.length, 5000, 'recente intacta');
  assert.strictEqual(out[out.length - 1].content.length, 5000, 'read_file nunca é encurtado');
  assert.strictEqual(msgs[2].content.length, 5000, 'o histórico original não muda');
  assert.strictEqual(out.length, msgs.length);
});

test('o prompt ensina o navegador só quando a ferramenta existe', () => {
  assert.match(systemPrompt(process.cwd(), { pc: false, browser: true }), /Navegador \(ferramenta browser\)/);
  assert.doesNotMatch(systemPrompt(process.cwd(), { pc: false, browser: false }), /Navegador \(ferramenta browser\)/);
});

const PAGE = `<!doctype html><html><head><title>Vagas teste</title></head><body>
<h1>Vagas</h1>
<div id="list" style="height:120px;overflow:auto">${Array.from({ length: 30 }, (_, i) => `<p><a href="#v${i}">Vaga ${i}</a></p>`).join('')}</div>
<button id="abrir" onclick="document.getElementById('dlg').hidden=false">Candidatura simplificada</button>
<div id="dlg" role="dialog" hidden>
  <h2>Candidatar-se</h2>
  <label>Telefone <input id="tel" required></label>
  <label>Nível <select id="nivel"><option value="">Escolha</option><option value="jr">Júnior</option><option value="sr">Sênior</option></select></label>
  <label><input type="radio" name="remoto" value="sim" style="opacity:0;position:absolute"> Aceito remoto</label>
  <button onclick="document.title='ENVIADO '+document.getElementById('tel').value+' '+document.getElementById('nivel').value+' '+(document.querySelector('[name=remoto]').checked?'remoto':'')">Enviar candidatura</button>
</div>
</body></html>`;

const chrome = findChrome();
test('browser: preenche e envia um formulário de verdade (Chrome headless)', { skip: !chrome && 'Chrome não encontrado', timeout: 60000 }, async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(PAGE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rfcode-browser-'));
  const b = new Browser({ port: 9400 + Math.floor(Math.random() * 400), profile, headless: true });
  const ref = (snap, re) => { const m = new RegExp(`\\[(\\d+)\\] ${re}`).exec(snap); assert.ok(m, `não achei ${re} em:\n${snap}`); return +m[1]; };
  try {
    let snap = await b.run({ action: 'open', url: `http://127.0.0.1:${server.address().port}/` });
    assert.match(snap, /Página: Vagas teste/);
    assert.match(snap, /# Vagas/);
    assert.doesNotMatch(snap, /Telefone/, 'diálogo escondido não aparece');

    // rolar a lista pelo ref de um item
    snap = await b.run({ action: 'scroll', ref: ref(snap, 'link "Vaga 0"'), direction: 'down' });
    assert.match(snap, /rolou a lista/);

    snap = await b.run({ action: 'click', ref: ref(snap, 'botão "Candidatura simplificada"') });
    assert.match(snap, /Diálogo aberto/);
    assert.doesNotMatch(snap, /Vaga 0/, 'com diálogo aberto o retrato mostra só ele');
    assert.match(snap, /campo "Telefone" \(obrigatório\)/);

    snap = await b.run({ action: 'type', ref: ref(snap, 'campo "Telefone"'), text: '11 99999-0000' });
    assert.match(snap, /campo "Telefone" = "11 99999-0000"/);
    snap = await b.run({ action: 'select', ref: ref(snap, 'seleção "Nível"'), value: 'Sênior' });
    assert.match(snap, /Selecionado Sênior/);
    snap = await b.run({ action: 'click', ref: ref(snap, 'radio "Aceito remoto"') });
    assert.match(snap, /radio "Aceito remoto" \[marcado\]/);

    const send = ref(snap, 'botão "Enviar candidatura"');
    assert.ok(browserMustConfirm({ action: 'click', ref: send }, b), 'enviar exige confirmação');
    snap = await b.run({ action: 'click', ref: send });
    assert.match(snap, /Página: ENVIADO 11 99999-0000 sr remoto/);

    assert.match(await b.run({ action: 'tabs' }), /ENVIADO/);
  } finally {
    await b.quit();
    server.close();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome ainda soltando arquivos */ }
  }
});
