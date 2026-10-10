'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

class SessionManager {
  constructor() {
    const base = process.env.RFCODE_HOME || path.join(os.homedir(), '.rfcode');
    this.sessionsDir = path.join(base, 'sessions');
    try { fs.mkdirSync(this.sessionsDir, { recursive: true }); } catch {}
  }

  _getFilename() {
    const now = new Date();
    const date = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const time = now.toISOString().slice(11, 23).replace(/[:.]/g, '-'); // HH-mm-ss
    const ms = String(now.getMilliseconds()).padStart(3, '0');
    const id = `${time}-${ms}`;
    return `${date}-${id}.json`;
  }

  save(messages) {
    const filename = this._getFilename();
    const filepath = path.join(this.sessionsDir, filename);
    try {
      fs.writeFileSync(filepath, JSON.stringify(messages, null, 2));
      return filepath;
    } catch (err) {
      console.error('Erro ao salvar sessão:', err);
      return null;
    }
  }

  list() {
    try {
      const files = fs.readdirSync(this.sessionsDir);
      const sessions = files
        .filter(f => f.endsWith('.json'))
        .map(f => ({
          name: f,
          path: path.join(this.sessionsDir, f),
          mtime: fs.statSync(path.join(this.sessionsDir, f)).mtime
        }))
        .sort((a, b) => b.mtime - a.mtime)
        .map(s => s.path);
      return sessions;
    } catch (err) {
      return [];
    }
  }

  load(filepath) {
    try {
      const content = fs.readFileSync(filepath, 'utf8');
      const messages = JSON.parse(content);
      if (!Array.isArray(messages)) throw new Error('Invalid session format');
      return messages;
    } catch (err) {
      console.error('Erro ao carregar sessão:', err);
      return null;
    }
  }
}

module.exports = { SessionManager };