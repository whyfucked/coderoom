import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SESSIONS_DIR, projectId, ensureConfigDir } from './config.mjs';

export class Session {
  constructor({ cwd = process.cwd(), id, model, provider } = {}) {
    this.cwd = cwd;
    this.id = id ?? crypto.randomBytes(6).toString('hex');
    this.projectId = projectId(cwd);
    this.model = model;
    this.provider = provider;
    this.createdAt = new Date().toISOString();
    this.updatedAt = this.createdAt;

    this.messages = [];

    this.todos = [];
    this.usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0 };
    this.title = '';

    this.touchedFiles = new Map();
  }

  get dir() {
    return path.join(SESSIONS_DIR, this.projectId);
  }
  get file() {
    return path.join(this.dir, `${this.id}.json`);
  }

  addUser(content) {
    this.messages.push({ role: 'user', content });
    if (!this.title) this.title = content.slice(0, 60).replace(/\s+/g, ' ').trim();
    this.touch();
  }

  addAssistant(message) {
    this.messages.push(message);
    this.touch();
  }

  addToolResult(toolCallId, name, content) {
    this.messages.push({
      role: 'tool',
      tool_call_id: toolCallId,
      name,
      content: typeof content === 'string' ? content : JSON.stringify(content),
    });
    this.touch();
  }

  recordUsage(u) {
    if (!u) return;
    this.usage.input += u.input ?? 0;
    this.usage.output += u.output ?? 0;
    this.usage.cacheRead += u.cacheRead ?? 0;
    this.usage.cacheWrite += u.cacheWrite ?? 0;
    this.usage.requests += 1;
  }

  noteFile(relPath, { before, after } = {}) {
    const prev = this.touchedFiles.get(relPath);
    this.touchedFiles.set(relPath, {
      before: prev?.before ?? before,
      after,
    });
  }

  touch() {
    this.updatedAt = new Date().toISOString();
  }

  save() {
    ensureConfigDir();
    fs.mkdirSync(this.dir, { recursive: true });
    const data = {
      id: this.id,
      cwd: this.cwd,
      projectId: this.projectId,
      model: this.model,
      provider: this.provider,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      title: this.title,
      messages: this.messages,
      todos: this.todos,
      usage: this.usage,
    };
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.file);
    return this.file;
  }

  static load(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const s = new Session({ cwd: data.cwd, id: data.id, model: data.model, provider: data.provider });
    Object.assign(s, {
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      title: data.title ?? '',
      messages: data.messages ?? [],
      todos: data.todos ?? [],
      usage: data.usage ?? s.usage,
    });
    return s;
  }


  static list(cwd = process.cwd(), limit = 20) {
    const dir = path.join(SESSIONS_DIR, projectId(cwd));
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const full = path.join(dir, f);
        try {
          const d = JSON.parse(fs.readFileSync(full, 'utf8'));
          return {
            file: full,
            id: d.id,
            title: d.title || '(без названия)',
            updatedAt: d.updatedAt,
            messages: (d.messages ?? []).filter((m) => m.role === 'user').length,
            model: d.model,
          };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .slice(0, limit);
  }

  static latest(cwd = process.cwd()) {
    const [first] = Session.list(cwd, 1);
    return first ? Session.load(first.file) : null;
  }
}
