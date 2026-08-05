import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { Provider, estimateTokens } from './provider.mjs';
import { PermissionEngine } from './permissions.mjs';
import { ALL_TOOLS, toolByName, toolSchemas, describeCall } from './tools.mjs';
import { GLOBAL_MEMORY, saveConfig } from './config.mjs';
import { skillsSummary } from './plugins.mjs';


export function loadMemory(cwd) {
  const parts = [];
  const read = (p, title) => {
    try {
      if (!fs.existsSync(p)) return;
      const t = fs.readFileSync(p, 'utf8').trim();
      if (t) parts.push(`# ${title}\n${t}`);
    } catch { /* ignore */ }
  };

  read(GLOBAL_MEMORY, 'Личные заметки пользователя (глобальные)');
  for (const name of ['CODEROOM.md', '.coderoom/CODEROOM.md', 'CLAUDE.md', 'AGENTS.md']) {
    read(path.join(cwd, name), `Инструкции проекта (${name})`);
  }
  return parts.join('\n\n');
}


function environmentBlock(cwd) {
  const lines = [
    `Рабочая папка: ${cwd}`,
    `ОС: ${process.platform} (${os.release()})`,
    `Оболочка: ${process.platform === 'win32' ? 'PowerShell' : process.env.SHELL || 'sh'}`,
    `Дата: ${new Date().toISOString().slice(0, 10)}`,
    `Git-репозиторий: ${fs.existsSync(path.join(cwd, '.git')) ? 'да' : 'нет'}`,
  ];
  try {
    const entries = fs
      .readdirSync(cwd, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .slice(0, 40)
      .map((e) => (e.isDirectory() ? e.name + '/' : e.name));
    if (entries.length) lines.push(`Содержимое папки: ${entries.join(', ')}`);
  } catch { /* ignore */ }
  return lines.join('\n');
}

export function buildSystemPrompt({ cwd, mode }) {
  const memory = loadMemory(cwd);
  let skillsList = '';
  try { skillsList = skillsSummary({ cwd }); } catch { /* плагины опциональны */ }
  const skillsBlock = skillsList
    ? `## Навыки (skills)

Есть специализированные навыки-инструкции. Когда задача подходит под навык — СНАЧАЛА вызови инструмент Skill("имя"), прочитай инструкции и следуй им. Особенно: любая работа над фронтендом/UI/вёрсткой/дизайном → сразу Skill("frontend-design").

Доступные навыки:
${skillsList}

`
    : '';
  const modeNote = {
    plan: 'РЕЖИМ ПЛАНИРОВАНИЯ: изменения запрещены. Исследуй код и предложи план. Не пытайся писать файлы или запускать команды.',
    acceptEdits: 'Правки файлов применяются без подтверждения. Команды в терминале всё равно требуют подтверждения.',
    yolo: 'Все действия разрешены без подтверждения. Будь особенно аккуратен с необратимыми операциями.',
    default: 'Изменения файлов и команды требуют подтверждения пользователя.',
  }[mode] ?? '';

  return `Ты — CodeRoom, агент для работы с кодом на компьютере пользователя. Ты работаешь прямо в его проекте: читаешь и меняешь файлы, запускаешь команды.

## Как себя вести

Отвечай кратко и по делу. Пользователь смотрит в терминал — не пиши длинных вступлений и не пересказывай то, что видно из результата. Задача выполнена — скажи одним-двумя предложениями, что сделано.

Не объясняй перед каждым вызовом инструмента, что собираешься сделать, — просто делай. Короткая реплика уместна, когда меняешь направление или наткнулся на проблему.

Отвечай на русском, если пользователь пишет по-русски. Код, пути и команды — как есть.

## Работа с кодом

Прежде чем менять файл — прочитай его (Read). Правки делай через Edit (точечная замена); Write — только для новых файлов или полной перезаписи.

Следуй стилю, который уже есть в проекте: отступы, кавычки, именование, структура. Посмотри соседние файлы, прежде чем изобретать своё.

Не комментируй очевидное. Комментарий нужен там, где неочевидно ПОЧЕМУ так сделано.

Не выдумывай зависимости. Проверь package.json / requirements.txt / go.mod, прежде чем что-то импортировать.

Не делай больше, чем просят: не рефактори соседний код «заодно», не добавляй обработку невозможных случаев, не пиши абстракции на будущее.

## Инструменты

Ищи через Grep и Glob — это быстрее, чем читать файлы подряд. Независимые действия вызывай параллельно, одним сообщением.

Bash — для сборки, тестов, git. Не читай и не пиши им файлы: для этого есть Read, Write, Edit.

Для задач в 3+ шага заведи план через Todo и держи его актуальным: ровно одна задача in_progress.

${skillsBlock}## Проверка

Если в проекте есть тесты или линтер — запусти их после изменений. Не объявляй задачу выполненной, если проверки падают. Команды проверки не выдумывай — найди их в package.json, Makefile или README.

## Окружение

${environmentBlock(cwd)}

${modeNote}${memory ? `\n\n---\n\n${memory}` : ''}`;
}

export class Agent {
  constructor({ cfg, session, ui = {}, cwd = process.cwd() }) {
    this.cfg = cfg;
    this.session = session;
    this.ui = ui;
    this.cwd = cwd;
    this.provider = new Provider(cfg);
    this.permissions = new PermissionEngine(cfg);
    this.tools = ALL_TOOLS;
    this.abortController = null;
    this.running = false;
  }

  get model() {
    return this.session.model ?? this.cfg.model;
  }

  interrupt() {
    this.abortController?.abort();
  }


  availableTools() {
    return this.permissions.mode === 'plan' ? this.tools.filter((t) => !t.mutating) : this.tools;
  }


  async send(userInput) {
    if (this.running) throw new Error('Агент уже занят');
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    if (userInput != null) this.session.addUser(userInput);

    const maxSteps = this.cfg.agent.maxSteps ?? 40;
    let step = 0;
    let finalText = '';
    let interrupted = false;

    try {
      while (step < maxSteps) {
        step++;
        this.ui.onStep?.(step, maxSteps);
        await this.#maybeCompact();

        const system = buildSystemPrompt({ cwd: this.cwd, mode: this.permissions.mode });
        let done = null;

        const stream = this.provider.stream({
          model: this.model,
          messages: this.session.messages,
          tools: toolSchemas(this.availableTools()),
          system,
          maxTokens: this.cfg.agent.maxTokens,
          temperature: this.cfg.agent.temperature,
          signal,
        });

        finalText = '';
        for await (const ev of stream) {
          switch (ev.type) {
            case 'text':
              finalText += ev.delta;
              this.ui.onText?.(ev.delta);
              break;
            case 'reasoning':
              if (this.cfg.agent.streamReasoning) this.ui.onReasoning?.(ev.delta);
              break;
            case 'tool_start':
              this.ui.onToolPending?.(ev.name);
              break;
            case 'retry':
              this.ui.onNotice?.(`Повтор запроса (${ev.attempt}): ${ev.error}`, 'warn');
              break;
            case 'done':
              done = ev;
              break;
          }
        }

        if (signal.aborted) { interrupted = true; break; }
        if (!done) throw new Error('Пустой ответ от модели');

        this.session.addAssistant(done.message);
        this.session.recordUsage(done.usage);
        if (done.usage) this.ui.onUsage?.(done.usage, this.session.usage);

        const calls = done.message.tool_calls ?? [];
        if (!calls.length) break;

        for (const call of calls) {
          if (signal.aborted) { interrupted = true; break; }
          await this.#runToolCall(call, signal);
        }
        if (interrupted) break;
      }

      if (step >= maxSteps) {
        this.ui.onNotice?.(
          `Достигнут лимит шагов (${maxSteps}). Задача может быть не завершена — напиши «продолжай».`,
          'warn',
        );
      }
    } catch (e) {
      if (signal.aborted) interrupted = true;
      else throw e;
    } finally {
      if (interrupted) this.#closeDanglingCalls();
      this.running = false;
      this.abortController = null;
      try { this.session.save(); } catch { /* диск не должен ронять сессию */ }
    }

    return { text: finalText, steps: step, interrupted };
  }


  #closeDanglingCalls() {
    const answered = new Set(
      this.session.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
    );
    for (const m of this.session.messages) {
      if (m.role !== 'assistant' || !m.tool_calls) continue;
      for (const c of m.tool_calls) {
        if (!answered.has(c.id)) {
          this.session.addToolResult(c.id, c.function.name, 'Прервано пользователем (Esc)');
          answered.add(c.id);
        }
      }
    }
  }

  async #runToolCall(call, signal) {
    const name = call.function.name;
    const tool = toolByName(name);

    let args;
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      this.session.addToolResult(
        call.id, name,
        `Ошибка: аргументы не разобрались как JSON: ${String(call.function.arguments).slice(0, 200)}`,
      );
      return;
    }

    if (!tool) {
      this.session.addToolResult(
        call.id, name,
        `Ошибка: инструмента «${name}» нет. Доступны: ${this.availableTools().map((t) => t.name).join(', ')}`,
      );
      return;
    }

    const label = describeCall(name, args);
    const callInfo = { id: call.id, name, args, label };
    this.ui.onToolStart?.(callInfo);

    const verdict = this.permissions.check(name, args, tool);

    if (verdict.decision === 'deny') {
      const msg = `Отказано: ${verdict.reason}`;
      this.ui.onToolError?.(callInfo, msg);
      this.session.addToolResult(call.id, name, msg);
      return;
    }

    if (verdict.decision === 'ask') {
      const answer = await this.ui.confirm?.({
        tool: name,
        args,
        label,
        reason: verdict.reason,
        danger: verdict.danger,
        preview: this.#preview(name, args),
      });

      if (answer === 'forever') {
        // «больше не спрашивай»: правило уходит в конфиг и живёт после перезапуска
        const rule = this.permissions.allowForever(name, args);
        try { saveConfig(this.cfg); } catch { /* не смогли записать — хотя бы на сессию */ }
        this.ui.onNotice?.(`Больше не спрашиваю: правило ${rule} сохранено (/config — посмотреть, /mode — сбросить)`, 'success');
      } else if (answer === 'always') {
        this.permissions.allowForSession(name, args);
      } else if (answer !== 'yes') {
        this.ui.onToolError?.(callInfo, 'Отклонено пользователем');
        this.session.addToolResult(
          call.id, name,
          'Пользователь отклонил этот вызов. Не повторяй его — предложи другой путь или спроси, как поступить.',
        );
        return;
      }
    }

    try {
      const result = await tool.run(args, {
        cwd: this.cwd,
        cfg: this.cfg,
        session: this.session,
        signal,
        onProgress: (chunk) => this.ui.onToolProgress?.(callInfo, chunk),
      });

      if (result?.meta?.path && (name === 'Write' || name === 'Edit')) {
        this.session.noteFile(result.meta.path, {
          before: result.meta.before,
          after: result.meta.after,
        });
      }

      this.ui.onToolResult?.(callInfo, result);
      this.session.addToolResult(call.id, name, result.output ?? '(пусто)');
    } catch (e) {
      const msg = `Ошибка: ${e.message}`;
      this.ui.onToolError?.(callInfo, msg);
      this.session.addToolResult(call.id, name, msg);
    }
  }


  #preview(name, args) {
    try {
      if (name === 'Write') {
        const abs = path.resolve(this.cwd, args.path ?? '');
        const existed = fs.existsSync(abs);
        return {
          kind: 'write',
          path: args.path,
          before: existed ? fs.readFileSync(abs, 'utf8') : '',
          after: args.content ?? '',
          existed,
        };
      }
      if (name === 'Edit') {
        const abs = path.resolve(this.cwd, args.path ?? '');
        if (!fs.existsSync(abs)) return null;
        const before = fs.readFileSync(abs, 'utf8');
        const after = args.replace_all
          ? before.split(args.old_string).join(args.new_string)
          : before.replace(args.old_string, args.new_string);
        return { kind: 'edit', path: args.path, before, after, existed: true };
      }
      if (name === 'Bash') return { kind: 'bash', command: args.command };
    } catch { /* превью не критично */ }
    return null;
  }


  async #maybeCompact() {
    const limit = this.cfg.agent.autoCompactAt ?? 140000;
    const tokens = estimateTokens(this.session.messages);
    if (tokens < limit) return;

    this.ui.onNotice?.(`Контекст ~${Math.round(tokens / 1000)}k токенов — сжимаю историю…`, 'info');

    const keepTail = 6;
    const head = this.session.messages.slice(0, 2);
    const middle = this.session.messages.slice(2, -keepTail);
    let tail = this.session.messages.slice(-keepTail);
    if (middle.length < 4) return;

    while (tail.length && tail[0].role === 'tool') tail = tail.slice(1);

    const transcript = middle
      .map((m) => {
        const who = m.role === 'tool' ? `[инструмент ${m.name}]` : m.role;
        const body = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
        return `${who}: ${body.slice(0, 1500)}`;
      })
      .join('\n')
      .slice(0, 60000);

    try {
      const stream = this.provider.stream({
        model: this.cfg.smallModel ?? this.model,
        messages: [{
          role: 'user',
          content:
            'Ниже фрагмент рабочего диалога агента с пользователем. Сожми его в структурированную сводку: ' +
            'что просил пользователь, какие файлы изменены и как, какие решения приняты, что осталось сделать. ' +
            'Сохрани конкретику: пути, имена функций, команды.\n\n' + transcript,
        }],
        maxTokens: 1500,
        temperature: 0,
      });

      let summary = '';
      for await (const ev of stream) if (ev.type === 'text') summary += ev.delta;

      if (summary.trim()) {
        this.session.messages = [
          ...head,
          { role: 'user', content: `[Сводка предыдущей части разговора]\n\n${summary.trim()}` },
          { role: 'assistant', content: 'Принято, продолжаю с учётом этого контекста.' },
          ...tail,
        ];
        this.ui.onNotice?.('История сжата.', 'success');
      }
    } catch (e) {
      this.session.messages = [...head, ...tail];
      this.ui.onNotice?.(`Не удалось сжать историю (${e.message}); старое обрезано.`, 'warn');
    }
  }
}
