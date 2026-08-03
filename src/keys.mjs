import readline from 'node:readline';
import { stdin } from 'node:process';

let inited = false;
const handlers = new Set();

function init() {
  if (inited) return;
  inited = true;
  readline.emitKeypressEvents(stdin);
  if (stdin.isTTY) {
    try { stdin.setRawMode(true); } catch { /* не TTY-совместимый поток */ }
  }
  stdin.resume();
  stdin.on('keypress', (str, key) => {
    for (const h of [...handlers]) {
      try {
        h(str, key || {});
      } catch (e) {
        process.stderr.write(`\n[keys] ${e.message}\n`);
      }
    }
  });
}

export function onKey(handler) {
  init();
  handlers.add(handler);
  return () => handlers.delete(handler);
}

export function release() {
  if (stdin.isTTY) {
    try { stdin.setRawMode(false); } catch { /* ignore */ }
  }
  stdin.pause();
}

export const keysActive = () => handlers.size > 0;
