'use strict';
const fs = require('fs');
const path = require('path');

/**
 * Gerencia pontos de restauração (checkpoints) para operações de arquivo.
 * Mantém uma pilha de estados anteriores dos arquivos para permitir desfazer.
 */
class CheckpointManager {
  constructor() {
    /** @type {Array<{path: string, existed: boolean, content: string | null}>} */
    this.stack = [];
  }

  /**
   * Salva o estado atual de um arquivo na pilha de checkpoints.
   * @param {string} absPath - Caminho absoluto do arquivo
   */
  saveCheckpoint(absPath) {
    let existed = false;
    let content = null;
    try {
      content = fs.readFileSync(absPath, 'utf8');
      existed = true;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw err;
      }
      // Arquivo não existe, mantemos existed = false e content = null
    }
    this.stack.push({ path: absPath, existed, content });
  }

  /**
   * Remove e retorna o último checkpoint da pilha.
   * @returns {Object|null} Objeto do checkpoint ou null se a pilha estiver vazia
   */
  popCheckpoint() {
    return this.stack.length > 0 ? this.stack.pop() : null;
  }

  /**
   * Verifica se há checkpoints disponíveis.
   * @returns {boolean}
   */
  hasCheckpoints() {
    return this.stack.length > 0;
  }
}

module.exports = { CheckpointManager };