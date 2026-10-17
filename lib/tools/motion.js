'use strict';
// Vídeos de apresentação programáticos com os projetos mais conhecidos do GitHub:
// Remotion (remotion-dev/remotion) - vídeo em React; Manim (ManimCommunity/manim) - animações matemáticas;
// Motion Canvas (motion-canvas/motion-canvas) - animações com TypeScript; reveal.js (hakimel/reveal.js) - slides em HTML.
// Complementa o create_video nativo (narração + legendas) com animação de verdade.

const path = require('path');
const { run, need, has } = require('./_exec');

const NODE = 'https://nodejs.org';

function remotion(a, { cwd, signal }) {
  need('npx', `Node.js/npx não encontrado. Instale em ${NODE}.`);
  if (a.action === 'scaffold') {
    const name = String(a.name || 'video-remotion').replace(/[^\w.-]/g, '-');
    const { code, out } = run('npx', ['--yes', 'create-video@latest', name, '--template', 'hello-world'], { cwd, signal, timeout: 600000 });
    return `Remotion (remotion-dev/remotion) ${code === 0 ? 'criado' : `código ${code}`} em "${name}".\n\n${out}\n\nEdite src/, pré-visualize com "npm run dev" (Remotion Studio) e renderize com action=render.`;
  }
  const comp = String(a.composition || 'HelloWorld');
  const outFile = a.out || 'out/video.mp4';
  const { code, out } = run('npx', ['--yes', 'remotion', 'render', comp, outFile], { cwd, signal, timeout: 1200000 });
  return `Remotion render ${code === 0 ? 'concluído' : `código ${code}`}: ${outFile}\n\n${out}`;
}

function manim(a, { cwd, signal }) {
  need('manim', 'Manim não encontrado. Instale com "pip install manim" (ManimCommunity/manim) — requer Python, ffmpeg e, para LaTeX, uma distribuição TeX.');
  if (a.action === 'scaffold') {
    const file = a.file || 'cena.py';
    const skel = 'from manim import *\n\n\nclass Cena(Scene):\n    def construct(self):\n        titulo = Text("Olá, Manim")\n        self.play(Write(titulo))\n        self.wait(1)\n';
    require('fs').writeFileSync(path.resolve(cwd, file), skel);
    return `Cena de exemplo criada em ${file} (ManimCommunity/manim). Renderize com action=render, file=${file}, scene=Cena.`;
  }
  const file = a.file;
  if (!file) throw new Error('file é obrigatório (arquivo .py da cena).');
  const scene = a.scene || 'Cena';
  const q = a.quality === 'alta' ? '-qh' : a.quality === 'baixa' ? '-ql' : '-qm';
  const { code, out } = run('manim', ['render', q, file, scene], { cwd, signal, timeout: 1200000 });
  return `Manim render ${code === 0 ? 'concluído' : `código ${code}`} (${scene}).\n\n${out}`;
}

function motionCanvas(a, { cwd, signal }) {
  need('npm', `Node.js/npm não encontrado. Instale em ${NODE}.`);
  const name = String(a.name || 'motion-canvas').replace(/[^\w.-]/g, '-');
  const { code, out } = run('npm', ['init', '@motion-canvas@latest', name, '--yes'], { cwd, signal, timeout: 600000 });
  return `Motion Canvas (motion-canvas/motion-canvas) ${code === 0 ? 'criado' : `código ${code}`} em "${name}".\n\n${out}\n\nAbra o editor com "npm start" e exporte o vídeo por lá.`;
}

function revealjs(a, { cwd, signal }) {
  // reveal.js (hakimel/reveal.js): slides em HTML. Exporta para PDF/vídeo com decktape, se disponível.
  const action = a.action || 'scaffold';
  if (action === 'render') {
    if (!has('decktape')) throw new Error('decktape não encontrado (para exportar reveal.js). Instale com "npm i -g decktape" (astefanutti/decktape).');
    const src = a.file || 'index.html';
    const outFile = a.out || 'slides.pdf';
    const { code, out } = run('decktape', ['reveal', src, outFile], { cwd, signal, timeout: 600000 });
    return `decktape ${code === 0 ? 'exportou' : `código ${code}`}: ${outFile}\n\n${out}`;
  }
  need('npx', `Node.js/npx não encontrado. Instale em ${NODE}.`);
  const name = String(a.name || 'slides-reveal').replace(/[^\w.-]/g, '-');
  const { code, out } = run('npx', ['--yes', 'degit', 'hakimel/reveal.js', name], { cwd, signal, timeout: 300000 });
  return `reveal.js (hakimel/reveal.js) ${code === 0 ? 'clonado' : `código ${code}`} em "${name}".\n\n${out}\n\nEdite ${name}/index.html; sirva com "npm start" e exporte com action=render (via decktape).`;
}

module.exports = {
  defs: [{
    name: 'motion_video',
    description: 'Cria vídeos de apresentação animados com os projetos mais famosos do GitHub, além do create_video nativo. '
      + 'engine=remotion (remotion-dev/remotion, vídeo em React), manim (ManimCommunity/manim, animação matemática em Python), '
      + 'motion-canvas (motion-canvas/motion-canvas, animação em TS) ou revealjs (hakimel/reveal.js, slides HTML). '
      + 'action=scaffold cria o projeto/base; action=render renderiza o vídeo (remotion, manim) ou exporta (revealjs via decktape). '
      + 'Requer Node.js (remotion, motion-canvas, revealjs) ou Python+Manim (manim).',
    parameters: {
      type: 'object',
      properties: {
        engine: { type: 'string', enum: ['remotion', 'manim', 'motion-canvas', 'revealjs'] },
        action: { type: 'string', enum: ['scaffold', 'render'], description: 'Padrão: scaffold' },
        name: { type: 'string', description: 'Nome da pasta do projeto (scaffold)' },
        file: { type: 'string', description: 'Arquivo de entrada (manim: .py; revealjs render: .html)' },
        scene: { type: 'string', description: 'Manim: nome da classe Scene' },
        composition: { type: 'string', description: 'Remotion: id da composição a renderizar' },
        quality: { type: 'string', enum: ['baixa', 'media', 'alta'], description: 'Manim: qualidade do render' },
        out: { type: 'string', description: 'Arquivo de saída do render/export' },
      },
      required: ['engine'],
    },
  }],
  run(name, a, ctx) {
    switch (a.engine) {
      case 'remotion': return remotion(a, ctx);
      case 'manim': return manim(a, ctx);
      case 'motion-canvas': return motionCanvas(a, ctx);
      case 'revealjs': return revealjs(a, ctx);
      default: throw new Error('engine: remotion, manim, motion-canvas ou revealjs');
    }
  },
  describe: (name, a) => `Motion(${a.engine} ${a.action || 'scaffold'})`,
  needsApproval: () => true, // cria/renderiza arquivos e baixa pacotes
  group: {
    name: 'motion', desc: 'vídeos de apresentação animados (Remotion, Manim, Motion Canvas, reveal.js)',
    hint: /\b(remotion|manim|motion ?canvas|reveal\.?js|anima[cç][aã]o|animad[oa]|slides? animad|v[ií]deo de apresenta|screencast|motion graphics)\b/i,
  },
  _test: { remotion, manim },
};
