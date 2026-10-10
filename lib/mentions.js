'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Expande menções @arquivo no texto.
 * Para cada @caminho de arquivo existente, anexa o conteúdo ao fim da mensagem
 * em um bloco com o nome do arquivo (limite de 20.000 caracteres por arquivo).
 * @param {string} texto - Texto original que pode conter menções @caminho
 * @param {string} cwd - Diretório de trabalho atual para resolver caminhos relativos
 * @returns {string} Texto com menções expandidas
 */
function expandMentions(texto, cwd) {
  if (!texto) return texto;

  // Encontra todas as menções @ seguido de não-espaços
  const matches = [...texto.matchAll(/@(\S+)/g)];
  const appendedParts = [];

  const seen = new Set();
  for (const match of matches) {
    // pontuação colada no fim ("veja @lib/a.js, depois…") não faz parte do caminho
    const filePath = match[1].replace(/[.,;:!?)\]}'"]+$/, ''); // sem o '@'
    const mention = '@' + filePath;
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    try {
      const fullPath = path.resolve(cwd, filePath);
      // Verifica se é um arquivo existente
      if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
        let content = fs.readFileSync(fullPath, 'utf8');
        // Limite de 20.000 caracteres por arquivo
        if (content.length > 20000) {
          content = content.slice(0, 20000) + '\n... [truncado, limite de 20.000 caracteres atingido]';
        }
        const block = `\n--- Begin file: ${mention} ---\n${content}\n--- End file: ${mention} ---`;
        appendedParts.push(block);
      }
      // Se o arquivo não existir, deixamos a menção unchanged no texto original
    } catch (err) {
      // Em caso de erro ao ler, ignoramos a menção (deixa unchanged)
    }
  }

  // Retorna o texto original seguido pelos blocos de arquivos encontrados
  return texto + appendedParts.join('');
}

module.exports = { expandMentions };