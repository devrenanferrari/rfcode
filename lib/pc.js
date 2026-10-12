'use strict';
// Ferramentas de controle do PC (Windows). A implementação fica em pc.ps1.
// Tudo roda localmente: a tela é lida por OCR do Windows e UI Automation, nenhuma imagem é enviada.

const path = require('path');
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const SCRIPT = path.join(__dirname, 'pc.ps1');

const winProp = { type: 'string', description: 'Título da janela (ou parte dele, ou nome do processo)' };

const PC_TOOL_DEFS = [
  {
    name: 'windows',
    description: 'Lista as janelas abertas (título, processo, posição) ou age sobre uma janela: focus, minimize, maximize, restore, close.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'focus', 'minimize', 'maximize', 'restore', 'close'], description: 'Padrão: list' },
        title: winProp,
      },
    },
  },
  {
    name: 'screen_text',
    description: 'Lê o texto visível na tela com OCR (local). Retorna cada linha com a coordenada do centro, para usar com mouse. Pode limitar a uma janela, região ou ler um arquivo de imagem.',
    parameters: {
      type: 'object',
      properties: {
        window: winProp,
        region: { type: 'array', items: { type: 'integer' }, description: '[x, y, largura, altura] em pixels da tela' },
        filter: { type: 'string', description: 'Mostra só linhas que contêm este texto (e a posição das palavras)' },
        image: { type: 'string', description: 'Caminho de uma imagem para ler, em vez da tela' },
      },
    },
  },
  {
    name: 'screenshot',
    description: 'Salva uma captura da tela (ou de uma janela/região) em PNG e retorna o caminho.',
    parameters: {
      type: 'object',
      properties: {
        window: winProp,
        region: { type: 'array', items: { type: 'integer' } },
        path: { type: 'string', description: 'Onde salvar (padrão: pasta TEMP)' },
      },
    },
  },
  {
    name: 'ui_elements',
    description: 'Lista os elementos de interface de uma janela (botões, campos, menus, abas, links...) com nome, tipo e coordenada do centro, via UI Automation. É a forma mais confiável de achar onde clicar.',
    parameters: {
      type: 'object',
      properties: {
        window: winProp,
        filter: { type: 'string', description: 'Filtra por nome ou tipo (ex: "Salvar", "Edit")' },
        limit: { type: 'integer', description: 'Máximo de elementos (padrão 150)' },
      },
      required: ['window'],
    },
  },
  {
    name: 'ui_click',
    description: 'Clica/aciona um elemento de interface pelo nome (de ui_elements) numa janela. Usa a API de acessibilidade e, se não der, clica com o mouse no centro.',
    parameters: {
      type: 'object',
      properties: {
        window: winProp,
        name: { type: 'string', description: 'Nome ou AutomationId do elemento' },
        control_type: { type: 'string', description: 'Opcional: Button, MenuItem, TabItem, ListItem...' },
        mouse: { type: 'boolean', description: 'Forçar clique com o mouse' },
      },
      required: ['window', 'name'],
    },
  },
  {
    name: 'ui_set_text',
    description: 'Preenche um campo de texto (Edit) de uma janela pelo nome, substituindo o conteúdo.',
    parameters: {
      type: 'object',
      properties: {
        window: winProp,
        name: { type: 'string' },
        text: { type: 'string' },
        control_type: { type: 'string' },
      },
      required: ['window', 'name', 'text'],
    },
  },
  {
    name: 'mouse',
    description: 'Controla o mouse em coordenadas de tela (pixels físicos, as mesmas de screen_text/ui_elements).',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['position', 'move', 'click', 'double_click', 'right_click', 'middle_click', 'scroll', 'drag'] },
        x: { type: 'integer' },
        y: { type: 'integer' },
        to_x: { type: 'integer', description: 'Destino do drag' },
        to_y: { type: 'integer' },
        amount: { type: 'integer', description: 'Scroll: positivo sobe, negativo desce (padrão -3)' },
      },
      required: ['action'],
    },
  },
  {
    name: 'keyboard',
    description: 'Digita texto e/ou pressiona atalhos na janela em foco. keys: combinações separadas por espaço, ex: "ctrl+s", "win+r", "alt+tab", "enter", "ctrl+shift+esc", "ctrl+a delete".',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Texto a digitar' },
        keys: { type: 'string', description: 'Atalhos/teclas a pressionar depois do texto' },
        window: { type: 'string', description: 'Opcional: focar esta janela antes' },
      },
    },
  },
  {
    name: 'open',
    description: 'Abre um programa, arquivo, pasta ou URL (ex: "notepad", "calc", "chrome", "https://...", "C:\\pasta"). Espera a janela abrir.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        args: { type: 'string', description: 'Argumentos do programa' },
        wait_ms: { type: 'integer', description: 'Espera após abrir (padrão 1500)' },
      },
      required: ['target'],
    },
  },
  {
    name: 'clipboard',
    description: 'Lê (get) ou define (set) o texto da área de transferência.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['get', 'set'] }, text: { type: 'string' } },
      required: ['action'],
    },
  },
  {
    name: 'wait',
    description: 'Espera alguns milissegundos (ex: aguardar um programa carregar).',
    parameters: { type: 'object', properties: { ms: { type: 'integer' } }, required: ['ms'] },
  },
];

const PC_TOOLS = new Set(PC_TOOL_DEFS.map((t) => t.name));

// Ferramentas de PC que mudam algo e por isso pedem aprovação.
function pcNeedsApproval(name, args) {
  if (['ui_click', 'ui_set_text', 'keyboard', 'open'].includes(name)) return true;
  if (name === 'mouse') return args.action !== 'position';
  if (name === 'windows') return !!args.action && args.action !== 'list';
  if (name === 'clipboard') return args.action === 'set';
  return false;
}

function pcDescribe(name, a) {
  switch (name) {
    case 'windows': return `Windows(${a.action || 'list'}${a.title ? ' "' + a.title + '"' : ''})`;
    case 'screen_text': return `ScreenText(${a.window || a.image || (a.region ? a.region.join(',') : 'tela inteira')}${a.filter ? ' ~ "' + a.filter + '"' : ''})`;
    case 'screenshot': return `Screenshot(${a.window || 'tela'})`;
    case 'ui_elements': return `UiElements("${a.window}"${a.filter ? ' ~ ' + a.filter : ''})`;
    case 'ui_click': return `UiClick("${a.window}" → "${a.name}")`;
    case 'ui_set_text': return `UiSetText("${a.window}" → "${a.name}" = "${String(a.text).slice(0, 60)}")`;
    case 'mouse': return `Mouse(${a.action}${a.x != null ? ` ${a.x},${a.y}` : ''}${a.action === 'drag' ? ` → ${a.to_x},${a.to_y}` : ''})`;
    case 'keyboard': return `Keyboard(${[a.text && `"${String(a.text).slice(0, 60)}"`, a.keys].filter(Boolean).join(' + ')})`;
    case 'open': return `Open(${a.target}${a.args ? ' ' + a.args : ''})`;
    case 'clipboard': return `Clipboard(${a.action})`;
    case 'wait': return `Wait(${a.ms}ms)`;
    default: return null;
  }
}

// No Windows as variáveis não diferenciam maiúsculas; "Path" e "PATH" juntos quebram o Start-Process.
function dedupeEnv(env) {
  const out = {}, seen = new Set();
  for (const [k, v] of Object.entries(env)) {
    if (seen.has(k.toUpperCase())) continue;
    seen.add(k.toUpperCase());
    out[k] = v;
  }
  return out;
}

function runPs(action, args, signal) {
  return new Promise((resolve, reject) => {
    const b64 = Buffer.from(JSON.stringify(args || {}), 'utf8').toString('base64');
    const child = spawn('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Action', action, '-ArgsB64', b64],
      { windowsHide: true, env: dedupeEnv(process.env) });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    const t = setTimeout(() => child.kill(), 60000);
    const onAbort = () => child.kill();
    signal?.addEventListener('abort', onAbort);
    child.on('close', (code) => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      if (code === 0) return resolve(out.trim() || 'OK');
      // mostra só a mensagem do erro do PowerShell, sem a pilha
      const msg = (err || out).split(/\r?\n/).filter((l) => l.trim() && !/^\s*(\+|At |No linha|CategoryInfo|FullyQualifiedErrorId)/.test(l))[0];
      reject(new Error(msg || `falhou (código ${code})`));
    });
    child.on('error', reject);
  });
}

async function runPcTool(name, args, signal) {
  if (!IS_WIN) throw new Error('Controle do PC só está disponível no Windows por enquanto.');
  switch (name) {
    case 'wait':
      await new Promise((r) => setTimeout(r, Math.min(Math.max(args.ms || 1000, 0), 60000)));
      return `Esperou ${args.ms}ms`;
    case 'windows':
      if (!args.action || args.action === 'list') return runPs('windows_list', {}, signal);
      return runPs('window_action', args, signal);
    default:
      return runPs(name, args, signal);
  }
}

const PC_PROMPT = `
Controle do PC (Windows):
- Você pode controlar o computador: ver janelas (windows), ler a tela (screen_text, OCR local), listar elementos de interface (ui_elements), clicar/preencher pelo nome (ui_click, ui_set_text), mouse, keyboard, open, clipboard e wait.
- Fluxo recomendado: open/windows focus → ui_elements (ou screen_text) para achar o alvo → ui_click/ui_set_text (preferível) ou mouse/keyboard nas coordenadas retornadas → confira o resultado com ui_elements/screen_text.
- Coordenadas são pixels físicos da tela e coincidem entre screen_text, ui_elements e mouse.
- Depois de abrir programas ou clicar em algo que carrega, use wait (500–2000 ms) antes de ler a tela.
- Para tarefas de arquivos e sistema, prefira run_command (PowerShell); use mouse/teclado quando precisar interagir com programas gráficos.
- Diálogo nativo de arquivo do Windows (Abrir/Salvar, título "Abrir", "Salvar como" ou nome de pasta): NÃO tente achar o botão "Abrir"/"Salvar" com OCR nem clicar em coordenadas — ele costuma ficar fora da área lida e o clique erra. O caminho confiável é: clique no campo "Nome:" (ou "File name"), digite o caminho COMPLETO do arquivo com ui_set_text ou keyboard (ex.: C:\\Users\\user\\arquivo.vsix) e pressione Enter. Se o arquivo já estiver selecionado/preenchido, basta Enter. Para cancelar, Escape.
- Upload de arquivo em site: se a página tiver <input type=file>, prefira a ferramenta browser (upload) ou injetar o arquivo via script a abrir o diálogo nativo; o diálogo nativo é o último recurso e usa a regra acima.`;

module.exports = { PC_TOOL_DEFS, PC_TOOLS, PC_PROMPT, pcNeedsApproval, pcDescribe, runPcTool, dedupeEnv };
