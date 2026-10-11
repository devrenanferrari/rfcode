'use strict';
// Missões: tarefas longas (horas, um dia inteiro) sem ninguém olhando.
// - Trabalho em ciclos: cada ciclo começa com contexto limpo e recebe do disco o objetivo, o plano, as anotações
//   e o diário dos ciclos anteriores (conversas enormes degradam; o estado em disco não).
// - Processo separado (sobrevive ao fechar o terminal), computador acordado, commits de segurança numa branch própria.
// - Falhas de rede ou do provedor: espera e tenta de novo (até horas), com modelo reserva.
// - Detecta ciclos sem progresso e muda de estratégia; só termina depois de verificar o resultado.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const DONE_MARK = 'MISSÃO CONCLUÍDA';
const dirOf = (cwd) => path.join(cwd, '.rfcode', 'missoes');
const now = () => new Date().toISOString();
const fmtDate = (iso) => new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

// ---------- estado em disco ----------
function create(cwd, { objetivo, horas = 24, modelo, git = true, passosPorCiclo = 120 } = {}) {
  if (!objetivo || !String(objetivo).trim()) throw new Error('Informe o objetivo da missão.');
  const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${crypto.randomBytes(3).toString('hex')}`;
  const dir = path.join(dirOf(cwd), id);
  fs.mkdirSync(dir, { recursive: true });
  const h = Math.max(0.05, Math.min(Number(horas) || 24, 24 * 7));
  const m = {
    id, objetivo: String(objetivo).trim(), cwd, criado: now(), prazo: new Date(Date.now() + h * 3600 * 1000).toISOString(), horas: h,
    status: 'criada', modelo: modelo || null, git: !!git, branch: null, passosPorCiclo,
    ciclos: 0, passos: 0, tokens: 0, semProgresso: 0, plano: null, notas: [], arquivos: [], decisoes: [], pendenciasHumanas: [],
    pid: null, ultimaAtividade: now(), erro: null,
  };
  save(cwd, m);
  fs.writeFileSync(path.join(dir, 'diario.md'), `# Missão ${id}\n\nObjetivo: ${m.objetivo}\nCriada: ${fmtDate(m.criado)}. Prazo: ${fmtDate(m.prazo)}.\n`);
  return m;
}
function save(cwd, m) {
  const dir = path.join(dirOf(cwd), m.id);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, 'missao.json.tmp');
  fs.writeFileSync(tmp, JSON.stringify(m, null, 2));
  fs.renameSync(tmp, path.join(dir, 'missao.json')); // gravação atômica: queda de energia não corrompe
}
function load(cwd, id) {
  const all = list(cwd);
  const m = id ? all.find((x) => x.id === id || x.id.endsWith(id)) : all[0];
  if (!m) throw new Error(id ? `Missão ${id} não encontrada.` : 'Nenhuma missão nesta pasta.');
  return m;
}
function list(cwd) {
  let ids = [];
  try { ids = fs.readdirSync(dirOf(cwd)); } catch { return []; }
  return ids.map((id) => { try { return JSON.parse(fs.readFileSync(path.join(dirOf(cwd), id, 'missao.json'), 'utf8')); } catch { return null; } })
    .filter(Boolean).sort((a, b) => b.criado.localeCompare(a.criado));
}
function journal(cwd, m, text) {
  fs.appendFileSync(path.join(dirOf(cwd), m.id, 'diario.md'), `\n## ${fmtDate(now())}${text.startsWith('\n') ? '' : ' '}${text}\n`);
}
function journalTail(cwd, m, chars = 6000) {
  try { const t = fs.readFileSync(path.join(dirOf(cwd), m.id, 'diario.md'), 'utf8'); return t.length > chars ? '...\n' + t.slice(-chars) : t; } catch { return ''; }
}
const alive = (pid) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

// ---------- computador acordado ----------
function keepAwake() {
  try {
    if (process.platform === 'win32') {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED enquanto este processo existir
      const ps = `$s='[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);';$t=Add-Type -MemberDefinition $s -Name K -Namespace W -PassThru;`
        + `$null=$t::SetThreadExecutionState(0x80000001);while(Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue){Start-Sleep 30};$null=$t::SetThreadExecutionState(0x80000000)`;
      const c = spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true });
      c.unref();
    } else if (process.platform === 'darwin') {
      spawn('caffeinate', ['-i', '-w', String(process.pid)], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('systemd-inhibit', ['--what=sleep', '--why=rfcode missão', 'tail', `--pid=${process.pid}`, '-f', '/dev/null'], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
    }
  } catch { /* opcional */ }
}

// ---------- git ----------
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
function gitSetup(cwd, m) {
  try { git(cwd, ['rev-parse', '--is-inside-work-tree']); } catch { return null; }
  const branch = `rfcode/missao-${m.id}`;
  try {
    const cur = git(cwd, ['branch', '--show-current']);
    if (cur === branch) return branch;
    // guarda o que estava pendente antes de trocar de branch; a missão começa a partir do estado atual
    git(cwd, ['switch', '-c', branch]);
    return branch;
  } catch {
    try { git(cwd, ['switch', branch]); return branch; } catch { return null; }
  }
}
function gitCheckpoint(cwd, m, msg) {
  if (!m.branch) return false;
  try {
    if (git(cwd, ['branch', '--show-current']) !== m.branch) return false;
    git(cwd, ['add', '-A', '--', '.', ':!.rfcode/missoes']);
    if (!git(cwd, ['diff', '--cached', '--name-only'])) return false;
    git(cwd, ['commit', '-q', '-m', msg]);
    return true;
  } catch { return false; }
}

// ---------- prompts ----------
function planText(plan) {
  if (!plan || !plan.steps || !plan.steps.length) return '(ainda sem plano)';
  return `${plan.goal ? `Objetivo do plano: ${plan.goal}\n` : ''}${plan.steps.map((s, i) => `${i + 1}. [${s.status === 'done' ? 'feito' : s.status === 'active' ? 'em andamento' : 'pendente'}] ${s.text}`).join('\n')}`;
}
const remaining = (m) => Math.max(0, (Date.parse(m.prazo) - Date.now()) / 3600000);

function startPrompt(m) {
  return `MISSÃO LONGA E AUTÔNOMA (prazo: ${fmtDate(m.prazo)}, cerca de ${m.horas} h).
Objetivo: ${m.objetivo}

Regras da missão:
- Ninguém vai responder perguntas durante a missão. Quando faltar uma decisão, escolha a opção mais segura e reversível e registre com note ("DECISÃO: ...").
- Ações irreversíveis ou externas (enviar mensagens, pagar, apagar dados, publicar, deploy em produção) NÃO são permitidas: prepare tudo e registre com note ("PENDENTE HUMANO: ...").
- Trabalhe em ciclos. Este ciclo tem limite de passos; os próximos continuam a partir do plano, das anotações e do diário, que ficam salvos. Então mantenha o plano (update_plan) sempre atualizado e anote com note todo fato que o próximo ciclo vai precisar (caminhos, comandos que funcionam, resultados, problemas).
- Primeiro investigue e monte um plano detalhado, com passos pequenos e verificáveis. Depois execute passo a passo, verificando cada um (testes, comandos, conferência dos arquivos).
- Só quando TUDO estiver feito e verificado, responda começando exatamente com "${DONE_MARK}" seguido do relatório final (o que foi feito, como verificar, decisões tomadas e pendências humanas).`;
}

function continuePrompt(cwd, m, nudge) {
  const files = m.arquivos.length ? m.arquivos.slice(-60).join(', ') : '(nenhum)';
  return `CONTINUAÇÃO DA MISSÃO (ciclo ${m.ciclos + 1}; restam cerca de ${remaining(m).toFixed(1)} h; prazo ${fmtDate(m.prazo)}).
Objetivo: ${m.objetivo}

Plano salvo:
${planText(m.plano)}

Anotações dos ciclos anteriores:
${m.notas.length ? m.notas.slice(-80).map((n) => `- ${n}`).join('\n') : '(nenhuma)'}

Arquivos alterados até agora: ${files}

Diário recente:
${journalTail(cwd, m, 5000)}

Continue a partir do próximo passo pendente. Antes de refazer algo, confira o estado real (arquivos, testes, git). O plano acima já está carregado: atualize-o com update_plan conforme avança e siga as mesmas regras da missão: sem perguntas, sem ações irreversíveis, notas para o próximo ciclo, e "${DONE_MARK}" só depois de verificar tudo.${nudge ? `\n\nATENÇÃO: ${nudge}` : ''}`;
}

// ---------- execução ----------
async function run(cwd, id, { log = console.log, createAgent } = {}) {
  let m = load(cwd, id);
  if (m.status === 'concluida') { log('Missão já concluída.'); return m; }
  m.status = 'rodando'; m.pid = process.pid; m.erro = null;
  if (m.git && !m.branch) m.branch = gitSetup(cwd, m);
  save(cwd, m);
  keepAwake();
  journal(cwd, m, `Início${m.ciclos ? ` (retomada no ciclo ${m.ciclos + 1})` : ''}. Processo ${process.pid}${m.branch ? `, branch ${m.branch}` : ''}.`);
  let waitMs = 0;
  let nudge = '';
  const stopFile = path.join(dirOf(cwd), m.id, 'PARAR');
  while (true) {
    if (fs.existsSync(stopFile)) { fs.rmSync(stopFile, { force: true }); m.status = 'parada'; journal(cwd, m, 'Parada a pedido do usuário.'); break; }
    if (Date.now() > Date.parse(m.prazo)) { m.status = 'prazo'; journal(cwd, m, 'Prazo encerrado.'); break; }
    const agent = createAgent({ model: m.modelo || undefined });
    agent.autoApprove = true;
    agent.interactive = false;
    agent.maxSteps = m.passosPorCiclo;
    agent.notes = [...m.notas];
    if (m.plano) agent.plan = JSON.parse(JSON.stringify(m.plano));
    let errorMsg = '';
    let lastText = '';
    const before = { done: (m.plano && m.plano.steps ? m.plano.steps.filter((s) => s.status === 'done').length : 0), files: m.arquivos.length, notes: m.notas.length };
    const hooks = {
      onText: (t) => { lastText += t; }, onAssistantEnd: () => {}, onThinking: () => {}, onResponseStart: () => { lastText = ''; },
      onReasoning: () => {},
      onToolCall: (i) => { m.acaoAtual = i.description || i.name; log(`[ciclo ${m.ciclos + 1}] ${m.acaoAtual}`); },
      // estado ao vivo para o /missao status (gravado no máximo a cada 20 s)
      onToolResult: () => {
        m.ultimaAtividade = now(); m.passosCiclo = (m.passosCiclo || 0) + 1;
        if (agent.plan) m.plano = agent.plan;
        if (Date.now() - (m._saved || 0) > 20000) { m._saved = Date.now(); const { _saved, ...plain } = m; save(cwd, plain); }
      },
      onCommandOutput: () => {}, onUsage: () => {}, onPlan: () => {}, onInfo: (t) => log(t), onRetry: (t) => log(`(tentando de novo) ${t}`),
      onError: (e) => { errorMsg = String(e); }, onAborted: () => {}, onDone: () => {},
      // irreversível sem humano: nega e registra para depois
      approve: async (info) => { m.pendenciasHumanas.push(`${fmtDate(now())}: ${info.description || info.name}`); return { deny: 'Missão sem supervisão: ação irreversível não permitida. Registre com note como PENDENTE HUMANO e siga com o resto.' }; },
    };
    const prompt = m.ciclos === 0 && !m.plano ? startPrompt(m) : continuePrompt(cwd, m, nudge);
    nudge = '';
    log(`--- ciclo ${m.ciclos + 1} (${remaining(m).toFixed(1)} h restantes) ---`);
    try { await agent.send(prompt, hooks); } catch (e) { errorMsg = e.message; }
    // estado do ciclo vai para o disco
    m.ciclos++;
    m.passosCiclo = 0; m.acaoAtual = null; delete m._saved;
    m.passos += agent.messages.filter((x) => x.role === 'tool').length;
    m.tokens += (agent.usage && agent.usage.total) || 0;
    if (agent.plan) m.plano = agent.plan;
    m.notas = (agent.notes || []).slice(-300);
    for (const n of m.notas) if (/^DECIS[ÃA]O:/i.test(n) && !m.decisoes.includes(n)) m.decisoes.push(n);
    for (const f of agent.touched || []) if (!m.arquivos.includes(f)) m.arquivos.push(f);
    m.ultimaAtividade = now();
    const finalText = [...agent.messages].reverse().find((x) => x.role === 'assistant' && x.content && !x.tool_calls)?.content || lastText;
    const doneCount = m.plano && m.plano.steps ? m.plano.steps.filter((s) => s.status === 'done').length : 0;
    const pending = m.plano && m.plano.steps ? m.plano.steps.filter((s) => s.status !== 'done').length : 0;
    journal(cwd, m, `Ciclo ${m.ciclos}: ${agent.messages.filter((x) => x.role === 'tool').length} ações, plano ${doneCount}/${m.plano && m.plano.steps ? m.plano.steps.length : 0}.${errorMsg ? ` Erro: ${errorMsg.slice(0, 300)}` : ''}\n${String(finalText || '').trim().slice(0, 2500)}`);
    if (gitCheckpoint(cwd, m, `rfcode missão ${m.id}: ciclo ${m.ciclos}`)) log('commit de segurança feito');

    if (String(finalText || '').trimStart().startsWith(DONE_MARK)) {
      if (pending && m.plano) {
        nudge = `Você declarou a missão concluída, mas o plano ainda tem ${pending} passo(s) pendente(s). Termine-os ou marque como feitos explicando por quê, verifique e só então declare "${DONE_MARK}".`;
      } else {
        m.status = 'concluida';
        fs.writeFileSync(path.join(dirOf(cwd), m.id, 'relatorio.md'), `# Relatório da missão ${m.id}\n\nObjetivo: ${m.objetivo}\n\n${finalText.replace(DONE_MARK, '').trim()}\n`
          + (m.pendenciasHumanas.length ? `\n## Ações que precisam de uma pessoa\n${m.pendenciasHumanas.map((p) => `- ${p}`).join('\n')}\n` : '')
          + `\n## Números\n- Ciclos: ${m.ciclos}\n- Ações: ${m.passos}\n- Tokens: ${m.tokens}\n- Arquivos alterados: ${m.arquivos.length}\n${m.branch ? `- Branch: ${m.branch}\n` : ''}`);
        journal(cwd, m, 'Missão concluída. Relatório em relatorio.md.');
        save(cwd, m);
        break;
      }
    }
    // progresso: passos do plano concluídos, arquivos novos ou anotações novas
    const progressed = doneCount > before.done || m.arquivos.length > before.files || m.notas.length > before.notes;
    if (errorMsg && !progressed) {
      // provável falha de rede ou do provedor: espera cada vez mais (1, 2, 5, 10, 20, 30 min) e tenta de novo
      waitMs = Math.min(Math.max(waitMs * 2, 60000), 30 * 60000);
      m.erro = errorMsg.slice(0, 500);
      save(cwd, m);
      journal(cwd, m, `Sem progresso por erro; nova tentativa em ${Math.round(waitMs / 60000)} min.`);
      log(`erro: ${errorMsg.slice(0, 200)}; esperando ${Math.round(waitMs / 60000)} min`);
      await sleepUnlessStopped(waitMs, stopFile);
      continue;
    }
    waitMs = 0;
    m.semProgresso = progressed ? 0 : m.semProgresso + 1;
    if (m.semProgresso >= 6) { m.status = 'travada'; journal(cwd, m, 'Seis ciclos sem progresso: missão pausada para revisão humana.'); save(cwd, m); break; }
    if (m.semProgresso >= 2 && !nudge) nudge = `Os últimos ${m.semProgresso} ciclos não avançaram. Mude de estratégia: reveja o plano, quebre o passo travado em partes menores, investigue a causa do bloqueio (leia o erro, teste hipóteses) ou contorne registrando a decisão.`;
    save(cwd, m);
  }
  m.pid = null;
  save(cwd, m);
  try { require('./enterprise').onDoneHooks(cwd, { missao: m.id, status: m.status, ciclos: m.ciclos }); } catch { /* opcional */ }
  notify(`rfcode: missão ${m.status}`, m.objetivo.slice(0, 120));
  return m;
}

function sleepUnlessStopped(ms, stopFile) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = setInterval(() => { if (Date.now() - t0 >= ms || fs.existsSync(stopFile)) { clearInterval(tick); resolve(); } }, 2000);
  });
}

// aviso do sistema ao terminar (Windows: balão; macOS: notificação)
function notify(title, text) {
  try {
    if (process.platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms;$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;$n.ShowBalloonTip(10000,'${title.replace(/'/g, "''")}','${text.replace(/'/g, "''")}',[System.Windows.Forms.ToolTipIcon]::Info);Start-Sleep 11;$n.Dispose()`;
      spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', ps], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `display notification "${text.replace(/"/g, '')}" with title "${title.replace(/"/g, '')}"`], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch { /* opcional */ }
}

// ---------- controle (CLI e extensão) ----------
// inicia em segundo plano: processo próprio, saída em log.txt
function startDetached(cwd, m, { node = process.execPath, script, env = {} } = {}) {
  const dir = path.join(dirOf(cwd), m.id);
  const out = fs.openSync(path.join(dir, 'log.txt'), 'a');
  const child = spawn(node, [script, '--run-mission', m.id], { cwd, detached: true, stdio: ['ignore', out, out], windowsHide: true, env: { ...process.env, ...env, RFCODE_MISSION: m.id } });
  child.unref();
  m.pid = child.pid;
  m.status = 'rodando';
  save(cwd, m);
  return child.pid;
}
function stop(cwd, id) {
  const m = load(cwd, id);
  fs.writeFileSync(path.join(dirOf(cwd), m.id, 'PARAR'), now());
  return m;
}
function status(cwd, id) {
  const m = load(cwd, id);
  const running = m.status === 'rodando' && alive(m.pid);
  const st = m.status === 'rodando' && !running ? 'interrompida (o processo não está rodando; use retomar)' : m.status;
  const done = m.plano && m.plano.steps ? `${m.plano.steps.filter((s) => s.status === 'done').length}/${m.plano.steps.length}` : '-';
  return `Missão ${m.id}: ${st}\nObjetivo: ${m.objetivo}\nPrazo: ${fmtDate(m.prazo)} (restam ${remaining(m).toFixed(1)} h). Última atividade: ${fmtDate(m.ultimaAtividade)}\n`
    + (m.acaoAtual && running ? `Agora (ciclo ${m.ciclos + 1}, ação ${(m.passosCiclo || 0) + 1}): ${m.acaoAtual}
` : '')
    + `Ciclos: ${m.ciclos}, ações: ${m.passos + (m.passosCiclo || 0)}, tokens: ${m.tokens.toLocaleString('pt-BR')}, plano: ${done}, arquivos alterados: ${m.arquivos.length}${m.branch ? `, branch ${m.branch}` : ''}`
    + (m.erro ? `\nÚltimo erro: ${m.erro.slice(0, 200)}` : '')
    + (m.pendenciasHumanas.length ? `\nPendências para uma pessoa: ${m.pendenciasHumanas.length}` : '')
    + `\n\n${planText(m.plano)}\n\nArquivos: ${path.join(dirOf(cwd), m.id)} (diario.md, log.txt${m.status === 'concluida' ? ', relatorio.md' : ''})`;
}
function listText(cwd) {
  const all = list(cwd);
  if (!all.length) return 'Nenhuma missão nesta pasta. Comece com /missao <objetivo> (ou rfcode missao "<objetivo>" --horas 24).';
  return all.slice(0, 20).map((m) => `${m.id}  ${m.status === 'rodando' && !alive(m.pid) ? 'interrompida' : m.status}  ciclos ${m.ciclos}  ${m.objetivo.slice(0, 70)}`).join('\n');
}

module.exports = { create, load, list, save, run, startDetached, stop, status, listText, journal, alive, notify, DONE_MARK, startPrompt, continuePrompt };
