import fs from 'node:fs';
import path from 'node:path';
import { stdin, stdout } from 'node:process';
import { createTheme, THEMES, WEB_THEMES } from './themes.mjs';
import {
  Spinner, StreamRenderer, renderMarkdown, renderDiff, box, fmtNum, termWidth, setTerminalTitle,
  progressBar, truncate, visLen, glyphs, unicodeOK,
} from './render.mjs';
import { createInput } from './input.mjs';
import { select } from './select.mjs';
import { onKey, release as releaseKeys } from './keys.mjs';
import { notify } from './screen.mjs';
import { Agent } from './agent.mjs';
import { Session } from './session.mjs';
import { Provider, estimateTokens } from './provider.mjs';
import { MODES, ruleFor } from './permissions.mjs';
import {
  saveConfig, resolveProvider, maskKey, CONFIG_FILE, CONFIG_DIR,
  PROVIDER_PRESETS, MODEL_TIERS, GLOBAL_MEMORY, DEFAULT_CONFIG,
} from './config.mjs';
import { changeKey, VERSION } from './onboarding.mjs';
import { loadPlugins, expandCommand } from './plugins.mjs';
import {
  addHost, removeHost, listHosts, getHost, useKey, markOk, parseTarget,
  ensureKeyPair, copyPublicKey, setHostPassword, getHostPassword, setAuthMode, configureSshd,
  KEY_FILE, runRemote, connectRemote, connectSftp,
} from './ssh.mjs';
import {
  checkForUpdates, shouldPrompt, runUpdate, updateCommand, updateSettings,
  snoozeUpdate, skipVersion, setUpdateCheck, setAutoInstall, resetUpdateSnooze, detectInstall,
} from './update-checker.mjs';

export class Repl {
  constructor({ cfg, cwd = process.cwd(), session }) {
    this.cfg = cfg;
    this.cwd = cwd;
    this.t = createTheme(cfg.theme);
    this.session = session ?? new Session({ cwd, model: cfg.model, provider: cfg.provider });
    this.spinner = new Spinner(this.t);
    this.stream = null;
    this.input = null;
    this.offKeys = null;
    this.exiting = false;
    this.queue = [];
    this.modelChoices = [];
    try { this.plugins = loadPlugins({ cwd }); } catch { this.plugins = { commands: new Map(), skills: new Map(), agents: new Map(), plugins: new Map() }; }

    // проверку обновлений запускаем сразу в фоне: к первому вопросу ответ уже будет
    this.updateCheck = updateSettings(cfg).check
      ? checkForUpdates({ cfg, silent: true }).catch(() => null)
      : Promise.resolve(null);

    this.agent = new Agent({
      cfg,
      session: this.session,
      cwd,
      ui: this.#buildUi(),
    });
    this.sshHost = null;
  }



  #buildUi() {
    const t = this.t;

    return {
      onStep: () => {
        if (!this.spinner.active) this.spinner.start();
      },

      onText: (delta) => {
        this.spinner.stop();
        this.stream ??= new StreamRenderer(t, stdout);
        this.stream.write(delta);
      },

      onReasoning: (delta) => {
        if (!this.cfg.agent.streamReasoning) return;
        this.spinner.update(delta.replace(/\s+/g, ' ').trim().slice(-70));
      },

      onToolStart: (call) => {
        this.#flushStream();
        this.spinner.stop();
        const icon = t.primary(t.symbols.tool);
        stdout.write(`  ${icon} ${t.bold(call.name)} ${t.muted(this.#argSummary(call))}\n`);
      },

      onToolProgress: () => {
        if (!this.spinner.active) this.spinner.start('выполняю…');
      },

      onToolResult: (call, result) => {
        this.spinner.stop();
        const lines = String(result.output ?? '').split('\n');
        const max = this.cfg.ui.maxToolOutputLines ?? 24;
        const shown = this.cfg.ui.compactToolOutput ? lines.slice(0, max) : lines;

        if ((call.name === 'Write' || call.name === 'Edit') && result.meta?.before !== undefined) {
          const d = renderDiff(result.meta.before, result.meta.after, t, { indent: '     ' });
          stdout.write(`  ${t.muted(t.symbols.toolDone)} ${t.success(`+${d.adds}`)} ${t.error(`-${d.dels}`)} ${t.muted(result.meta.path)}\n`);
          if (d.text) stdout.write(d.text + '\n');
          stdout.write('\n');
          return;
        }

        stdout.write(`  ${t.muted(t.symbols.toolDone)} ${t.muted(shown[0] ?? '')}\n`);
        for (const l of shown.slice(1)) stdout.write(`     ${t.muted(l)}\n`);
        if (lines.length > shown.length) {
          stdout.write(`     ${t.muted(`… ещё ${lines.length - shown.length} строк`)}\n`);
        }
        stdout.write('\n');
      },

      onToolError: (call, msg) => {
        this.spinner.stop();
        stdout.write(`  ${t.error(t.symbols.cross)} ${t.error(msg.split('\n')[0])}\n`);
        for (const l of msg.split('\n').slice(1, 6)) stdout.write(`     ${t.muted(l)}\n`);
        stdout.write('\n');
      },

      onNotice: (text, level = 'info') => {
        this.spinner.stop();
        const paint = { warn: t.warn, error: t.error, success: t.success, info: t.muted }[level] ?? t.muted;
        stdout.write(`  ${paint(text)}\n`);
      },

      onUsage: (usage) => {
        if (!this.cfg.ui.showTokenUsage) return;
        this.lastUsage = usage;
      },

      confirm: (req) => this.#confirm(req),
    };
  }

  #argSummary(call) {
    const a = call.args ?? {};
    switch (call.name) {
      case 'Bash': return a.description ? `— ${a.description}` : `— ${String(a.command).split('\n')[0].slice(0, 70)}`;
      case 'Read': case 'Write': case 'Edit': case 'List': return a.path ?? '';
      case 'Glob': return a.pattern ?? '';
      case 'Grep': return `/${a.pattern}/${a.glob ? ` в ${a.glob}` : ''}`;
      case 'WebFetch': return a.url ?? '';
      case 'Todo': return `${a.todos?.length ?? 0} пунктов`;
      default: return '';
    }
  }

  #flushStream() {
    if (this.stream) {
      this.stream.flush();
      this.stream = null;
    }
  }



  async #confirm(req) {
    this.spinner.stop();
    this.#flushStream();
    const t = this.t;

    if (req.preview?.kind === 'bash') {
      stdout.write('\n' + t.muted('  команда') + '\n');
      for (const l of String(req.preview.command).split('\n')) {
        stdout.write('  ' + t.muted(t.symbols.toolDone) + ' ' + t.code(truncate(l, termWidth() - 6)) + '\n');
      }
    } else if (req.preview?.kind === 'write' || req.preview?.kind === 'edit') {
      const p = req.preview;
      const d = renderDiff(p.before, p.after, t, { context: 2, maxLines: 30, indent: '  ' });
      stdout.write('\n  ' + (p.existed ? t.muted('изменить ') : t.muted('создать ')) + t.bold(p.path)
        + '  ' + t.success(`+${d.adds}`) + ' ' + t.error(`-${d.dels}`) + '\n');
      if (d.text) stdout.write(d.text + '\n');
    }

    const danger = req.danger ? `⚠  ${req.danger}` : null;

    // «Больше не спрашивать» не предлагаем для опасных команд — там осознанность важнее удобства
    const rule = ruleFor(req.tool, req.args);
    const options = [
      { label: 'Разрешить', hint: 'один раз' },
      { label: 'Разрешить все такие', hint: 'до конца сессии' },
    ];
    if (!req.danger) options.push({ label: 'Больше не спрашивать', hint: `запомнить правило ${rule}` });
    options.push({ label: 'Отклонить', hint: 'агент предложит другой путь' });

    const pick = await select({
      theme: t,
      title: danger ? danger : `Разрешить ${req.tool}?`,
      subtitle: req.label ? truncate(req.label, termWidth() - 6) : req.reason,
      options,
      footer: 'Enter выбрать · Esc отклонить · Shift+Tab — режим без вопросов',
    });

    if (pick < 0) return 'no';
    const answer = options[pick]?.label;
    if (answer === 'Разрешить') return 'yes';
    if (answer === 'Разрешить все такие') return 'always';
    if (answer === 'Больше не спрашивать') return 'forever';
    return 'no';
  }



  get commands() {
    return {
      help:    { desc: 'список команд',                run: () => this.#cmdHelp() },
      provider:{ desc: 'сменить провайдера',           run: (a) => this.#cmdProvider(a) },
      gateway: { desc: 'адрес шлюза: /gateway <url>',  run: (a) => this.#cmdGateway(a) },
      model:   { desc: 'сменить модель',               run: (a) => this.#cmdModel(a) },
      prompt:  { desc: 'свои промты: /prompt add|use|off|list', run: (a) => this.#cmdPrompt(a) },
      theme:   { desc: 'сменить дизайн терминала',     run: (a) => this.#cmdTheme(a) },
      mode:    { desc: 'режим доступа агента',         run: (a) => this.#cmdMode(a) },
      key:     { desc: 'сменить API-ключ',             run: async () => { await changeKey(this.cfg); this.agent.provider = new Provider(this.cfg); } },
      config:  { desc: 'показать настройки',           run: () => this.#cmdConfig() },
      status:  { desc: 'состояние сессии',             run: () => this.#cmdStatus() },
      clear:   { desc: 'очистить историю',             run: () => this.#cmdClear() },
      compact: { desc: 'сжать историю вручную',        run: () => this.#cmdCompact() },
      diff:    { desc: 'изменённые файлы за сессию',   run: () => this.#cmdDiff() },
      todo:    { desc: 'текущий план',                 run: () => this.#cmdTodo() },
      sessions:{ desc: 'список сессий проекта',        run: () => this.#cmdSessions() },
      resume:  { desc: 'продолжить сессию: /resume <id>', run: (a) => this.#cmdResume(a) },
      memory:  { desc: 'открыть файл памяти проекта',  run: () => this.#cmdMemory() },
      web:     { desc: 'запустить интерфейс в браузере', run: () => this.#cmdWeb() },
      cost:    { desc: 'расход токенов',               run: () => this.#cmdCost() },
      init:    { desc: 'создать CODEROOM.md для проекта', run: () => this.#cmdInit() },
      context: { desc: 'что занимает контекст',        run: () => this.#cmdContext() },
      export:  { desc: 'сохранить диалог в markdown',  run: (a) => this.#cmdExport(a) },
      cwd:     { desc: 'сменить рабочую папку',        run: (a) => this.#cmdCwd(a) },
      skills:  { desc: 'навыки (skills) агента',       run: () => this.#cmdSkills() },
      skill:   { desc: 'применить навык: /skill <имя> [задача]', run: (a) => this.#cmdSkill(a) },
      plugins: { desc: 'плагины и их команды',         run: () => this.#cmdPlugins() },
      ssh:     { desc: 'управление SSH-серверами: /ssh list|add|remove|info|usekey|markok|setup|connect', run: (a) => this.#cmdSsh(a) },
      update:  { desc: 'обновление: /update [now|auto|off|on]', run: (a) => this.#cmdUpdate(a) },
      trust:   { desc: 'не спрашивать разрешения: /trust [on|off]', run: (a) => this.#cmdTrust(a) },
      exit:    { desc: 'выход',                        run: () => { this.exiting = true; } },
      quit:    { desc: 'выход',                        run: () => { this.exiting = true; } },
    };
  }

  #cmdPrompt(arg = '') {
    const t = this.t;
    const [action = 'list', name, ...rest] = String(arg).trim().split(/\s+/);
    this.cfg.customPrompts ??= {};
    if (action === 'add') {
      const prompt = rest.join(' ').trim();
      if (!name || !prompt) return void stdout.write(`  ${t.muted('Использование: /prompt add <имя> <текст>')}\n\n`);
      this.cfg.customPrompts[name] = { name, prompt };
      this.cfg.activeCustomPrompt = name;
      saveConfig(this.cfg);
      return void stdout.write(`  ${t.success('✓')} промт ${t.bold(name)} сохранён и включён\n\n`);
    }
    if (action === 'use') {
      if (!this.cfg.customPrompts[name]) return void stdout.write(`  ${t.error('Нет такого промта.')} ${t.muted('/prompt list')}\n\n`);
      this.cfg.activeCustomPrompt = name;
      saveConfig(this.cfg);
      return void stdout.write(`  ${t.success('✓')} активный промт: ${t.bold(name)}\n\n`);
    }
    if (action === 'off') {
      this.cfg.activeCustomPrompt = null;
      saveConfig(this.cfg);
      return void stdout.write(`  ${t.success('✓')} пользовательский промт выключен\n\n`);
    }
    const names = Object.keys(this.cfg.customPrompts);
    stdout.write(`\n  ${t.bold('Пользовательские промты')}\n`);
    if (!names.length) stdout.write(`  ${t.muted('Пока нет. Создать: /prompt add имя текст')}\n\n`);
    else {
      for (const id of names) stdout.write(`  ${id === this.cfg.activeCustomPrompt ? t.success('●') : t.muted('○')} ${t.primary(id)}\n`);
      stdout.write('\n');
    }
  }

  #cmdHelp() {
    const t = this.t;
    const rows = Object.entries(this.commands)
      .filter(([n]) => n !== 'quit')
      .map(([name, c]) => `  ${t.primary('/' + name.padEnd(10))} ${t.muted(c.desc)}`);

    const pluginCmds = [...this.plugins.commands.keys()];
    const pluginRows = pluginCmds.length
      ? ['', t.bold(`Команды плагинов (${pluginCmds.length})`),
          '  ' + pluginCmds.map((c) => t.primary('/' + c)).join('  '),
          '  ' + t.muted('подробнее: /plugins  ·  навыки: /skills')]
      : [];

    stdout.write('\n' + box(
      [
        t.bold('Команды'),
        ...rows,
        ...pluginRows,
        '',
        t.bold('Горячие клавиши'),
        `  ${t.primary('Esc'.padEnd(11))} ${t.muted('прервать работу агента')}`,
        `  ${t.primary('Ctrl+C'.padEnd(11))} ${t.muted('выход')}`,
        '',
        `${t.bold('Плагины:')} ${t.muted(`${this.plugins.commands.size} команд · ${this.plugins.skills.size} навыков`)} ${t.muted('— /plugins, /skills')}`,
        '',
        t.muted('Просто пиши задачу текстом — агент сам разберётся, что делать.'),
      ].join('\n'),
      t, { title: `CodeRoom v${VERSION}` },
    ) + '\n\n');
  }

  async #cmdProvider(arg) {
    const t = this.t;
    const ids = Object.keys(PROVIDER_PRESETS);

    let id;
    if (!arg) {
      const opts = ids.map((pid) => {
        const p = PROVIDER_PRESETS[pid];
        const hasKey = resolveProvider(this.cfg, pid).apiKey || p.keyOptional;
        return {
          label: p.label,
          hint: (pid === this.cfg.provider ? '● сейчас · ' : '') + (hasKey ? 'ключ есть' : 'нет ключа'),
          detail: `${p.baseUrl || 'свой адрес'}\nмоделей: ${p.models?.length ?? 0}${hasKey ? '' : '\nключ спросим сразу после выбора'}`,
        };
      });
      const pick = await select({
        theme: t, title: 'Провайдер',
        options: opts, initial: Math.max(0, ids.indexOf(this.cfg.provider)), detail: true,
      });
      if (pick < 0) return;
      id = ids[pick];
      if (id === this.cfg.provider) { stdout.write(`  ${t.muted('Уже выбран.')}\n\n`); return; }
    } else {
      id = PROVIDER_PRESETS[arg] ? arg : ids[Number(arg) - 1];
    }
    if (!id) {
      stdout.write(`  ${t.error('Нет такого провайдера.')} Доступны: ${ids.join(', ')}\n\n`);
      return;
    }

    const preset = PROVIDER_PRESETS[id];
    this.cfg.provider = id;

    const known = (preset.models ?? []).some((m) => m.id === this.cfg.model);
    if (!known && preset.defaultModel) this.cfg.model = preset.defaultModel;
    this.session.model = this.cfg.model;

    if (!resolveProvider(this.cfg, id).apiKey && !preset.keyOptional) {
      stdout.write(`  ${t.warn('Для ' + preset.label + ' ещё нет ключа.')}\n`);
      await changeKey(this.cfg);
    } else {
      saveConfig(this.cfg);
    }

    this.agent.provider = new Provider(this.cfg);
    stdout.write(`  ${t.success('✓')} провайдер: ${t.bold(preset.label)} · модель ${t.primary(this.cfg.model)}\n`);
    stdout.write(`  ${t.muted('Список моделей: /model')}\n\n`);
  }


  async #cmdGateway(arg) {
    const t = this.t;
    const cur = resolveProvider(this.cfg);

    const ping = async (url) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      try {
        const r = await fetch(url.replace(/\/+$/, '') + '/health', { signal: ctl.signal });
        const j = await r.json().catch(() => ({}));
        return j?.ok ? 'ok' : `ответил ${r.status}`;
      } catch (e) {
        return e.name === 'AbortError' ? 'таймаут' : 'недоступен';
      } finally { clearTimeout(timer); }
    };

    if (!arg) {
      stdout.write(`\n  ${t.muted('шлюз:')} ${t.bold(cur.baseUrl)}\n`);
      stdout.write(`  ${t.muted('проверяю…')}\r`);
      const state = await ping(cur.baseUrl);
      stdout.write('\x1b[2K');
      const paint = state === 'ok' ? t.success : t.error;
      stdout.write(`  ${t.muted('состояние:')} ${paint(state)}\n`);
      if (state !== 'ok') {
        stdout.write(`  ${t.muted('подними шлюз:')} cd server && npm start\n`);
        stdout.write(`  ${t.muted('или локально:')} /gateway http://127.0.0.1:8787\n`);
      }
      stdout.write(`  ${t.muted('сменить:')} /gateway <url>\n\n`);
      return;
    }

    let url = arg.trim();
    if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
    try { new URL(url); } catch { stdout.write(`  ${t.error('Некорректный адрес:')} ${arg}\n\n`); return; }
    url = url.replace(/\/+$/, '').replace(/\/v1$/, '');

    stdout.write(`  ${t.muted('проверяю ' + url + '…')}\r`);
    const state = await ping(url);
    stdout.write('\x1b[2K');

    const pid = this.cfg.provider;
    this.cfg.providers ??= {};
    this.cfg.providers[pid] = { ...(this.cfg.providers[pid] ?? {}), baseUrl: url };
    saveConfig(this.cfg);
    this.agent.provider = new Provider(this.cfg);

    stdout.write(`  ${t.success(t.symbols.check)} шлюз: ${t.bold(url)} ${state === 'ok' ? t.success('· живой') : t.warn('· ' + state)}\n`);
    if (state !== 'ok') stdout.write(`  ${t.muted('адрес сохранён — проверь, что шлюз запущен')}\n`);
    stdout.write('\n');
  }

  async #cmdModel(arg) {
    const t = this.t;
    const preset = PROVIDER_PRESETS[this.cfg.provider];

    const apply = (id) => {
      this.cfg.model = id;
      this.session.model = id;
      saveConfig(this.cfg);
      stdout.write(`  ${t.success('✓')} модель: ${t.primary(id)}\n\n`);
    };

    if (arg) {
      if (/^\d+$/.test(arg)) {
        let list = this.modelChoices;
        if (!list?.length) {
          try { list = await new Provider(this.cfg).listModels(); }
          catch { list = (preset.models ?? []).map((m) => ({ id: m.id })); }
          this.modelChoices = list;
        }
        const pick = list[Number(arg) - 1];
        if (!pick) {
          stdout.write(`  ${t.error(`Нет модели с номером ${arg}.`)} ${t.muted('Список: /model')}\n\n`);
          return;
        }
        apply(pick.id);
        return;
      }
      apply(arg);
      return;
    }

    stdout.write('  ' + t.muted('Загружаю список моделей…') + '\r');
    let models = [];
    try {
      models = await new Provider(this.cfg).listModels();
    } catch {
      models = (preset.models ?? []).map((m) => ({ id: m.id }));
    }
    stdout.write('\x1b[2K');
    this.modelChoices = models;

    const available = new Map(models.map((m) => [m.id, m]));
    const groups = Object.entries(MODEL_TIERS)
      .sort(([, a], [, b]) => a.order - b.order)
      .map(([id, meta]) => ({
        id,
        ...meta,
        models: (preset.models ?? []).filter((m) => m.tier === id && available.has(m.id)),
      }))
      .filter((g) => g.models.length);

    const activeTier = preset.models?.find((m) => m.id === this.cfg.model)?.tier;
    const groupPick = await select({
      theme: t,
      title: 'Модели',
      subtitle: 'Сначала выбери производителя',
      options: groups.map((g) => ({
        label: g.label,
        hint: `${g.models.length} моделей${g.id === activeTier ? ' · ● текущая' : ''}`,
        detail: g.note || `Моделей: ${g.models.length}`,
      })),
      initial: Math.max(0, groups.findIndex((g) => g.id === activeTier)),
      detail: true,
    });
    if (groupPick < 0) return;

    const chosenGroup = groups[groupPick];
    const chosenModels = chosenGroup.models.map((known) => available.get(known.id));
    const opts = chosenModels.map((m) => {
      const known = preset.models?.find((k) => k.id === m.id);
      const nonChat = known?.chat === false;
      return {
        label: known?.label ?? m.id,
        hint: (m.id === this.cfg.model ? '● сейчас · ' : '') + (nonChat ? '⊘ не для чата' : (known?.note ?? m.id)),
        detail: [known?.note, `id: ${m.id}`, nonChat ? 'Картинки/аудио — для обычного чата не подходит' : null]
          .filter(Boolean).join('\n'),
      };
    });
    const cur = chosenModels.findIndex((m) => m.id === this.cfg.model);
    const pick = await select({
      theme: t,
      title: chosenGroup.label,
      subtitle: `Выбери модель · ${chosenModels.length} доступно`,
      options: opts,
      initial: cur < 0 ? 0 : cur,
      filterable: chosenModels.length > 8,
      detail: true,
    });
    if (pick >= 0 && chosenModels[pick]) apply(chosenModels[pick].id);
  }

  async #cmdTheme(arg) {
    const t = this.t;
    const names = Object.keys(THEMES);
    let name;

    if (!arg) {
      const opts = names.map((n) => {
        const th = createTheme(n);
        const swatch = [th.primary('███'), th.accent('██'), th.success('█'), th.warn('█'), th.error('█')].join('');
        return {
          label: THEMES[n].label,
          hint: swatch + (n === this.cfg.theme ? t.success('  ● сейчас') : ''),
          detail: `${THEMES[n].description}\n${th.primary(th.symbols.assistant)} ${th.text('так выглядит ответ агента')}\n${th.muted(th.symbols.toolDone + ' результат инструмента')}`,
        };
      });
      const pick = await select({
        theme: t, title: 'Дизайн терминала',
        subtitle: `в браузере свои: ${Object.keys(WEB_THEMES).join(', ')} (меняются в /web)`,
        options: opts, initial: Math.max(0, names.indexOf(this.cfg.theme)), detail: true,
      });
      if (pick < 0) return;
      name = names[pick];
    } else {
      name = THEMES[arg] ? arg : names[Number(arg) - 1];
    }

    if (!name) {
      stdout.write(`  ${t.error('Нет такого дизайна.')} Доступны: ${names.join(', ')}\n\n`);
      return;
    }

    this.cfg.theme = name;
    saveConfig(this.cfg);
    this.t = createTheme(name);
    this.spinner = new Spinner(this.t);
    this.agent.ui = this.#buildUi();
    this.input?.setTheme?.(this.t);

    const th = this.t;
    stdout.write(`\n  ${th.success(th.symbols.check)} дизайн: ${th.bold(THEMES[name].label)}\n`);
    stdout.write(`  ${th.primary(th.symbols.assistant)} ${th.text('Так теперь выглядит ответ агента.')}\n`);
    stdout.write(`  ${th.muted(th.symbols.toolDone)} ${th.muted('а так — результат инструмента')}\n\n`);
  }

  #cmdMode(arg) {
    const t = this.t;
    if (!arg) {
      stdout.write('\n  ' + t.bold('Режимы доступа') + '\n');
      for (const [id, m] of Object.entries(MODES)) {
        const cur = id === this.cfg.permissions.mode ? t.success(' ← сейчас') : '';
        stdout.write(`  ${t.primary(id.padEnd(12))} ${t.muted(m.hint)}${cur}\n`);
      }
      stdout.write(`\n  ${t.muted('Сменить:')} /mode <имя>\n\n`);
      return;
    }
    try {
      this.agent.permissions.setMode(arg);
      saveConfig(this.cfg);
      stdout.write(`  ${t.success('✓')} режим: ${t.bold(arg)} — ${t.muted(MODES[arg].hint)}\n\n`);
    } catch (e) {
      stdout.write(`  ${t.error(e.message)}\n\n`);
    }
  }

  #cmdConfig() {
    const t = this.t;
    const p = resolveProvider(this.cfg);
    const lines = [
      `${t.muted('Провайдер:')}  ${p.label} ${t.muted(p.baseUrl)}`,
      `${t.muted('Ключ:')}       ${maskKey(p.apiKey)} ${t.muted(`(${p.keySource})`)}`,
      `${t.muted('Модель:')}     ${t.primary(this.cfg.model)}`,
      `${t.muted('Быстрая:')}    ${this.cfg.smallModel}`,
      `${t.muted('Дизайн:')}     ${this.cfg.theme}`,
      `${t.muted('Режим:')}      ${this.cfg.permissions.mode}`,
      `${t.muted('Песочница:')}  ${this.cfg.security.restrictToWorkspace ? 'только рабочая папка' : t.warn('весь диск')}`,
      '',
      `${t.muted('Файл:')} ${CONFIG_FILE}`,
    ];
    stdout.write('\n' + box(lines.join('\n'), t, { title: 'Настройки' }) + '\n\n');
  }

  #cmdStatus() {
    const t = this.t;
    const u = this.session.usage;
    const ctx = estimateTokens(this.session.messages);
    const limit = this.cfg.agent.autoCompactAt;
    const pct = Math.min(100, Math.round((ctx / limit) * 100));
    const barLen = 24;
    const filled = Math.round((pct / 100) * barLen);
    const bar = t.primary('█'.repeat(filled)) + t.muted('░'.repeat(barLen - filled));

    stdout.write('\n' + box([
      `${t.muted('Сессия:')}   ${this.session.id}`,
      `${t.muted('Папка:')}    ${this.cwd}`,
      `${t.muted('Модель:')}   ${t.primary(this.session.model ?? this.cfg.model)}`,
      `${t.muted('Сообщений:')} ${this.session.messages.length}`,
      '',
      `${t.muted('Контекст:')} ${bar} ${pct}%  ${t.muted(`~${fmtNum(ctx)} / ${fmtNum(limit)}`)}`,
      `${t.muted('Токены:')}   ${t.success('↑')} ${fmtNum(u.input)}  ${t.accent('↓')} ${fmtNum(u.output)}  ${t.muted(`запросов: ${u.requests}`)}`,
    ].join('\n'), t, { title: 'Состояние' }) + '\n\n');
  }

  #cmdClear() {
    this.session = new Session({ cwd: this.cwd, model: this.cfg.model, provider: this.cfg.provider });
    this.agent.session = this.session;
    console.clear();
    this.#banner();
    stdout.write(`  ${this.t.muted('История очищена — начинаем с чистого листа.')}\n\n`);
  }

  async #cmdCompact() {
    const t = this.t;
    const before = estimateTokens(this.session.messages);
    const saved = this.cfg.agent.autoCompactAt;
    this.cfg.agent.autoCompactAt = 0;
    this.spinner.start('сжимаю историю…');
    try {
      await this.agent.send(null);
    } catch (e) {
      stdout.write(`  ${t.error('Не удалось сжать:')} ${e.message}\n`);
    } finally {
      this.spinner.stop();
      this.cfg.agent.autoCompactAt = saved;
    }
    const after = estimateTokens(this.session.messages);
    stdout.write(`  ${t.success('✓')} ${fmtNum(before)} → ${fmtNum(after)} токенов\n\n`);
  }

  #cmdDiff() {
    const t = this.t;
    if (!this.session.touchedFiles.size) {
      stdout.write(`  ${t.muted('За эту сессию файлы не менялись.')}\n\n`);
      return;
    }
    stdout.write('\n');
    for (const [file, { before, after }] of this.session.touchedFiles) {
      const d = renderDiff(before ?? '', after ?? '', t, { context: 2, maxLines: 20 });
      stdout.write(`  ${t.bold(file)} ${t.success(`+${d.adds}`)} ${t.error(`-${d.dels}`)}\n`);
      if (d.text) stdout.write(d.text + '\n');
      stdout.write('\n');
    }
  }

  #cmdTodo() {
    const t = this.t;
    if (!this.session.todos?.length) {
      stdout.write(`  ${t.muted('План пуст.')}\n\n`);
      return;
    }
    const icon = { pending: t.muted('○'), in_progress: t.warn('◐'), completed: t.success('●') };
    stdout.write('\n');
    for (const todo of this.session.todos) {
      const text = todo.status === 'completed' ? t.muted(todo.content) : todo.content;
      stdout.write(`  ${icon[todo.status] ?? '○'} ${text}\n`);
    }
    stdout.write('\n');
  }

  #cmdSessions() {
    const t = this.t;
    const list = Session.list(this.cwd, 10);
    if (!list.length) {
      stdout.write(`  ${t.muted('Сессий пока нет.')}\n\n`);
      return;
    }
    stdout.write('\n  ' + t.bold('Сессии проекта') + '\n');
    for (const s of list) {
      const when = new Date(s.updatedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
      const cur = s.id === this.session.id ? t.success(' ← текущая') : '';
      stdout.write(`  ${t.primary(s.id)}  ${t.muted(when)}  ${t.muted(`${s.messages} реплик`)}${cur}\n`);
      stdout.write(`    ${t.muted(s.title.slice(0, 70))}\n`);
    }
    stdout.write(`\n  ${t.muted('Продолжить:')} /resume <id>\n\n`);
  }

  #cmdResume(id) {
    const t = this.t;
    if (!id) return this.#cmdSessions();

    const found = Session.list(this.cwd, 50).find((s) => s.id === id || s.id.startsWith(id));
    if (!found) {
      stdout.write(`  ${t.error('Сессия не найдена:')} ${id}\n\n`);
      return;
    }
    this.session = Session.load(found.file);
    this.agent.session = this.session;
    stdout.write(`  ${t.success('✓')} продолжаю сессию ${t.primary(this.session.id)} ${t.muted(`(${this.session.messages.length} сообщений)`)}\n`);
    stdout.write(`  ${t.muted(this.session.title)}\n\n`);
  }

  #cmdMemory() {
    const t = this.t;
    const file = path.join(this.cwd, 'CODEROOM.md');
    stdout.write('\n  ' + t.bold('Память') + '\n');
    stdout.write(`  ${t.muted('Проект: ')} ${fs.existsSync(file) ? file : t.muted(file + ' (нет)')}\n`);
    stdout.write(`  ${t.muted('Глобально:')} ${fs.existsSync(GLOBAL_MEMORY) ? GLOBAL_MEMORY : t.muted(GLOBAL_MEMORY + ' (нет)')}\n`);
    stdout.write(`\n  ${t.muted('Создать файл проекта:')} /init\n\n`);
  }

  #cmdInit() {
    const t = this.t;
    const file = path.join(this.cwd, 'CODEROOM.md');
    if (fs.existsSync(file)) {
      stdout.write(`  ${t.warn('Файл уже есть:')} ${file}\n\n`);
      return;
    }
    const tpl = `# Инструкции проекта

Этот файл читает CodeRoom при каждом запуске в этой папке.
Опиши здесь то, что агент должен знать всегда.

## О проекте

<коротко: что это, какой стек>

## Команды

- Установка: \`npm install\`
- Запуск: \`npm start\`
- Тесты: \`npm test\`

## Соглашения

- <стиль кода, именование, чего избегать>
`;
    fs.writeFileSync(file, tpl, 'utf8');
    stdout.write(`  ${t.success('✓')} создан ${t.bold('CODEROOM.md')} — опиши проект, агент будет это учитывать\n\n`);
  }


  #cmdContext() {
    const t = this.t;
    const msgs = this.session.messages;
    if (!msgs.length) { stdout.write(`  ${t.muted('Контекст пуст.')}\n\n`); return; }

    const buckets = new Map();
    for (const m of msgs) {
      const key = m.role === 'tool' ? `инструмент ${m.name ?? ''}`.trim() : m.role;
      const size = estimateTokens([m]);
      const b = buckets.get(key) ?? { tokens: 0, count: 0 };
      b.tokens += size; b.count++;
      buckets.set(key, b);
    }

    const total = estimateTokens(msgs);
    const limit = this.cfg.agent.autoCompactAt || 140000;
    const rows = [...buckets.entries()].sort((a, b) => b[1].tokens - a[1].tokens);
    const nameW = Math.min(24, Math.max(...rows.map(([k]) => visLen(k))));

    stdout.write('\n  ' + t.bold('Контекст') + '  ' + t.muted(`${fmtNum(total)} / ${fmtNum(limit)} токенов`) + '\n');
    stdout.write('  ' + progressBar(total, limit, 24, t.primary, t.muted) + '\n\n');
    for (const [key, b] of rows) {
      const share = total ? Math.round((b.tokens / total) * 100) : 0;
      stdout.write('  ' + t.text(key.padEnd(nameW)) + '  ' +
        t.muted(`${String(fmtNum(b.tokens)).padStart(6)}  ${String(share).padStart(3)}%  ${b.count} сообщ.`) + '\n');
    }
    if (total > limit * 0.8) {
      stdout.write('\n  ' + t.warn('Контекст близок к лимиту — /compact сожмёт историю.') + '\n');
    }
    stdout.write('\n');
  }


  #cmdExport(arg) {
    const t = this.t;
    if (!this.session.messages.length) { stdout.write(`  ${t.muted('Нечего выгружать — диалог пуст.')}\n\n`); return; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const file = path.resolve(this.cwd, arg || `coderoom-${stamp}.md`);
    const lines = [
      `# CodeRoom — ${this.session.title || 'диалог'}`,
      '',
      `- сессия: \`${this.session.id}\``,
      `- модель: \`${this.session.model ?? this.cfg.model}\``,
      `- папка: \`${this.cwd}\``,
      `- сообщений: ${this.session.messages.length}`,
      '',
      '---',
      '',
    ];

    for (const m of this.session.messages) {
      if (m.role === 'user') lines.push(`## Ты\n\n${m.content}\n`);
      else if (m.role === 'assistant') {
        if (m.content) lines.push(`## Агент\n\n${m.content}\n`);
        for (const c of m.tool_calls ?? []) {
          lines.push(`> ${c.function.name}(${truncate(String(c.function.arguments ?? ''), 200)})\n`);
        }
      } else if (m.role === 'tool') {
        const body = String(m.content ?? '');
        lines.push('```\n' + (body.length > 2000 ? body.slice(0, 2000) + '\n… обрезано' : body) + '\n```\n');
      }
    }

    try {
      fs.writeFileSync(file, lines.join('\n'), 'utf8');
      stdout.write(`  ${t.success(t.symbols.check)} диалог сохранён: ${t.bold(path.relative(this.cwd, file) || file)}\n\n`);
    } catch (e) {
      stdout.write(`  ${t.error('Не смог записать:')} ${e.message}\n\n`);
    }
  }


  #cmdCwd(arg) {
    const t = this.t;
    if (!arg) {
      stdout.write(`\n  ${t.muted('папка:')} ${t.bold(this.cwd)}\n  ${t.muted('сменить:')} /cwd <путь>\n\n`);
      return;
    }
    const next = path.resolve(this.cwd, arg);
    if (!fs.existsSync(next) || !fs.statSync(next).isDirectory()) {
      stdout.write(`  ${t.error('Нет такой папки:')} ${next}\n\n`);
      return;
    }
    this.cwd = next;
    this.agent.cwd = next;
    this.session.cwd = next;
    try { this.plugins = loadPlugins({ cwd: next, reload: true }); } catch { /* плагины опциональны */ }
    this.input?.setCommands(this.#completionList());
    setTerminalTitle(`coderoom — ${path.basename(next)}`);
    stdout.write(`  ${t.success(t.symbols.check)} рабочая папка: ${t.bold(next)}\n`);
    stdout.write(`  ${t.muted('плагины и память проекта перечитаны')}\n\n`);
  }

  #cmdSkills() {
    const t = this.t;
    const skills = [...this.plugins.skills.values()];
    if (!skills.length) { stdout.write(`  ${t.muted('Навыков нет.')}\n\n`); return; }
    stdout.write('\n  ' + t.bold('Навыки (skills)') + '\n');
    for (const s of skills) {
      stdout.write(`  ${t.primary(s.name)} ${t.muted('· ' + s.plugin)}\n`);
      if (s.description) stdout.write(`     ${t.muted(s.description.slice(0, 110))}\n`);
    }
    stdout.write(`\n  ${t.muted('Агент подтягивает их сам (инструмент Skill). Фронтенд/UI → frontend-design.')}\n\n`);
  }

  async #cmdSkill(arg) {
    const t = this.t;
    const [name, ...rest] = (arg || '').split(/\s+/);
    if (!name) return this.#cmdSkills();
    const skill = this.plugins.skills.get(name.toLowerCase());
    if (!skill) {
      stdout.write(`  ${t.error('Нет навыка:')} ${name}  ${t.muted('(/skills — список)')}\n\n`);
      return;
    }
    const task = rest.join(' ').trim();
    stdout.write(`  ${t.muted(`▸ навык ${skill.name}`)}\n`);
    const msg =
      `Применяй навык «${skill.name}» для этой работы — держи его инструкции в контексте и следуй им.\n\n` +
      `=== Инструкции навыка «${skill.name}» ===\n${skill.body.trim()}\n=== конец инструкций ===\n\n` +
      (task ? `Задача: ${task}` : 'Дальше опишу задачу — учитывай инструкции навыка.');
    await this.#handleMessage(msg);
  }

  #cmdPlugins() {
    const t = this.t;
    const plugins = [...this.plugins.plugins.values()];
    if (!plugins.length) { stdout.write(`  ${t.muted('Плагинов нет.')}\n\n`); return; }
    stdout.write('\n  ' + t.bold(`Плагины (${plugins.length})`) + '\n');
    for (const p of plugins) {
      stdout.write(`  ${t.primary(p.name)}${p.description ? t.muted(' — ' + p.description.slice(0, 62)) : ''}\n`);
      const bits = [];
      if (p.commands.length) bits.push(p.commands.map((c) => '/' + c).join(' '));
      if (p.skills.length) bits.push('skills: ' + p.skills.join(', '));
      if (bits.length) stdout.write(`     ${t.muted(bits.join('  ·  '))}\n`);
    }
    stdout.write(`\n  ${t.muted('Команды плагинов работают как слэш-команды (см. /help).')}\n\n`);
  }

  #cmdSsh(arg) {
    const t = this.t;
    const parts = (arg || '').trim().split(/\s+/).filter(Boolean);
    const action = parts[0]?.toLowerCase();

    if (!action || action === 'list') {
      const hosts = listHosts(this.cfg);
      if (!hosts.length) {
        stdout.write(`  ${t.muted('Серверов нет.')}
  ${t.muted('Добавь сервер: /ssh add <имя> <user@host:port>')}
\n`);
        return;
      }
      stdout.write('\n');
      for (const h of hosts) {
        stdout.write(`  ${t.primary(h.name)} ${t.muted(`${h.user}@${h.host}:${h.port}`)}${h.keyInstalled ? t.success(' · ключ установлен') : ''}\n`);
      }
      stdout.write('\n');
      return;
    }

    if (action === 'add') {
      const [name, target] = parts.slice(1);
      if (!name || !target) {
        stdout.write(`  ${t.error('Использование:')} /ssh add <имя> <user@host:port>\n\n`);
        return;
      }
      try {
        const parsed = parseTarget(target);
        addHost(this.cfg, { name, host: parsed.host, user: parsed.user, port: parsed.port });
        stdout.write(`  ${t.success('✓')} Сервер ${t.primary(name)} добавлен: ${parsed.user}@${parsed.host}:${parsed.port}\n\n`);
      } catch (e) {
        stdout.write(`  ${t.error('Ошибка:')} ${e.message}\n\n`);
      }
      return;
    }

    if (action === 'remove' || action === 'rm') {
      const name = parts[1];
      if (!name) {
        stdout.write(`  ${t.error('Использование:')} /ssh remove <имя>\n\n`);
        return;
      }
      if (!removeHost(this.cfg, name)) {
        stdout.write(`  ${t.error('Сервер не найден:')} ${name}\n\n`);
        return;
      }
      stdout.write(`  ${t.success('✓')} Сервер ${t.primary(name)} удалён\n\n`);
      return;
    }

    if (action === 'info') {
      const name = parts[1];
      if (!name) {
        stdout.write(`  ${t.error('Использование:')} /ssh info <имя>\n\n`);
        return;
      }
      const host = getHost(this.cfg, name);
      if (!host) {
        stdout.write(`  ${t.error('Сервер не найден:')} ${name}\n\n`);
        return;
      }
      stdout.write(`\n  ${t.primary(host.name)}\n`);
      stdout.write(`    ${t.muted('host:')} ${host.user}@${host.host}:${host.port}\n`);
      stdout.write(`    ${t.muted('key:')} ${host.keyFile ? host.keyFile : 'не привязан'}\n`);
      stdout.write(`    ${t.muted('auth:')} ${host.auth || 'auto'}\n`);
      stdout.write(`    ${t.muted('status:')} ${host.keyInstalled ? 'ключ установлен' : 'ключ не установлен'}\n\n`);
      return;
    }

    if (action === 'usekey') {
      const [_, name, keyFile] = parts;
      if (!name || !keyFile) {
        stdout.write(`  ${t.error('Использование:')} /ssh usekey <имя> <путь_к_ключу>\n\n`);
        return;
      }
      try {
        useKey(this.cfg, name, keyFile);
        stdout.write(`  ${t.success('✓')} Ключ подключён к ${t.primary(name)}\n\n`);
      } catch (e) {
        stdout.write(`  ${t.error('Ошибка:')} ${e.message}\n\n`);
      }
      return;
    }

    if (action === 'password') {
      const [_, name, ...passParts] = parts;
      const password = passParts.join(' ').trim();
      if (!name || !password) {
        stdout.write(`  ${t.error('Использование:')} /ssh password <имя> <пароль>\n\n`);
        return;
      }
      try {
        setHostPassword(this.cfg, name, password);
        stdout.write(`  ${t.success('✓')} Пароль сохранён для ${t.primary(name)}\n\n`);
      } catch (e) {
        stdout.write(`  ${t.error('Ошибка:')} ${e.message}\n\n`);
      }
      return;
    }

    if (action === 'auth') {
      const [_, name, mode] = parts;
      if (!name || !mode) {
        stdout.write(`  ${t.error('Использование:')} /ssh auth <имя> <key|password|auto>\n\n`);
        return;
      }
      try {
        setAuthMode(this.cfg, name, mode);
        stdout.write(`  ${t.success('✓')} Способ входа для ${t.primary(name)}: ${mode}\n\n`);
      } catch (e) {
        stdout.write(`  ${t.error('Ошибка:')} ${e.message}\n\n`);
      }
      return;
    }

    if (action === 'setup') {
      const name = parts[1];
      if (!name) {
        stdout.write(`  ${t.error('Использование:')} /ssh setup <имя>\n\n`);
        return;
      }
      const host = getHost(this.cfg, name);
      if (!host) {
        stdout.write(`  ${t.error('Сервер не найден:')} ${name}\n\n`);
        return;
      }
      try {
        const password = getHostPassword(name);
        const allowPassword = host.auth !== 'key';
        ensureKeyPair();
        copyPublicKey(host, KEY_FILE, password);
        configureSshd(host, allowPassword, { password });
        markOk(this.cfg, name);
        stdout.write(`  ${t.success('✓')} Сервис настроен и ключ установлен на ${t.primary(name)}\n`);
        stdout.write(`  ${t.muted('Теперь можно подключаться:')} /ssh connect ${name}\n\n`);
      } catch (e) {
        stdout.write(`  ${t.error('Ошибка:')} ${e.message}\n\n`);
      }
      return;
    }

    if (action === 'connect') {
      const name = parts[1];
      const command = parts.slice(2).join(' ').trim();
      if (!name) {
        stdout.write(`  ${t.error('Использование:')} /ssh connect <имя> [sftp|<команда>]\n\n`);
        return;
      }
      const host = getHost(this.cfg, name);
      if (!host) {
        stdout.write(`  ${t.error('Сервер не найден:')} ${name}\n\n`);
        return;
      }
      const password = host.auth === 'password' ? getHostPassword(name) : undefined;

      if (command === 'sftp') {
        stdout.write(`  ${t.muted('Открываю SFTP на')} ${t.primary(host.name)}\n`);
        try {
          connectSftp(host, { password });
          stdout.write('\n');
        } catch (e) {
          stdout.write(`\n  ${t.error('Ошибка SFTP:')} ${e.message}\n\n`);
        }
        return;
      }

      if (!command) {
        try {
          if (!host.keyInstalled) {
            stdout.write(`  ${t.muted('Сервер не настроен, выполняю подготовку...')}\n`);
            ensureKeyPair();
            copyPublicKey(host, KEY_FILE, password);
            configureSshd(host, host.auth !== 'key', { password });
            markOk(this.cfg, name);
            stdout.write(`  ${t.success('✓')} Сервер ${t.primary(name)} подготовлен\n`);
          }
          this.sshHost = host;
          this.input.setPrompt(`  [ssh:${host.name}] `);
          this.input.notify(`SSH режим: вводи команды для ${host.name}, /ssh disconnect для выхода.`);
          stdout.write(`  ${t.success('✓')} Подключено к ${t.primary(host.name)}. Вводи команды, чтобы выполнять на сервере.\n\n`);
        } catch (e) {
          stdout.write(`  ${t.error('Ошибка SSH:')} ${e.message}\n\n`);
        }
        return;
      }

      try {
        stdout.write(`  ${t.muted('Выполняю на')} ${t.primary(host.name)} (${host.user}@${host.host}:${host.port})\n`);
        const result = runRemote(host, command, { password });
        if (result.error) throw result.error;
        stdout.write(`\n  ${t.muted('stdout:')}\n`);
        stdout.write(`  ${result.stdout.trim() || '(нет вывода)'}\n`);
        if (result.stderr) stdout.write(`  ${t.muted('stderr:')}\n  ${result.stderr.trim()}\n`);
        stdout.write(`\n`);
      } catch (e) {
        stdout.write(`  ${t.error('Ошибка SSH:')} ${e.message}\n\n`);
      }
      return;
    }

    const host = getHost(this.cfg, action);
    if (host) {
      if (parts.length === 1) {
        stdout.write(`  ${t.error('Используй:')} /ssh connect ${host.name} <команда>\n`);
        stdout.write(`  ${t.muted('Пример:')} /ssh connect ${host.name} "ls -la /var/www"\n\n`);
        return;
      }
      const command = parts.slice(1).join(' ');
      try {
        const result = runRemote(host, command, { password: host.auth === 'password' ? getHostPassword(action) : undefined });
        if (result.error) throw result.error;
        stdout.write(`\n  ${t.muted('stdout:')}\n`);
        stdout.write(`  ${result.stdout.trim() || '(нет вывода)'}\n`);
        if (result.stderr) stdout.write(`  ${t.muted('stderr:')}\n  ${result.stderr.trim()}\n`);
        stdout.write('\n');
      } catch (e) {
        stdout.write(`  ${t.error('Ошибка SSH:')} ${e.message}\n\n`);
      }
      return;
    }

    if (action === 'disconnect' || action === 'exit') {
      if (!this.sshHost) {
        stdout.write(`  ${t.error('SSH-сессия не активна')}\n\n`);
        return;
      }
      this.#endSshSession();
      stdout.write(`  ${t.success('✓')} SSH-сессия завершена\n\n`);
      return;
    }

    stdout.write(`  ${t.error('Неизвестная операция:')} ${action}\n  ${t.muted('Доступно: list, add, remove, rm, info, usekey, markok, password, auth, setup, connect, disconnect')}\n\n`);
  }

  #cmdCost() {
    const t = this.t;
    const u = this.session.usage;
    stdout.write('\n' + box([
      `${t.muted('Запросов:')}      ${u.requests}`,
      `${t.muted('Входные:')}       ${fmtNum(u.input)} токенов`,
      `${t.muted('Выходные:')}      ${fmtNum(u.output)} токенов`,
      `${t.muted('Из кэша:')}       ${fmtNum(u.cacheRead)} токенов`,
      '',
      t.muted('Точную стоимость смотри в кабинете провайдера.'),
    ].join('\n'), t, { title: 'Расход' }) + '\n\n');
  }

  async #cmdWeb() {
    const t = this.t;
    const { startWebServer } = await import('./web.mjs');
    const info = await startWebServer({ cfg: this.cfg, cwd: this.cwd });
    stdout.write(`\n  ${t.success('✓')} Веб-интерфейс: ${t.underline(t.accent(info.url))}\n`);
    stdout.write(`  ${t.muted('Дизайны переключаются прямо в браузере. Ctrl+C — остановить всё.')}\n\n`);
  }


  /* ─── обновления ──────────────────────────────────────────────────── */

  /** /update [now|auto|manual|on|off] — проверить, поставить, настроить. */
  async #cmdUpdate(arg) {
    const t = this.t;
    const key = (arg || '').trim().toLowerCase();

    if (key === 'off')    { setUpdateCheck(this.cfg, false); stdout.write(`  ${t.success(t.symbols.check)} проверка обновлений выключена ${t.muted('(включить: /update on)')}\n\n`); return; }
    if (key === 'on')     { setUpdateCheck(this.cfg, true);  resetUpdateSnooze(); stdout.write(`  ${t.success(t.symbols.check)} проверка обновлений включена\n\n`); return; }
    if (key === 'auto')   { setAutoInstall(this.cfg, true);  stdout.write(`  ${t.success(t.symbols.check)} новые версии буду ставить сам, без вопросов\n\n`); return; }
    if (key === 'manual') { setAutoInstall(this.cfg, false); stdout.write(`  ${t.success(t.symbols.check)} перед установкой буду спрашивать\n\n`); return; }

    stdout.write(`  ${t.muted('Смотрю, что нового в npm…')}\r`);
    const res = await checkForUpdates({ cfg: this.cfg, force: true, silent: true });
    stdout.write('\x1b[2K');

    if (res.error && !res.latestVersion) {
      stdout.write(`  ${t.warn('Не смог проверить:')} ${res.error}\n\n`);
      return;
    }

    if (!res.updateAvailable) {
      stdout.write(`  ${t.success(t.symbols.check)} у тебя свежая версия ${t.bold('v' + res.currentVersion)}\n\n`);
      return;
    }

    resetUpdateSnooze();
    if (key === 'now') return this.#installUpdate(res.latestVersion);
    await this.#updateFlow(res);
  }

  /** Меню «вышла новая версия»: обновить / позже / пропустить / решать за меня. */
  async #updateFlow(res) {
    const t = this.t;
    const install = detectInstall();
    const plan = updateCommand(install, res.latestVersion);
    const kind = { major: 'мажорное', minor: 'минорное', patch: 'патч' }[res.kind] ?? '';

    if (updateSettings(this.cfg).autoInstall) {
      stdout.write(`  ${t.muted(`Новая версия ${res.latestVersion} — ставлю автоматически…`)}\n`);
      return this.#installUpdate(res.latestVersion);
    }

    const options = [
      { label: 'Обновить сейчас', hint: plan.cmd ? plan.text : 'вручную — команда ниже' },
      { label: 'Позже', hint: 'напомню через сутки' },
      { label: `Пропустить ${res.latestVersion}`, hint: 'про эту версию больше не напоминать' },
      { label: 'Всегда обновлять сам', hint: 'ставить новые версии без вопросов' },
      { label: 'Не проверять обновления', hint: 'выключить совсем (/update on — вернуть)' },
    ];

    const pick = await select({
      theme: t,
      title: `Вышла CodeRoom ${res.latestVersion}${kind ? ` (${kind})` : ''}`,
      subtitle: `у тебя ${res.currentVersion} · ${install.fromSource ? 'запуск из исходников' : install.global ? 'глобальная установка' : 'локальная установка'}`,
      options,
      footer: 'Enter выбрать · Esc — позже',
    });

    switch (pick) {
      case 0: return this.#installUpdate(res.latestVersion);
      case 2:
        skipVersion(this.cfg, res.latestVersion);
        stdout.write(`  ${t.muted(`Хорошо, про ${res.latestVersion} не напомню.`)}\n\n`);
        return;
      case 3:
        setAutoInstall(this.cfg, true);
        stdout.write(`  ${t.muted('Дальше буду обновлять сам. Сейчас ставлю…')}\n`);
        return this.#installUpdate(res.latestVersion);
      case 4:
        setUpdateCheck(this.cfg, false);
        stdout.write(`  ${t.muted('Больше не проверяю. Вернуть: /update on')}\n\n`);
        return;
      default:
        snoozeUpdate(24);
        stdout.write(`  ${t.muted('Напомню завтра. Обновить руками: /update now')}\n\n`);
    }
  }

  /** Ставим пакет, показывая, что происходит. */
  async #installUpdate(version = 'latest') {
    const t = this.t;
    const install = detectInstall();
    const plan = updateCommand(install, version);

    if (!plan.cmd) {
      stdout.write(`\n  ${t.warn('Автоматически не получится.')} ${t.muted('Обнови так:')}\n  ${t.code(plan.text)}\n\n`);
      return;
    }

    stdout.write(`\n  ${t.muted(plan.text)}\n`);
    this.spinner.start('ставлю обновление…');
    const last = [];
    const res = await runUpdate({
      version, install,
      onOutput: (line) => { last.push(line); if (last.length > 3) last.shift(); this.spinner.update(truncate(line, 60)); },
    });
    this.spinner.stop();

    if (res.ok) {
      stdout.write(`  ${t.success(t.symbols.check)} готово — поставлена ${t.bold('v' + version)}\n`);
      stdout.write(`  ${t.muted('Перезапусти coderoom, чтобы новая версия заработала.')}\n\n`);
      resetUpdateSnooze();
      return;
    }

    stdout.write(`  ${t.error(t.symbols.cross)} не вышло обновиться${res.code != null ? t.muted(` (код ${res.code})`) : ''}\n`);
    for (const l of last) stdout.write(`     ${t.muted(truncate(l, termWidth() - 8))}\n`);
    if (res.hint) stdout.write(`  ${t.muted(res.hint)}\n`);
    stdout.write('\n');
  }

  /** Проверка при старте: спрашиваем один раз и не мешаем работать. */
  async #updateGate() {
    if (!stdout.isTTY) return;
    const res = await Promise.race([
      this.updateCheck,
      new Promise((r) => setTimeout(() => r(null), 2500)),
    ]).catch(() => null);

    if (!res || !shouldPrompt(res, this.cfg)) return;
    if (!updateSettings(this.cfg).prompt && !updateSettings(this.cfg).autoInstall) return;
    await this.#updateFlow(res);
  }


  /* ─── доверие инструментам ────────────────────────────────────────── */

  /** /trust — перестать спрашивать разрешения (или вернуть вопросы обратно). */
  async #cmdTrust(arg) {
    const t = this.t;
    const key = (arg || '').trim().toLowerCase();

    const apply = (mode, note) => {
      this.agent.permissions.setMode(mode);
      saveConfig(this.cfg);
      stdout.write(`  ${t.success(t.symbols.check)} режим ${t.bold(mode)} — ${t.muted(note)}\n\n`);
    };

    if (key === 'on' || key === 'yolo') return apply('yolo', MODES.yolo.hint);
    if (key === 'edits') return apply('acceptEdits', MODES.acceptEdits.hint);
    if (key === 'off') return apply('default', MODES.default.hint);

    const saved = (this.cfg.permissions.allow ?? []).filter((r) => !DEFAULT_CONFIG.permissions.allow.includes(r));
    const pick = await select({
      theme: t,
      title: 'Спрашивать ли разрешения?',
      subtitle: `сейчас: ${this.cfg.permissions.mode}${saved.length ? ` · своих правил: ${saved.length}` : ''}`,
      options: [
        { label: 'Править файлы без вопросов', hint: MODES.acceptEdits.hint },
        { label: 'Вообще ничего не спрашивать', hint: MODES.yolo.hint },
        { label: 'Спрашивать, как раньше', hint: MODES.default.hint },
        { label: 'Забыть сохранённые правила', hint: saved.length ? saved.join(', ') : 'своих правил нет' },
      ],
      footer: 'Enter выбрать · Esc отмена',
    });

    if (pick === 0) return apply('acceptEdits', MODES.acceptEdits.hint);
    if (pick === 1) return apply('yolo', MODES.yolo.hint);
    if (pick === 2) return apply('default', MODES.default.hint);
    if (pick === 3) {
      this.cfg.permissions.allow = [...DEFAULT_CONFIG.permissions.allow];
      this.cfg.permissions.ask = [...DEFAULT_CONFIG.permissions.ask];
      saveConfig(this.cfg);
      stdout.write(`  ${t.success(t.symbols.check)} правила сброшены — снова буду спрашивать\n\n`);
    }
  }



  #banner() {
    if (!this.cfg.ui.banner) return;
    const t = this.t;
    const sep = t.muted(`  ${unicodeOK ? '·' : '-'}  `);
    for (const line of t.banner(VERSION)) stdout.write(glyphs(line) + '\n');

    const p = resolveProvider(this.cfg);
    stdout.write('  ' + t.muted('модель ') + t.bold(this.cfg.model) +
      sep + t.muted('режим ') + t.bold(this.cfg.permissions.mode) +
      sep + t.accent(p.label) + '\n');
    stdout.write('  ' + t.muted('папка  ') + t.muted(truncate(this.cwd, termWidth() - 11)) + '\n');
    const dash = unicodeOK ? '—' : '-';
    stdout.write('  ' + t.muted(
      `/help ${dash} команды  ${unicodeOK ? '·' : '-'}  Shift+Tab ${dash} режим  ${unicodeOK ? '·' : '-'}  Esc ${dash} прервать  ${unicodeOK ? '·' : '-'}  Ctrl+C ${dash} выход`,
    ) + '\n\n');
  }


  #statusLine() {
    const t = this.t;
    const u = this.session.usage;
    const ctx = estimateTokens(this.session.messages);
    const limit = this.cfg.agent.autoCompactAt || 140000;
    const bits = [
      `${this.cfg.model}`,
      `${this.cfg.permissions.mode}`,
      `${progressBar(ctx, limit, 8, t.primary, t.muted)} контекст`,
    ];
    if (u.requests) bits.push(`${fmtNum(u.input)}↑ ${fmtNum(u.output)}↓`);
    if (this.session.todos?.length) {
      const done = this.session.todos.filter((x) => x.status === 'completed').length;
      bits.push(`план ${done}/${this.session.todos.length}`);
    }
    return bits.join(unicodeOK ? '  ·  ' : '  -  ');
  }


  #completionList() {
    const own = Object.entries(this.commands)
      .filter(([n]) => n !== 'quit')
      .map(([name, c]) => ({ name, desc: c.desc }));
    const plug = [...this.plugins.commands.values()]
      .map((c) => ({ name: c.name, desc: c.description || `команда плагина ${c.plugin}` }));
    return [...own, ...plug];
  }


  #installInterrupt() {
    this.offKeys = onKey((_str, key) => {
      if (!key) return;
      if (key.name === 'escape' && this.agent.running) {
        this.agent.interrupt();
        this.spinner.stop();
        stdout.write(`\n  ${this.t.warn(glyphs('⏹ прервано'))}\n\n`);
      }
    });
  }


  #cycleMode() {
    const order = ['default', 'acceptEdits', 'plan', 'yolo'];
    const cur = order.indexOf(this.cfg.permissions.mode);
    const next = order[(cur + 1 + order.length) % order.length];
    try {
      this.agent.permissions.setMode(next);
      saveConfig(this.cfg);
    } catch { return; }
    const t = this.t;
    const paint = next === 'yolo' ? t.error : next === 'plan' ? t.accent : next === 'acceptEdits' ? t.warn : t.success;
    notify(`${paint(glyphs(next === 'default' ? '◯' : '◉'))} режим ${t.bold(next)} ${t.muted(MODES[next].hint)}`);
    this.input?.refresh();
  }

  async start() {
    console.clear();
    setTerminalTitle(`coderoom — ${path.basename(this.cwd)}`);
    this.#banner();

    try { await this.#updateGate(); } catch { /* обновление не должно мешать работе */ }

    this.input = createInput({
      theme: this.t,
      commands: this.#completionList(),
      statusLine: () => this.#statusLine(),
      onShiftTab: () => this.#cycleMode(),
      onExit: () => this.#cleanup(),
      placeholder: 'что нужно сделать?',
    });

    this.#installInterrupt();

    if (this.initialTask) {
      const task = this.initialTask;
      this.initialTask = null;
      stdout.write(`  ${this.t.primary(this.t.symbols.prompt)} ${this.t.text(task)}\n`);
      await this.#handleMessage(task);
    }

    while (!this.exiting) {
      const raw = await this.input.ask();
      const input = String(raw ?? '').trim();
      if (!input) continue;

      if (input.startsWith('/')) {
        await this.#runSlash(input);
        this.input.setCommands(this.#completionList());
        continue;
      }

      if (this.sshHost) {
        await this.#handleSshInput(input);
        continue;
      }

      await this.#handleMessage(input);
    }

    this.#cleanup();
    stdout.write(`  ${this.t.muted('Пока!')}\n`);
  }


  async #runSlash(input) {
    const [name, ...rest] = input.slice(1).split(/\s+/);
    const key = name.toLowerCase();
    const args = rest.join(' ').trim();
    const cmd = this.commands[key];
    const pluginCmd = !cmd ? this.plugins.commands.get(key) : null;

    if (cmd) {
      try {
        await cmd.run(args);
      } catch (e) {
        stdout.write(`  ${this.t.error('Ошибка команды:')} ${e.message}\n\n`);
      }
      return;
    }
    if (pluginCmd) return this.#runPluginCommand(pluginCmd, args);

    const all = this.#completionList().map((c) => c.name);
    const near = all.filter((c) => c.startsWith(key.slice(0, 3))).slice(0, 3);
    stdout.write(`  ${this.t.error('Неизвестная команда:')} /${name}`
      + (near.length ? `  ${this.t.muted('может быть: ' + near.map((c) => '/' + c).join(', '))}` : `  ${this.t.muted('— /help покажет все')}`)
      + '\n\n');
  }


  async #runPluginCommand(cmd, argsStr) {
    const t = this.t;
    stdout.write(`  ${t.muted(`▸ ${cmd.plugin} · /${cmd.name}${argsStr ? ' ' + argsStr : ''}`)}\n`);
    let prompt;
    try {
      prompt = expandCommand(cmd, argsStr, { cwd: this.cwd });
    } catch (e) {
      stdout.write(`  ${t.error('Не смог подготовить команду:')} ${e.message}\n\n`);
      return;
    }
    if (!prompt.trim()) {
      stdout.write(`  ${t.muted('Пустая команда.')}\n\n`);
      return;
    }
    await this.#handleMessage(prompt);
  }

  async #handleMessage(input) {
    const t = this.t;
    this.spinner.start();

    try {
      const result = await this.agent.send(input);
      this.#flushStream();
      this.spinner.stop();

      if (this.cfg.ui.showTokenUsage && this.lastUsage) {
        const u = this.session.usage;
        stdout.write(
          `  ${t.muted(`${t.symbols.bullet} ${fmtNum(u.input)}↑ ${fmtNum(u.output)}↓ · ${result.steps} шаг(ов)`)}\n\n`,
        );
      }
    } catch (e) {
      this.#flushStream();
      this.spinner.stop();

      const stopped = /^(terminated|abort(ed)?|отменено пользователем|запрос прерван)$/i.test(String(e.message).trim());
      stdout.write(stopped ? `\n  ${t.warn('⏹ запрос остановлен')}\n` : `\n  ${t.error(t.symbols.cross + ' ' + e.message)}\n`);
      if (e.hint) stdout.write(`  ${t.muted(e.hint)}\n`);
      if (e.status === 401) stdout.write(`  ${t.muted('Сменить ключ: /key')}\n`);
      stdout.write('\n');
    }
  }

  async #handleSshInput(input) {
    const t = this.t;
    if (!this.sshHost) return;
    if (input === 'exit' || input === 'disconnect') {
      this.#endSshSession();
      stdout.write(`  ${t.success('✓')} SSH-сессия завершена\n\n`);
      return;
    }

    const host = this.sshHost;
    const task =
      `Ты подключён к серверу ${host.name} (${host.user}@${host.host}:${host.port}). ` +
      `Пользователь пишет задачу для удалённой машины. Используй инструмент Ssh, чтобы выполнить её. ` +
      `Если нужно запустить команду на сервере, сформируй один вызов Ssh(action:\"connect\", host:\"${host.name}\", command:\"...\"). ` +
      `Не отвечай просто текстом, если задача подразумевает выполнение на сервере. ` +
      `Задача: ${input}`;

    try {
      await this.#handleMessage(task);
    } catch (e) {
      stdout.write(`  ${t.error('Ошибка SSH:')} ${e.message}\n\n`);
    }
  }

  #endSshSession() {
    this.sshHost = null;
    if (this.input) this.input.setPrompt('  ' + this.t.symbols.prompt + ' ');
  }

  #cleanup() {
    this.spinner.stop();
    this.offKeys?.();
    this.offKeys = null;
    try { this.session.save(); } catch { /* ignore */ }
    releaseKeys();
  }
}
