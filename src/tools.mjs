import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { safeResolve, redactSecrets, globToRegExp } from './permissions.mjs';
import { loadPlugins } from './plugins.mjs';

const MAX_READ_BYTES = 400_000;
const MAX_OUTPUT_CHARS = 60_000;


const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', '.idea', '.vscode', 'coverage', '.cache',
  '.pytest_cache', '.mypy_cache', 'vendor', '.gradle', 'bin', 'obj',
]);

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.pdf', '.zip',
  '.gz', '.tar', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib', '.class',
  '.jar', '.mp3', '.mp4', '.avi', '.mov', '.woff', '.woff2', '.ttf', '.eot',
  '.pyc', '.wasm', '.bin', '.db', '.sqlite',
]);

function truncate(text, limit = MAX_OUTPUT_CHARS) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  const cut = text.length - limit;
  return `${text.slice(0, half)}\n\n… [обрезано ${cut} символов] …\n\n${text.slice(-half)}`;
}

function rel(cwd, abs) {
  const r = path.relative(cwd, abs);
  return r && !r.startsWith('..') ? r.replace(/\\/g, '/') : abs.replace(/\\/g, '/');
}


async function* walk(dir, cwd, { maxDepth = 12, depth = 0 } = {}) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name) || e.name.startsWith('.') && IGNORED_DIRS.has(e.name)) continue;
      if (IGNORED_DIRS.has(e.name)) continue;
      yield { path: full, dir: true };
      yield* walk(full, cwd, { maxDepth, depth: depth + 1 });
    } else if (e.isFile()) {
      yield { path: full, dir: false };
    }
  }
}



export const ReadTool = {
  name: 'Read',
  description:
    'Прочитать файл из рабочей папки. Возвращает содержимое с номерами строк. ' +
    'Используй ПЕРЕД тем как редактировать файл. Для больших файлов указывай offset/limit.',
  mutating: false,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу (относительный или абсолютный)' },
      offset: { type: 'number', description: 'С какой строки начать (1-based)' },
      limit: { type: 'number', description: 'Сколько строк прочитать (по умолчанию 2000)' },
    },
    required: ['path'],
  },
  async run({ path: p, offset = 1, limit = 2000 }, { cwd, cfg }) {
    const abs = safeResolve(cwd, p, cfg);

    const st = await fsp.stat(abs).catch(() => null);
    if (!st) throw new Error(`Файл не найден: ${p}`);
    if (st.isDirectory()) throw new Error(`Это папка, не файл: ${p}. Используй List.`);

    const ext = path.extname(abs).toLowerCase();
    if (BINARY_EXT.has(ext)) {
      return { output: `[бинарный файл ${ext}, ${st.size} байт — содержимое не показано]` };
    }
    if (st.size > MAX_READ_BYTES) {
      return {
        output:
          `[файл слишком большой: ${(st.size / 1024).toFixed(0)} КБ]\n` +
          `Читай кусками через offset/limit или используй Grep для поиска.`,
      };
    }

    const content = await fsp.readFile(abs, 'utf8');
    const lines = content.split('\n');
    const start = Math.max(0, offset - 1);
    const slice = lines.slice(start, start + limit);

    const width = String(start + slice.length).length;
    const numbered = slice
      .map((l, i) => `${String(start + i + 1).padStart(width)} | ${l}`)
      .join('\n');

    const more = lines.length > start + slice.length
      ? `\n… ещё ${lines.length - start - slice.length} строк (всего ${lines.length})`
      : '';

    return {
      output: redactSecrets(truncate(numbered) + more, cfg),
      meta: { lines: lines.length, bytes: st.size, path: rel(cwd, abs) },
    };
  },
};

export const WriteTool = {
  name: 'Write',
  description:
    'Создать файл или полностью перезаписать существующий. ' +
    'Для точечных правок используй Edit — он безопаснее. ' +
    'Существующий файл сначала прочитай через Read.',
  mutating: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу' },
      content: { type: 'string', description: 'Полное содержимое файла' },
    },
    required: ['path', 'content'],
  },
  async run({ path: p, content }, { cwd, cfg }) {
    const abs = safeResolve(cwd, p, cfg, { forWrite: true });
    const existed = fs.existsSync(abs);
    const before = existed ? await fsp.readFile(abs, 'utf8').catch(() => '') : '';

    await fsp.mkdir(path.dirname(abs), { recursive: true });
    await fsp.writeFile(abs, content, 'utf8');

    const lines = content.split('\n').length;
    return {
      output: existed
        ? `Файл перезаписан: ${rel(cwd, abs)} (${lines} строк, было ${before.split('\n').length})`
        : `Файл создан: ${rel(cwd, abs)} (${lines} строк)`,
      meta: { path: rel(cwd, abs), created: !existed, before, after: content },
    };
  },
};

export const EditTool = {
  name: 'Edit',
  description:
    'Точечная замена в файле: найти old_string и заменить на new_string. ' +
    'old_string должен встречаться РОВНО ОДИН раз — добавь контекста вокруг, если нужно. ' +
    'Обязательно прочитай файл через Read перед правкой.',
  mutating: true,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Путь к файлу' },
      old_string: { type: 'string', description: 'Что заменить (точное совпадение, с отступами)' },
      new_string: { type: 'string', description: 'На что заменить' },
      replace_all: { type: 'boolean', description: 'Заменить все вхождения (по умолчанию false)' },
    },
    required: ['path', 'old_string', 'new_string'],
  },
  async run({ path: p, old_string, new_string, replace_all = false }, { cwd, cfg }) {
    const abs = safeResolve(cwd, p, cfg, { forWrite: true });
    if (!fs.existsSync(abs)) throw new Error(`Файл не найден: ${p}`);

    const before = await fsp.readFile(abs, 'utf8');

    if (old_string === new_string) throw new Error('old_string и new_string одинаковые — нечего менять');

    const count = before.split(old_string).length - 1;
    if (count === 0) {
      const trimmed = old_string.trim();
      const hint = before.includes(trimmed)
        ? '\nПодсказка: текст найден, но с другими отступами. Скопируй строку точно из Read.'
        : '\nПодсказка: перечитай файл через Read — возможно, содержимое изменилось.';
      throw new Error(`Не нашёл old_string в ${rel(cwd, abs)}${hint}`);
    }
    if (count > 1 && !replace_all) {
      throw new Error(
        `old_string встречается ${count} раз в ${rel(cwd, abs)}. ` +
          `Добавь окружающий контекст, чтобы совпадение было единственным, либо передай replace_all: true.`,
      );
    }

    const after = replace_all
      ? before.split(old_string).join(new_string)
      : before.replace(old_string, new_string);

    await fsp.writeFile(abs, after, 'utf8');

    return {
      output: `Изменён ${rel(cwd, abs)} — заменено вхождений: ${replace_all ? count : 1}`,
      meta: { path: rel(cwd, abs), before, after, replacements: replace_all ? count : 1 },
    };
  },
};

export const ListTool = {
  name: 'List',
  description: 'Показать содержимое папки (файлы и подпапки). Служебные папки вроде node_modules пропускаются.',
  mutating: false,
  schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Папка (по умолчанию — рабочая)' },
      depth: { type: 'number', description: 'Глубина вложенности, по умолчанию 2' },
    },
  },
  async run({ path: p = '.', depth = 2 }, { cwd, cfg }) {
    const abs = safeResolve(cwd, p, cfg);
    const st = await fsp.stat(abs).catch(() => null);
    if (!st) throw new Error(`Папка не найдена: ${p}`);
    if (!st.isDirectory()) throw new Error(`Это файл, не папка: ${p}`);

    const lines = [];
    const render = async (dir, prefix, d) => {
      if (d > depth) return;
      let entries;
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => (a.isDirectory() === b.isDirectory() ? a.name.localeCompare(b.name) : a.isDirectory() ? -1 : 1));

      for (const e of entries) {
        if (IGNORED_DIRS.has(e.name)) {
          lines.push(`${prefix}${e.name}/ …пропущено`);
          continue;
        }
        if (e.isDirectory()) {
          lines.push(`${prefix}${e.name}/`);
          await render(path.join(dir, e.name), prefix + '  ', d + 1);
        } else {
          const s = await fsp.stat(path.join(dir, e.name)).catch(() => null);
          const size = s ? (s.size < 1024 ? `${s.size}B` : `${(s.size / 1024).toFixed(0)}K`) : '';
          lines.push(`${prefix}${e.name}  ${size}`);
        }
        if (lines.length > 1500) return;
      }
    };
    await render(abs, '', 1);

    return { output: `${rel(cwd, abs)}/\n` + truncate(lines.join('\n')), meta: { count: lines.length } };
  },
};

export const GlobTool = {
  name: 'Glob',
  description:
    'Найти файлы по glob-шаблону, например "src/**/*.ts" или "**/*.json". ' +
    'Быстрый способ понять структуру проекта. Результат отсортирован по времени изменения.',
  mutating: false,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob-шаблон, например **/*.js' },
      path: { type: 'string', description: 'Где искать (по умолчанию — рабочая папка)' },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: base = '.' }, { cwd, cfg }) {
    const root = safeResolve(cwd, base, cfg);
    const re = globToRegExp(pattern.replace(/\\/g, '/'));
    const found = [];

    for await (const entry of walk(root, cwd, { maxDepth: 14 })) {
      if (entry.dir) continue;
      const r = path.relative(root, entry.path).replace(/\\/g, '/');
      if (re.test(r) || re.test(path.basename(r))) {
        const st = await fsp.stat(entry.path).catch(() => null);
        found.push({ path: rel(cwd, entry.path), mtime: st?.mtimeMs ?? 0 });
      }
      if (found.length > 800) break;
    }

    found.sort((a, b) => b.mtime - a.mtime);
    if (!found.length) return { output: `Ничего не найдено по шаблону: ${pattern}` };

    return {
      output: `Найдено ${found.length}:\n` + found.map((f) => f.path).join('\n'),
      meta: { count: found.length },
    };
  },
};

export const GrepTool = {
  name: 'Grep',
  description:
    'Поиск по содержимому файлов (регулярное выражение). ' +
    'Основной способ ориентироваться в незнакомой кодовой базе: ищи имена функций, строки, импорты.',
  mutating: false,
  schema: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Регулярное выражение' },
      path: { type: 'string', description: 'Где искать (по умолчанию — рабочая папка)' },
      glob: { type: 'string', description: 'Фильтр файлов, например "*.ts"' },
      ignore_case: { type: 'boolean', description: 'Игнорировать регистр' },
      context: { type: 'number', description: 'Сколько строк контекста вокруг совпадения (0-5)' },
    },
    required: ['pattern'],
  },
  async run({ pattern, path: base = '.', glob, ignore_case = false, context = 0 }, { cwd, cfg, signal }) {
    const root = safeResolve(cwd, base, cfg);

    let re;
    try {
      re = new RegExp(pattern, ignore_case ? 'i' : '');
    } catch (e) {
      throw new Error(`Некорректное регулярное выражение: ${e.message}`);
    }
    const globRe = glob ? globToRegExp(glob) : null;
    const ctx = Math.min(Math.max(context, 0), 5);

    const results = [];
    let filesScanned = 0;
    let matchCount = 0;

    for await (const entry of walk(root, cwd, { maxDepth: 14 })) {
      if (signal?.aborted) break;
      if (entry.dir) continue;

      const ext = path.extname(entry.path).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;

      const r = path.relative(root, entry.path).replace(/\\/g, '/');
      if (globRe && !globRe.test(r) && !globRe.test(path.basename(r))) continue;

      const st = await fsp.stat(entry.path).catch(() => null);
      if (!st || st.size > MAX_READ_BYTES) continue;

      let content;
      try {
        content = await fsp.readFile(entry.path, 'utf8');
      } catch {
        continue;
      }
      filesScanned++;
      if (!re.test(content)) continue;

      const lines = content.split('\n');
      const hits = [];
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          matchCount++;
          if (ctx > 0) {
            const from = Math.max(0, i - ctx);
            const to = Math.min(lines.length - 1, i + ctx);
            const block = [];
            for (let j = from; j <= to; j++) {
              block.push(`${j === i ? '>' : ' '} ${j + 1}: ${lines[j]}`);
            }
            hits.push(block.join('\n'));
          } else {
            hits.push(`  ${i + 1}: ${lines[i].trim().slice(0, 200)}`);
          }
          if (hits.length >= 20) break;
        }
      }
      if (hits.length) results.push(`${rel(cwd, entry.path)}\n${hits.join(ctx > 0 ? '\n  --\n' : '\n')}`);
      if (results.length > 60) break;
    }

    if (!results.length) {
      return { output: `Совпадений не найдено: /${pattern}/ (просмотрено файлов: ${filesScanned})` };
    }
    return {
      output: redactSecrets(
        `Совпадений: ${matchCount} в ${results.length} файлах\n\n${truncate(results.join('\n\n'))}`,
        cfg,
      ),
      meta: { matches: matchCount, files: results.length },
    };
  },
};

export const BashTool = {
  name: 'Bash',
  description:
    'Выполнить команду в системной оболочке (на Windows — PowerShell, иначе sh). ' +
    'Для запуска тестов, сборки, git. НЕ используй для чтения/записи файлов — есть Read/Write/Edit. ' +
    'Команда выполняется в рабочей папке проекта.',
  mutating: true,
  requiresExplicitApproval: true,
  schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Команда для выполнения' },
      timeout: { type: 'number', description: 'Таймаут в секундах (по умолчанию 120)' },
      description: { type: 'string', description: 'Коротко: что делает команда (для показа пользователю)' },
    },
    required: ['command'],
  },
  async run({ command, timeout = 120 }, { cwd, cfg, signal, onProgress }) {
    const isWin = process.platform === 'win32';
    const shell = isWin
      ? (process.env.COMSPEC?.toLowerCase().includes('powershell')
          ? 'powershell.exe'
          : 'powershell.exe')
      : (process.env.SHELL || '/bin/sh');
    const args = isWin ? ['-NoProfile', '-NonInteractive', '-Command', command] : ['-c', command];

    return await new Promise((resolve, reject) => {
      const child = spawn(shell, args, {
        cwd,
        env: { ...process.env, GIT_PAGER: 'cat', PAGER: 'cat', NO_COLOR: '1' },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      const timer = setTimeout(() => {
        killed = true;
        child.kill('SIGKILL');
      }, timeout * 1000);

      const onAbort = () => {
        killed = true;
        child.kill('SIGKILL');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      child.stdout.on('data', (d) => {
        const s = d.toString();
        stdout += s;
        onProgress?.(s);
        if (stdout.length > MAX_OUTPUT_CHARS * 2) child.kill('SIGKILL');
      });
      child.stderr.on('data', (d) => {
        const s = d.toString();
        stderr += s;
        onProgress?.(s);
      });

      child.on('error', (e) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(new Error(`Не удалось запустить команду: ${e.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);

        const parts = [];
        if (stdout.trim()) parts.push(stdout.trim());
        if (stderr.trim()) parts.push(`[stderr]\n${stderr.trim()}`);
        if (killed) parts.push(signal?.aborted ? '[прервано пользователем]' : `[превышен таймаут ${timeout}с]`);
        if (!parts.length) parts.push('(нет вывода)');

        const body = redactSecrets(truncate(parts.join('\n')), cfg);
        resolve({
          output: code === 0 ? body : `Код возврата: ${code}\n${body}`,
          meta: { exitCode: code, killed },
        });
      });
    });
  },
};

export const TodoTool = {
  name: 'Todo',
  description:
    'Вести список задач для сложной многошаговой работы. ' +
    'Вызывай в начале задачи, чтобы наметить план, и обновляй статус по мере выполнения. ' +
    'Ровно одна задача должна быть in_progress.',
  mutating: false,
  schema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Полный список задач (перезаписывает предыдущий)',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Что нужно сделать' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
  async run({ todos }, { session }) {
    session.todos = todos;
    const icon = { pending: '○', in_progress: '◐', completed: '●' };
    const done = todos.filter((t) => t.status === 'completed').length;
    return {
      output:
        `План (${done}/${todos.length}):\n` +
        todos.map((t) => `${icon[t.status] ?? '○'} ${t.content}`).join('\n'),
      meta: { todos },
    };
  },
};

export const WebFetchTool = {
  name: 'WebFetch',
  description:
    'Скачать страницу по URL и получить её текст (HTML очищается от разметки). ' +
    'Полезно для чтения документации. Только http/https.',
  mutating: false,
  schema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Адрес страницы' },
      max_chars: { type: 'number', description: 'Ограничение на объём текста (по умолчанию 15000)' },
    },
    required: ['url'],
  },
  async run({ url, max_chars = 15000 }, { signal, cfg }) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`Некорректный URL: ${url}`);
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error('Разрешены только http и https');
    }
    const host = parsed.hostname;
    if (/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|169\.254\.|\[?::1)/i.test(host)) {
      throw new Error('Запросы к локальной сети заблокированы');
    }

    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctrl.abort(), 30000);

    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CodeRoom/0.1)' },
        redirect: 'follow',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      const type = res.headers.get('content-type') ?? '';
      let text = await res.text();

      if (type.includes('html')) {
        text = text
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<!--[\s\S]*?-->/g, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/&nbsp;/g, ' ')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&amp;/g, '&')
          .replace(/&quot;/g, '"')
          .replace(/[ \t]+/g, ' ')
          .replace(/\n\s*\n\s*\n+/g, '\n\n')
          .trim();
      }

      return {
        output: redactSecrets(truncate(text, max_chars), cfg),
        meta: { url, contentType: type, bytes: text.length },
      };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  },
};

export const SkillTool = {
  name: 'Skill',
  description:
    'Загрузить инструкции специализированного навыка (skill). Вызывай, когда задача подходит под доступный навык — их список с описаниями есть в системном промпте. ' +
    'ОСОБЕННО: для любой работы над UI, вёрсткой, дизайном фронтенда — сначала вызови Skill("frontend-design"). ' +
    'Возвращает подробные инструкции; следуй им при выполнении задачи.',
  mutating: false,
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Имя навыка, например frontend-design' },
    },
    required: ['name'],
  },
  async run({ name }, { cwd }) {
    const { skills } = loadPlugins({ cwd });
    const skill = skills.get(String(name ?? '').toLowerCase());
    if (!skill) {
      return { output: `Навыка «${name}» нет. Доступные: ${[...skills.keys()].join(', ') || '(пусто)'}` };
    }
    return {
      output: `# Навык: ${skill.name}\n${skill.description ? '\n' + skill.description + '\n' : ''}\n---\n\n${skill.body.trim()}`,
      meta: { skill: skill.name },
    };
  },
};

export const ALL_TOOLS = [
  ReadTool, WriteTool, EditTool, ListTool,
  GlobTool, GrepTool, BashTool, TodoTool, WebFetchTool, SkillTool,
];

export function toolByName(name) {
  return ALL_TOOLS.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
}


export function toolSchemas(tools = ALL_TOOLS) {
  return tools.map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
}


export function describeCall(name, args) {
  switch (name) {
    case 'Bash':
      return args?.description ? `${args.description}` : `$ ${(args?.command ?? '').slice(0, 80)}`;
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'List':
      return `${name}(${args?.path ?? '?'})`;
    case 'Glob':
      return `Glob(${args?.pattern ?? '?'})`;
    case 'Grep':
      return `Grep(/${args?.pattern ?? '?'}/${args?.glob ? ` в ${args.glob}` : ''})`;
    case 'WebFetch':
      return `WebFetch(${args?.url ?? '?'})`;
    case 'Skill':
      return `Skill(${args?.name ?? '?'})`;
    case 'Todo':
      return `Todo(${args?.todos?.length ?? 0} задач)`;
    default:
      return name;
  }
}
