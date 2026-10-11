'use strict';
// Tarefas agendadas: "todo dia às 9h", "dias úteis às 8h30", "toda segunda e quinta às 14h", "a cada 30 minutos",
// "amanhã às 7h", "25/12 às 10h" ou expressão cron. Usa o Agendador de Tarefas do Windows (ou o cron no macOS/Linux),
// então roda mesmo com o rfcode fechado. Cada execução é um "rfcode -p" na pasta escolhida, com o resultado salvo.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const HOME = () => process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
const FILE = () => path.join(HOME(), 'agendamentos.json');
const DAYS = { domingo: 0, segunda: 1, terca: 2, terça: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6, sábado: 6 };
const DAY_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_PT = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];

// ---------- interpretação do "quando" ----------
function parseWhen(text, nowDate = new Date()) {
  const t = String(text || '').toLowerCase().normalize('NFC').trim();
  if (/^(\S+\s+){4}\S+$/.test(t) && /^[\d*/,\-\s]+$/.test(t)) return { kind: 'cron', cron: t, label: `cron ${t}` };
  const tm = /(?:às|as|a partir das|das)\s*(\d{1,2})(?:\s*[:h]\s*(\d{2}))?/.exec(t) || /\b(\d{1,2})\s*[:h]\s*(\d{2})?\b/.exec(t);
  let hour = tm ? Number(tm[1]) : 9, minute = tm && tm[2] ? Number(tm[2]) : 0;
  if (/\b(da|de) (tarde|noite)\b/.test(t) && hour < 12) hour += 12;
  if (hour > 23 || minute > 59) throw new Error(`Horário inválido em "${text}".`);
  const hhmm = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
  const every = /a cada (\d+)\s*(min|minuto|minutos|h|hora|horas)\b/.exec(t);
  if (every) {
    const n = Number(every[1]);
    const minutes = /^h|hora/.test(every[2]) ? n * 60 : n;
    if (minutes < 5) throw new Error('O intervalo mínimo é de 5 minutos.');
    return { kind: 'interval', minutes, label: `a cada ${minutes % 60 === 0 ? `${minutes / 60} h` : `${minutes} min`}` };
  }
  if (/dias [úu]teis|de segunda a sexta|segunda a sexta/.test(t)) return { kind: 'weekly', days: [1, 2, 3, 4, 5], time: hhmm, label: `dias úteis às ${hhmm}` };
  const named = [...t.matchAll(/\b(domingo|segunda|ter[cç]a|quarta|quinta|sexta|s[aá]bado)s?(?:-feiras?)?\b/g)].map((m) => DAYS[m[1]]).filter((d) => d != null);
  if (/\b(toda|todo|todas|todos|às|as)\b/.test(t) && named.length && !/\bdia \d/.test(t)) {
    const days = [...new Set(named)].sort();
    return { kind: 'weekly', days, time: hhmm, label: `${days.map((d) => DAY_PT[d]).join(', ')} às ${hhmm}` };
  }
  if (/todo dia|todos os dias|diariamente|diário|diaria|toda manh[aã]|toda noite/.test(t)) return { kind: 'daily', time: hhmm, label: `todo dia às ${hhmm}` };
  // uma vez: hoje, amanhã ou uma data
  let date = null;
  if (/\bhoje\b/.test(t)) date = new Date(nowDate);
  // \b do JavaScript não entende "ã": fronteira feita à mão
  else if (/(^|[^a-z])amanh[ãa](?![a-z])/.test(t)) { date = new Date(nowDate); date.setDate(date.getDate() + 1); }
  const dm = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (dm) { date = new Date(Number(dm[3] ? (dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : nowDate.getFullYear()), Number(dm[2]) - 1, Number(dm[1])); }
  if (date) {
    date.setHours(hour, minute, 0, 0);
    if (!dm && date <= nowDate) date.setDate(date.getDate() + 1); // "hoje às 8h" já passou: amanhã
    if (dm && date <= nowDate) date.setFullYear(date.getFullYear() + 1);
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${hhmm}:00`;
    return { kind: 'once', at: iso, label: `uma vez em ${date.toLocaleDateString('pt-BR')} às ${hhmm}` };
  }
  if (tm) return { kind: 'daily', time: hhmm, label: `todo dia às ${hhmm}` };
  throw new Error(`Não entendi quando: "${text}". Exemplos: "todo dia às 9h", "dias úteis às 8h30", "toda segunda às 14h", "a cada 30 minutos", "amanhã às 7h", "25/12 às 10h".`);
}

function toCron(w) {
  if (w.kind === 'cron') return w.cron;
  if (w.kind === 'interval') return w.minutes % 60 === 0 ? `0 */${w.minutes / 60} * * *` : `*/${w.minutes} * * * *`;
  const [h, m] = (w.time || w.at.slice(11, 16)).split(':').map(Number);
  if (w.kind === 'daily') return `${m} ${h} * * *`;
  if (w.kind === 'weekly') return `${m} ${h} * * ${w.days.join(',')}`;
  if (w.kind === 'once') return `${m} ${h} ${Number(w.at.slice(8, 10))} ${Number(w.at.slice(5, 7))} *`;
  throw new Error('agenda inválida');
}

// ---------- armazenamento ----------
const readAll = () => { try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return []; } };
const writeAll = (list) => { fs.mkdirSync(HOME(), { recursive: true }); fs.writeFileSync(FILE(), JSON.stringify(list, null, 2)); };

// cópia estável do rfcode para o agendador (o caminho da extensão muda a cada versão)
function runtimeScript(srcRoot) {
  const dest = path.join(HOME(), 'runtime');
  const copy = (from, to) => {
    for (const e of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, e.name), b = path.join(to, e.name);
      if (e.isDirectory()) { fs.mkdirSync(b, { recursive: true }); copy(a, b); } else fs.copyFileSync(a, b);
    }
  };
  for (const d of ['bin', 'lib']) { fs.mkdirSync(path.join(dest, d), { recursive: true }); copy(path.join(srcRoot, d), path.join(dest, d)); }
  fs.copyFileSync(path.join(srcRoot, 'package.json'), path.join(dest, 'package.json'));
  return path.join(dest, 'bin', 'rfcode.js');
}

function nodeBinary() {
  // node do sistema; dentro do VS Code process.execPath é o Electron
  if (!process.versions.electron) return process.execPath;
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['node'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim();
    if (out) return out;
  } catch { /* sem node no PATH */ }
  return null; // usa o executável do VS Code com ELECTRON_RUN_AS_NODE
}

// ---------- registro no sistema ----------
const taskName = (id) => `rfcode-agenda-${id}`;
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function registerWindows(job, script) {
  const node = nodeBinary();
  // sem node instalado: roda com o executável do VS Code como Node
  const exe = node || 'cmd.exe';
  const args = node ? `"${script}" --run-schedule ${job.id}` : `/c "set ELECTRON_RUN_AS_NODE=1&& "${process.execPath}" "${script}" --run-schedule ${job.id}"`;
  const w = job.when;
  let trigger;
  if (w.kind === 'daily') trigger = `New-ScheduledTaskTrigger -Daily -At ${psq(w.time)}`;
  else if (w.kind === 'weekly') trigger = `New-ScheduledTaskTrigger -Weekly -DaysOfWeek ${w.days.map((d) => DAY_EN[d]).join(',')} -At ${psq(w.time)}`;
  else if (w.kind === 'once') trigger = `New-ScheduledTaskTrigger -Once -At ([datetime]::ParseExact(${psq(w.at)},'yyyy-MM-ddTHH:mm:ss',$null))`;
  else if (w.kind === 'interval') trigger = `New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes ${w.minutes})`;
  else throw new Error('No Windows use frases como "todo dia às 9h" em vez de cron.');
  const ps = `$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute ${psq(exe)} -Argument ${psq(args)} -WorkingDirectory ${psq(job.cwd)};`
    + `$t=${trigger};$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 12) -MultipleInstances IgnoreNew;`
    + `Register-ScheduledTask -TaskName ${psq(taskName(job.id))} -TaskPath '\\rfcode\\' -Action $a -Trigger $t -Settings $s -Description ${psq(`rfcode: ${job.task.slice(0, 200)}`)} -Force | Out-Null`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`O Agendador de Tarefas recusou: ${(r.stderr || r.stdout || '').trim().split('\n').slice(0, 3).join(' ')}`);
}
function unregisterWindows(id) {
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Unregister-ScheduledTask -TaskName ${psq(taskName(id))} -TaskPath '\\rfcode\\' -Confirm:$false -ErrorAction SilentlyContinue`], { windowsHide: true });
}
function cronEdit(fn) {
  let cur = '';
  try { cur = execFileSync('crontab', ['-l'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* sem crontab ainda */ }
  const next = fn(cur.split('\n').filter((l) => l !== '')).join('\n') + '\n';
  const r = spawnSync('crontab', ['-'], { input: next, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`crontab recusou: ${r.stderr}`);
}
function registerUnix(job, script) {
  const line = `${toCron(job.when)} cd ${JSON.stringify(job.cwd)} && ${JSON.stringify(nodeBinary() || 'node')} ${JSON.stringify(script)} --run-schedule ${job.id} >/dev/null 2>&1 # ${taskName(job.id)}`;
  cronEdit((lines) => [...lines.filter((l) => !l.includes(taskName(job.id))), line]);
}
const unregisterUnix = (id) => cronEdit((lines) => lines.filter((l) => !l.includes(taskName(id))));

// ---------- API ----------
function add({ when, task, cwd, model, srcRoot, register = true }) {
  if (!task || String(task).trim().length < 5) throw new Error('Informe a tarefa.');
  const w = parseWhen(when);
  const job = { id: crypto.randomBytes(3).toString('hex'), when: w, quando: w.label, task: String(task).trim(), cwd: path.resolve(cwd), model: model || null, criado: new Date().toISOString(), ativo: true, execucoes: [] };
  if (register) {
    const script = runtimeScript(srcRoot);
    if (process.platform === 'win32') registerWindows(job, script); else registerUnix(job, script);
  }
  writeAll([...readAll(), job]);
  return job;
}
function remove(id) {
  const list = readAll();
  const job = list.find((j) => j.id === id);
  if (!job) throw new Error(`Agendamento ${id} não encontrado.`);
  if (process.platform === 'win32') unregisterWindows(id); else { try { unregisterUnix(id); } catch { /* sem cron */ } }
  writeAll(list.filter((j) => j.id !== id));
  return job;
}
function list() { return readAll(); }
function listText() {
  const all = readAll();
  if (!all.length) return 'Nenhuma tarefa agendada. Exemplo: /agendar dias úteis às 8h: resuma os pull requests abertos e mande no Slack';
  return all.map((j) => {
    const last = j.execucoes[j.execucoes.length - 1];
    return `${j.id}  ${j.quando}  ${j.task.slice(0, 70)}${j.task.length > 70 ? '...' : ''}\n      pasta: ${j.cwd}${last ? `\n      última: ${new Date(last.inicio).toLocaleString('pt-BR')} (${last.ok ? 'ok' : 'falhou'}) ${last.saida}` : ''}`;
  }).join('\n');
}
function recordRun(id, entry) {
  const all = readAll();
  const j = all.find((x) => x.id === id);
  if (!j) return;
  j.execucoes = [...j.execucoes, entry].slice(-50);
  // "uma vez": depois de rodar sai do agendador
  if (j.when.kind === 'once') { j.ativo = false; try { if (process.platform === 'win32') unregisterWindows(id); else unregisterUnix(id); } catch { /* ok */ } }
  writeAll(all);
}
function outputFile(id) {
  const dir = path.join(HOME(), 'agendamentos', id);
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  return path.join(dir, `${d.toISOString().slice(0, 10)}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}.md`);
}

module.exports = { parseWhen, toCron, add, remove, list, listText, recordRun, outputFile, readAll };
