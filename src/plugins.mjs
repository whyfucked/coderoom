import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_DIR } from './config.mjs';
import { checkDangerous } from './permissions.mjs';

const MODULE_DIR = typeof __dirname === 'string'
  ? __dirname
  : path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(MODULE_DIR, '..');
export const BUNDLED_PLUGINS_DIR = path.join(PKG_ROOT, 'plugins');

export function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (mm) meta[mm[1].trim()] = mm[2].trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: m[2] };
}

const readSafe = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const mdFiles = (dir) => { try { return fs.readdirSync(dir).filter((f) => f.endsWith('.md')); } catch { return []; } };

let _cache = null;

export function loadPlugins({ cwd = process.cwd(), reload = false } = {}) {
  const key = cwd;
  if (_cache && _cache.key === key && !reload) return _cache.val;

  const roots = [
    BUNDLED_PLUGINS_DIR,
    path.join(CONFIG_DIR, 'plugins'),
    path.join(cwd, '.coderoom', 'plugins'),
  ];

  const commands = new Map();
  const skills = new Map();
  const agents = new Map();
  const plugins = new Map();

  for (const root of roots) {
    if (!isDir(root)) continue;
    for (const pluginName of fs.readdirSync(root)) {
      const pdir = path.join(root, pluginName);
      if (!isDir(pdir)) continue;

      const manifest = readSafe(path.join(pdir, '.claude-plugin', 'plugin.json'));
      let meta = {};
      try { meta = manifest ? JSON.parse(manifest) : {}; } catch { /* ignore */ }
      plugins.set(pluginName, { name: pluginName, description: meta.description || '', dir: pdir, commands: [], skills: [], agents: [] });

      const cdir = path.join(pdir, 'commands');
      for (const f of mdFiles(cdir)) {
        const text = readSafe(path.join(cdir, f));
        if (text == null) continue;
        const { meta: fm, body } = parseFrontmatter(text);
        const name = (fm.name || path.basename(f, '.md')).toLowerCase();
        commands.set(name, {
          name,
          description: fm.description || '',
          allowedTools: fm['allowed-tools'] || '',
          argumentHint: fm['argument-hint'] || '',
          model: fm.model || '',
          body,
          plugin: pluginName,
        });
        plugins.get(pluginName).commands.push(name);
      }

      const sdir = path.join(pdir, 'skills');
      if (isDir(sdir)) {
        for (const sub of fs.readdirSync(sdir)) {
          const skillFile = path.join(sdir, sub, 'SKILL.md');
          const text = readSafe(skillFile);
          if (text == null) continue;
          const { meta: fm, body } = parseFrontmatter(text);
          const name = (fm.name || sub).toLowerCase();
          skills.set(name, {
            name,
            description: fm.description || '',
            body,
            dir: path.join(sdir, sub),
            plugin: pluginName,
          });
          plugins.get(pluginName).skills.push(name);
        }
      }

      const adir = path.join(pdir, 'agents');
      for (const f of mdFiles(adir)) {
        const text = readSafe(path.join(adir, f));
        if (text == null) continue;
        const { meta: fm, body } = parseFrontmatter(text);
        const name = (fm.name || path.basename(f, '.md')).toLowerCase();
        agents.set(name, { name, description: fm.description || '', body, plugin: pluginName });
        plugins.get(pluginName).agents.push(name);
      }
    }
  }

  _cache = { key, val: { commands, skills, agents, plugins } };
  return _cache.val;
}

export function skillsSummary({ cwd } = {}) {
  const { skills } = loadPlugins({ cwd });
  return [...skills.values()].map((s) => `- ${s.name}: ${s.description}`).join('\n');
}

export function expandCommand(cmd, argsStr = '', { cwd = process.cwd() } = {}) {
  let body = cmd.body;

  const args = argsStr.trim();
  body = body.replace(/\$ARGUMENTS/g, args);
  const list = args ? args.split(/\s+/) : [];
  body = body.replace(/\$(\d+)/g, (_, n) => list[Number(n) - 1] ?? '');

  body = body.replace(/!`([^`]+)`/g, (_, c) => {
    const command = c.trim();
    if (checkDangerous(command)) return `(пропущено потенциально опасное: \`${command}\`)`;
    try {
      const out = execSync(command, {
        cwd, timeout: 15000, encoding: 'utf8', windowsHide: true,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return out.length > 8000 ? out.slice(0, 8000) + '\n… [обрезано]' : out;
    } catch (e) {
      return `(команда \`${command}\` не выполнилась: ${String(e.message).split('\n')[0]})`;
    }
  });

  return body.trim();
}
