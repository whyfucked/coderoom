import { stdout } from 'node:process';
import { onKey } from './keys.mjs';
import { claim } from './screen.mjs';
import { cursor, width, visLen, truncate, glyphs, screenRows, unicodeOK } from './ansi.mjs';
import { loadHistory, saveHistory } from './config.mjs';
import { createTheme } from './themes.mjs';

export function createInput({
  commands = [], statusLine, onExit, onShiftTab,
  theme = createTheme('claude'), placeholder = 'что нужно сделать?',
} = {}) {
  let t = theme;
  let PROMPT = '  ' + t.symbols.prompt + ' ';
  let PROMPT_W = visLen(PROMPT);
  const ELL = unicodeOK ? '…' : '...';
  const DASH = unicodeOK ? '—' : '-';

  let buf = '';
  let pos = 0;
  let history = loadHistory();
  let hIdx = history.length;
  let draft = '';
  let sugg = [];
  let suggIdx = 0;
  let renderedLines = 0;
  let cursorRow = 0;
  let active = false;
  let resolveFn = null;
  let exitArmed = false;
  let exitTimer = null;
  let hint = '';
  let notice = '';
  let noticeTimer = null;
  let releaseScreen = null;
  let queue = '';

  function quit() {
    clearTimeout(exitTimer);
    clearTimeout(noticeTimer);
    releaseScreen?.();
    onExit?.();
    process.exit(0);
  }

  function showNotice(text, ttl = 2500) {
    clearTimeout(noticeTimer);
    notice = text || '';
    if (!active) return;
    render();
    if (notice && ttl > 0) {
      noticeTimer = setTimeout(() => { notice = ''; render(); }, ttl);
    }
  }

  function computeSuggestions() {
    if (!buf.startsWith('/') || buf.includes(' ')) { sugg = []; return; }
    const q = buf.slice(1).toLowerCase();
    sugg = commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, 8);
    if (suggIdx >= sugg.length) suggIdx = 0;
  }

  function clearRender() {
    if (cursorRow > 0) cursor.up(cursorRow);
    cursor.toCol0();
    cursor.clearDown();
    renderedLines = 0;
    cursorRow = 0;
  }

  function moveLine(dir) {
    const lineStart = buf.lastIndexOf('\n', pos - 1) + 1;
    const col = pos - lineStart;
    if (dir < 0) {
      if (lineStart === 0) return pos;
      const prevStart = buf.lastIndexOf('\n', lineStart - 2) + 1;
      return prevStart + Math.min(col, lineStart - 1 - prevStart);
    }
    const nl = buf.indexOf('\n', pos);
    if (nl === -1) return pos;
    const nextStart = nl + 1;
    let nextEnd = buf.indexOf('\n', nextStart);
    if (nextEnd === -1) nextEnd = buf.length;
    return nextStart + Math.min(col, nextEnd - nextStart);
  }

  function cursorRC(w) {
    const before = PROMPT + buf.slice(0, pos).split('\n').join('\n' + ' '.repeat(PROMPT_W));
    const segments = before.split('\n');
    const last = segments[segments.length - 1];
    let row = 0;
    for (let i = 0; i < segments.length - 1; i++) row += Math.max(1, Math.ceil(visLen(segments[i]) / w));
    row += Math.floor(visLen(last) / w);
    return { row, col: visLen(last) % w };
  }

  function render() {
    if (!active) return;
    clearRender();
    const w = width();
    const lines = [];

    const shown = buf.length
      ? buf.split('\n').join('\n' + ' '.repeat(PROMPT_W))
      : t.muted(placeholder + ELL);
    lines.push(t.primary(PROMPT) + shown);

    const nameCol = sugg.length ? Math.max(...sugg.map((c) => visLen('/' + c.name))) + 2 : 0;
    for (let i = 0; i < sugg.length; i++) {
      const c = sugg[i];
      const sel = i === suggIdx;
      const name = '/' + c.name;
      const label = sel ? t.primary('  ' + t.symbols.prompt + ' ') + t.bold(name) : '    ' + t.muted(name);
      const gap = ' '.repeat(Math.max(1, nameCol - visLen(name)));
      const room = w - 4 - nameCol - 2;
      const desc = c.desc && room > 8 ? t.muted(truncate(c.desc, room)) : '';
      lines.push(label + gap + desc);
    }

    if (notice) lines.push('  ' + truncate(notice, w - 4));
    if (hint) lines.push(t.warn('  ' + hint));
    if (statusLine) {
      const s = statusLine();
      if (s) lines.push(t.muted('  ' + truncate(s, w - 4)));
    }

    const text = glyphs(lines.join('\n'));
    stdout.write(text);

    renderedLines = screenRows(text, w) - 1;
    const { row, col } = cursorRC(w);
    cursorRow = row;
    const up = renderedLines - row;
    if (up > 0) cursor.up(up);
    cursor.toCol0();
    if (col > 0) cursor.right(col);
  }

  function finish(value) {
    active = false;
    clearTimeout(noticeTimer);
    notice = '';
    hint = '';
    releaseScreen?.();
    releaseScreen = null;
    clearRender();
    stdout.write(glyphs(t.primary(PROMPT) + value.split('\n').join('\n' + ' '.repeat(PROMPT_W))) + '\n');
    if (value.trim()) {
      history = history.filter((h) => h !== value);
      history.push(value);
      saveHistory(history);
    }
    hIdx = history.length;
    const r = resolveFn;
    resolveFn = null;
    buf = '';
    pos = 0;
    sugg = [];
    if (r) r(value);
  }

  function handle(str, key) {
    const name = key.name;

    if (!active) {
      if (key.ctrl || key.meta) return;
      if (name === 'return' || str === '\r' || str === '\n') queue += '\n';
      else if (str && str >= ' ' && str !== '\x7f') queue += str.replace(/\r\n?/g, '\n');
      else if (name === 'backspace') queue = queue.slice(0, -1);
      return;
    }

    if (key.ctrl && name === 'c') {
      if (buf) {
        buf = ''; pos = 0; exitArmed = false;
        computeSuggestions(); render();
        return;
      }
      if (exitArmed) { clearRender(); stdout.write('\n'); return quit(); }
      exitArmed = true;
      hint = `ещё раз Ctrl+C ${DASH} выход`;
      render();
      clearTimeout(exitTimer);
      exitTimer = setTimeout(() => { exitArmed = false; hint = ''; render(); }, 2500);
      return;
    }
    if (key.ctrl && name === 'd') {
      if (!buf) { clearRender(); stdout.write('\n'); return quit(); }
      return;
    }
    if (exitArmed) { exitArmed = false; hint = ''; clearTimeout(exitTimer); }

    if (name === 'tab' && key.shift) { onShiftTab?.(); return; }

    if (sugg.length && (name === 'tab' || (name === 'return' && buf.startsWith('/') && !buf.includes(' ')))) {
      const pick = sugg[suggIdx];
      if (pick) {
        buf = '/' + pick.name;
        pos = buf.length;
        computeSuggestions();
        if (name === 'return') return finish(buf);
        render();
        return;
      }
    }
    if (sugg.length && (name === 'up' || name === 'down')) {
      suggIdx = name === 'down'
        ? (suggIdx + 1) % sugg.length
        : (suggIdx - 1 + sugg.length) % sugg.length;
      render();
      return;
    }
    if (name === 'escape' && sugg.length) { sugg = []; render(); return; }

    switch (name) {
      case 'return':
        if (key.shift || key.meta) {
          buf = buf.slice(0, pos) + '\n' + buf.slice(pos);
          pos++;
          render();
          return;
        }
        finish(buf);
        return;
      case 'backspace':
        if (pos > 0) { buf = buf.slice(0, pos - 1) + buf.slice(pos); pos--; }
        break;
      case 'delete':
        buf = buf.slice(0, pos) + buf.slice(pos + 1);
        break;
      case 'left':
        if (key.ctrl) pos = buf.slice(0, pos).replace(/\s*\S+$/, '').length;
        else pos = Math.max(0, pos - 1);
        break;
      case 'right':
        if (key.ctrl) {
          const after = buf.slice(pos).match(/^\s*\S+/);
          pos += after ? after[0].length : 0;
        } else pos = Math.min(buf.length, pos + 1);
        break;
      case 'home': pos = 0; break;
      case 'end': pos = buf.length; break;
      case 'up': {
        if (buf.includes('\n') && buf.lastIndexOf('\n', pos - 1) !== -1) { pos = moveLine(-1); break; }
        if (hIdx === history.length) draft = buf;
        if (hIdx > 0) { hIdx--; buf = history[hIdx] ?? ''; pos = buf.length; }
        break;
      }
      case 'down': {
        if (buf.includes('\n') && buf.indexOf('\n', pos) !== -1) { pos = moveLine(1); break; }
        if (hIdx < history.length) {
          hIdx++;
          buf = hIdx === history.length ? draft : history[hIdx];
          pos = buf.length;
        }
        break;
      }
      default: {
        if (key.ctrl && name === 'u') { buf = buf.slice(pos); pos = 0; break; }
        if (key.ctrl && name === 'k') { buf = buf.slice(0, pos); break; }
        if (key.ctrl && name === 'a') { pos = 0; break; }
        if (key.ctrl && name === 'e') { pos = buf.length; break; }
        if (key.ctrl && name === 'w') {
          const before = buf.slice(0, pos).replace(/\s*\S+$/, '');
          buf = before + buf.slice(pos);
          pos = before.length;
          break;
        }
        if (key.ctrl || key.meta) return;
        if (str && str >= ' ' && str !== '\x7f') {
          const chunk = str.replace(/\r\n?/g, '\n');
          buf = buf.slice(0, pos) + chunk + buf.slice(pos);
          pos += chunk.length;
        } else if (str === '\r' || str === '\n') { finish(buf); return; }
        else return;
      }
    }
    computeSuggestions();
    render();
  }

  onKey(handle);

  return {
    ask() {
      return new Promise((res) => {
        resolveFn = res;
        active = true;
        buf = ''; pos = 0; sugg = [];
        renderedLines = 0; cursorRow = 0;

        if (queue) {
          const nl = queue.indexOf('\n');
          if (nl !== -1) {
            const line = queue.slice(0, nl);
            queue = queue.slice(nl + 1);
            active = false;
            resolveFn = null;
            stdout.write(glyphs(t.primary(PROMPT) + line) + '\n');
            if (line.trim()) {
              history = history.filter((h) => h !== line);
              history.push(line);
              saveHistory(history);
              hIdx = history.length;
            }
            return res(line);
          }
          buf = queue;
          pos = buf.length;
          queue = '';
          computeSuggestions();
        }

        releaseScreen?.();
        releaseScreen = claim({ notify: showNotice });
        render();
      });
    },
    setValue(v) { buf = String(v ?? ''); pos = buf.length; computeSuggestions(); render(); },
    setCommands(list) { commands = list ?? []; },
    setPrompt(value) {
      PROMPT = String(value ?? '  ' + t.symbols.prompt + ' ');
      PROMPT_W = visLen(PROMPT);
      if (active) render();
    },
    setTheme(next) {
      t = next;
      PROMPT = '  ' + t.symbols.prompt + ' ';
      PROMPT_W = visLen(PROMPT);
      if (active) render();
    },
    notify: showNotice,
    refresh: () => render(),
    get active() { return active; },
  };
}
