#!/usr/bin/env node


import path from 'node:path';
import process from 'node:process';
import { loadConfig, saveConfig, resolveProvider, CONFIG_FILE } from '../src/config.mjs';
import { runOnboarding, VERSION } from '../src/onboarding.mjs';
import { Repl } from '../src/repl.mjs';
import { Session } from '../src/session.mjs';
import { Agent } from '../src/agent.mjs';
import { createTheme, THEME_NAMES } from '../src/themes.mjs';
import { StreamRenderer, Spinner, setTerminalTitle } from '../src/render.mjs';

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];

    switch (a) {
      case '-h': case '--help': opts.help = true; break;
      case '-v': case '--version': opts.version = true; break;
      case '-w': case '--web': opts.web = true; break;
      case '-c': case '--continue': opts.continue = true; break;
      case '-r': case '--resume': opts.resume = next() ?? true; break;
      case '--setup': opts.setup = true; break;
      case '-m': case '--model': opts.model = next(); break;
      case '-t': case '--theme': opts.theme = next(); break;
      case '--mode': opts.mode = next(); break;
      case '-d': case '--dir': opts.dir = next(); break;
      case '-p': case '--print': opts.print = true; break;
      case '--port': opts.port = Number(next()); break;
      case '--yolo': opts.mode = 'yolo'; break;
      case '--plan': opts.mode = 'plan'; break;
      case '--no-color': process.env.NO_COLOR = '1'; break;
      default:
        if (a.startsWith('-')) {
          console.error(`Неизвестный флаг: ${a}\nСправка: coderoom --help`);
          process.exit(2);
        }
        opts._.push(a);
    }
  }
  return opts;
}

function help() {
  const t = createTheme('claude');
  console.log(`
  ${t.bold(t.primary('CodeRoom'))} ${t.muted('v' + VERSION)} — локальный агент для работы с кодом

  ${t.bold('Использование')}
    coderoom                       интерактивный режим в текущей папке
    coderoom "текст задачи"        выполнить задачу и выйти
    coderoom --web                 открыть интерфейс в браузере
    ${t.muted('(шлюз — отдельный сервер в папке server/: cd server && npm start)')}

  ${t.bold('Флаги')}
    -m, --model <имя>       модель на этот запуск
    -t, --theme <имя>       дизайн: ${THEME_NAMES.join(', ')}
    -d, --dir <путь>        рабочая папка (по умолчанию текущая)
        --mode <режим>      default | acceptEdits | plan | yolo
        --plan              то же, что --mode plan (ничего не меняет)
        --yolo              без подтверждений ${t.muted('(осторожно)')}
    -c, --continue          продолжить последнюю сессию в этой папке
    -r, --resume <id>       продолжить конкретную сессию
    -p, --print             без интерактива: вывести ответ и выйти
    -w, --web               веб-интерфейс
        --port <n>          порт для веба (по умолчанию 4517)
        --setup             заново пройти настройку
        --no-color          без цветов
    -h, --help              эта справка
    -v, --version           версия

  ${t.bold('Примеры')}
    ${t.muted('coderoom "добавь тесты для src/utils.js"')}
    ${t.muted('coderoom --plan "как устроена авторизация?"')}
    ${t.muted('coderoom -m gpt-5.6-sol -d ./backend')}

  ${t.muted('Настройки: ' + CONFIG_FILE)}
`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === 'gateway') {
    const { existsSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const serverDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server');

    console.log(existsSync(serverDir)
      ? [
          '',
          '  Шлюз — отдельный сервер в папке server/ (ставится на домен отдельно).',
          '',
          '  Запуск:              cd server && npm start',
          '  Управление ключами:  cd server && node keys.mjs new|ls|rm|status|stats',
          '  Токены апстримов:    server/.env',
          '',
        ].join('\n')
      : [
          '',
          '  Шлюз — серверная часть, в этот пакет она не входит.',
          '  Клиенту нужен только ключ cr-… от владельца шлюза:',
          '',
          '    coderoom --setup      настроить заново (спросит адрес и ключ)',
          '    /key                  сменить ключ в диалоге',
          '    /gateway <url>        указать другой шлюз',
          '',
        ].join('\n'));
    return;
  }

  const opts = parseArgs(argv);

  if (opts.help) return help();
  if (opts.version) return console.log(VERSION);

  const cwd = path.resolve(opts.dir ?? process.cwd());
  let cfg = loadConfig();

  const prov = resolveProvider(cfg);
  const hasEnvKey = prov.keySource.startsWith('env');
  if (opts.setup || (!cfg.onboarded && !hasEnvKey) || !prov.apiKey) {
    cfg = await runOnboarding(cfg, { reason: !prov.apiKey && cfg.onboarded ? 'no-key' : 'first-run' });
  }

  if (opts.model) cfg.model = opts.model;
  if (opts.theme) cfg.theme = opts.theme;
  if (opts.mode) cfg.permissions.mode = opts.mode;


  if (opts.web) {
    const { startWebServer } = await import('../src/web.mjs');
    const t = createTheme(cfg.theme);
    setTerminalTitle('coderoom · web');
    const info = await startWebServer({ cfg, cwd, port: opts.port });

    console.log(`\n  ${t.bold(t.primary('CodeRoom'))} ${t.muted('веб-интерфейс')}`);
    console.log(`  ${t.underline(t.accent(info.url))}`);
    console.log(`  ${t.muted('папка: ' + cwd)}`);
    console.log(`  ${t.muted('модель: ' + cfg.model + '  ·  дизайнов: 5, переключаются в ⚙')}`);
    console.log(`  ${t.muted('Ctrl+C — остановить\n')}`);

    process.on('SIGINT', () => {
      console.log(`\n  ${t.muted('Остановлено.')}`);
      process.exit(0);
    });
    return;
  }


  const task = opts._.join(' ').trim();
  if (task && opts.print) {
    const t = createTheme(cfg.theme);
    const session = new Session({ cwd, model: cfg.model, provider: cfg.provider });
    const stream = new StreamRenderer(t, process.stdout);
    const spinner = new Spinner(t);

    const agent = new Agent({
      cfg,
      session,
      cwd,
      ui: {
        onStep: () => spinner.start(),
        onText: (d) => { spinner.stop(); stream.write(d); },
        onToolStart: (c) => { spinner.stop(); process.stderr.write(`  ${t.muted('· ' + c.label)}\n`); },
        onNotice: (text, level) => { if (level !== 'info') process.stderr.write(`  ${t.muted(text)}\n`); },
        confirm: async (req) => {
          process.stderr.write(`  ${t.warn('нужно подтверждение: ' + req.label)} ${t.muted('(--print: отклонено)')}\n`);
          return 'no';
        },
      },
    });

    try {
      await agent.send(task);
      stream.flush();
      spinner.stop();
      process.exit(0);
    } catch (e) {
      spinner.stop();
      console.error(`\n  Ошибка: ${e.message}${e.hint ? '\n  ' + e.hint : ''}`);
      process.exit(1);
    }
  }


  let session;
  if (opts.continue) {
    session = Session.latest(cwd);
    if (session) session.model = cfg.model;
  } else if (typeof opts.resume === 'string') {
    const found = Session.list(cwd, 50).find((s) => s.id.startsWith(opts.resume));
    if (found) session = Session.load(found.file);
  }

  const repl = new Repl({ cfg, cwd, session });

  if (session) {
    const t = createTheme(cfg.theme);
    console.log(`  ${t.muted(`Продолжаю сессию ${session.id} — ${session.messages.length} сообщений`)}`);
  }

  if (task) repl.initialTask = task;

  await repl.start();
  process.exit(0);
}

main().catch((e) => {
  console.error(`\nCodeRoom упал: ${e?.stack ?? e}\n`);
  process.exit(1);
});
