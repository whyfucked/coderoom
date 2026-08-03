import { stdin, stdout } from 'node:process';
import {
  PROVIDER_PRESETS, DEFAULT_CONFIG, saveConfig, setProviderKey, resolveProvider,
  CONFIG_FILE, maskKey,
} from './config.mjs';
import { Provider } from './provider.mjs';
import { THEMES, WEB_THEMES, createTheme } from './themes.mjs';
import { box } from './render.mjs';

import { VERSION } from './config.mjs';

let pipedBuf = '';


async function readLine(question, { secret = false, def = '' } = {}) {
  stdout.write(question);

  if (!stdin.isTTY) {
    return await new Promise((resolve) => {
      const take = () => {
        const nl = pipedBuf.indexOf('\n');
        if (nl === -1) return false;
        const line = pipedBuf.slice(0, nl).replace(/\r$/, '');
        pipedBuf = pipedBuf.slice(nl + 1);
        resolve(line.trim() || def);
        return true;
      };
      if (take()) return;
      const onData = (d) => {
        pipedBuf += d.toString('utf8');
        if (take()) { stdin.removeListener('data', onData); stdin.pause(); }
      };
      stdin.resume();
      stdin.on('data', onData);
    });
  }

  return await new Promise((resolve) => {
    const others = stdin.listeners('data');
    others.forEach((l) => stdin.removeListener('data', l));

    const wasRaw = stdin.isRaw;
    try { stdin.setRawMode(true); } catch { /* некоторые терминалы не умеют */ }
    stdin.resume();

    let value = '';
    let esc = false;

    const cleanup = () => {
      stdin.removeListener('data', onData);
      try { stdin.setRawMode(wasRaw ?? false); } catch { /* ignore */ }
      others.forEach((l) => stdin.addListener('data', l));
      if (others.length) stdin.resume(); else stdin.pause();
    };

    const onData = (chunk) => {
      for (const ch of chunk.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (esc) { if (/[a-zA-Z~]/.test(ch)) esc = false; continue; }
        if (code === 27) { esc = true; continue; }
        if (code === 13 || code === 10) { cleanup(); stdout.write('\n'); return resolve(value.trim() || def); }
        if (code === 3) { cleanup(); stdout.write('\n'); process.exit(130); }
        if (code === 127 || code === 8) { if (value.length) { value = value.slice(0, -1); stdout.write('\b \b'); } continue; }
        if (code < 32) continue;
        value += ch;
        stdout.write(secret ? '•' : ch);
      }
    };
    stdin.on('data', onData);
  });
}


async function askSecret(question) {
  return readLine(question, { secret: true });
}

function header(t) {
  const lines = [
    t.bold(t.primary('CodeRoom')) + t.muted(` v${VERSION}`),
    '',
    'Локальный агент для работы с кодом.',
    'Читает и правит файлы, запускает команды — с твоего разрешения.',
    '',
    t.muted('Настройка займёт полминуты. Всё можно поменять позже: /config'),
  ].join('\n');
  return box(lines, t, { title: 'Первый запуск' });
}


export async function runOnboarding(cfg, { reason = 'first-run' } = {}) {
  const t = createTheme(cfg.theme);
  const ask = (q, def = '') => readLine(q, { def });

  {
    console.log('\n' + header(t) + '\n');

    if (reason === 'no-key') {
      console.log(t.warn('  Нужен API-ключ, чтобы продолжить.\n'));
    }


    const providerIds = Object.keys(PROVIDER_PRESETS);
    const fallbackId = providerIds.includes(DEFAULT_CONFIG.provider) ? DEFAULT_CONFIG.provider : providerIds[0];
    let providerId = fallbackId;

    if (providerIds.length > 1) {
      console.log(t.bold('  1. Провайдер\n'));
      providerIds.forEach((id, i) => {
        const p = PROVIDER_PRESETS[id];
        const mark = id === fallbackId ? t.success(' ← рекомендуется') : '';
        console.log(`  ${t.primary(String(i + 1))}. ${p.label}${mark}`);
        console.log(`     ${t.muted(p.baseUrl || 'свой адрес')}`);
      });

      const pIdx = await ask(`\n  ${t.primary('❯')} Выбор [1]: `, '1');
      const n = Number(pIdx);
      providerId = Number.isFinite(n)
        ? (providerIds[Math.max(0, Math.min(providerIds.length - 1, n - 1))] ?? fallbackId)
        : fallbackId;
    }

    cfg.provider = providerId;
    const preset = PROVIDER_PRESETS[providerId];
    if (!preset) throw new Error(`Провайдер ${providerId} не найден в пресетах`);

    if (!preset.baseUrl) {
      const url = await ask(`  ${t.primary('❯')} Базовый URL (например https://api.example.com): `);
      cfg.providers[providerId] = { ...(cfg.providers[providerId] ?? {}), baseUrl: url.replace(/\/+$/, '') };
    }

    if (preset.isGateway) {
      console.log('\n' + t.muted('  CodeRoom ходит к моделям через шлюз — он держит ключи провайдеров у себя.'));
      console.log(t.muted('  Обычно менять адрес не нужно: жми Enter.'));
      const url = await ask(`\n  ${t.primary('❯')} URL шлюза [${preset.baseUrl}]: `, preset.baseUrl);
      cfg.providers[providerId] = { ...(cfg.providers[providerId] ?? {}), baseUrl: url.replace(/\/+$/, '') };
    }


    console.log('\n' + t.bold('  2. API-ключ\n'));
    if (preset.isGateway) {
      console.log(t.muted(`  Нужен ключ вида ${preset.keyPrefix ?? 'cr-'}… — его выдаёт владелец шлюза.`));
    }
    if (preset.keyEnv) {
      console.log(t.muted(`  Можно не вводить, а задать переменную окружения ${preset.keyEnv}.`));
    }
    console.log(t.muted(`  Ключ сохранится локально в ${CONFIG_FILE} (доступ только тебе).\n`));

    const envVarName = preset.keyEnv && process.env[preset.keyEnv] ? preset.keyEnv : null;
    const envKey = envVarName ? process.env[envVarName] : null;
    let key = '';

    if (envKey) {
      console.log(`  ${t.success('✓')} Нашёл ключ в ${envVarName}: ${t.muted(maskKey(envKey))}`);
      const useEnv = await ask(`  ${t.primary('❯')} Использовать его? [Y/n]: `, 'y');
      if (!/^n/i.test(useEnv)) key = envKey;
    }

    if (!key) {
      while (true) {
        key = await askSecret(`  ${t.primary('❯')} Вставь ключ: `);
        if (key) break;
        if (preset.keyOptional) break;
        console.log(t.warn('  Пустой ключ. Попробуй ещё раз (Ctrl+C — выход).'));
      }
    }

    if (key) setProviderKey(cfg, providerId, key);


    console.log('\n  ' + t.muted('Проверяю ключ…'));
    const provider = new Provider(cfg, providerId);
    const check = await provider.validateKey();

    let liveModels = [];
    if (check.ok) {
      liveModels = check.models ?? [];
      console.log(`  ${t.success('✓')} Ключ работает. Доступно моделей: ${liveModels.length}\n`);
    } else {
      console.log(`  ${t.error('✗')} ${check.error}`);
      if (check.hint) console.log(`  ${t.muted(check.hint)}`);
      const cont = await ask(`\n  ${t.primary('❯')} Всё равно продолжить? [y/N]: `, 'n');
      if (!/^y/i.test(cont)) {
        console.log(t.muted('\n  Настройка прервана. Запусти снова: coderoom\n'));
        process.exit(1);
      }
      console.log('');
    }


    console.log(t.bold('  3. Модель\n'));
    const models = liveModels.length
      ? liveModels.map((m) => {
          const known = preset.models?.find((k) => k.id === m.id);
          return { id: m.id, label: known?.label ?? m.id, note: known?.note ?? '', recommended: known?.recommended };
        })
      : preset.models ?? [];

    let model = preset.defaultModel;
    if (models.length) {
      models.forEach((m, i) => {
        const mark = m.recommended ? t.success(' ← рекомендуется') : '';
        console.log(`  ${t.primary(String(i + 1))}. ${t.bold(m.label)}${mark}`);
        if (m.note) console.log(`     ${t.muted(m.note)}`);
        if (m.label !== m.id) console.log(`     ${t.muted(m.id)}`);
      });
      const defIdx = Math.max(1, models.findIndex((m) => m.recommended) + 1);
      const mIdx = await ask(`\n  ${t.primary('❯')} Выбор [${defIdx}]: `, String(defIdx));
      model = models[Math.max(0, Math.min(models.length - 1, Number(mIdx) - 1))]?.id ?? model;
    } else {
      model = await ask(`  ${t.primary('❯')} Имя модели [${preset.defaultModel}]: `, preset.defaultModel);
    }
    cfg.model = model;

    const fast = models.find((m) => /gpt|haiku|mini|flash|sol/i.test(m.id) && m.id !== model);
    cfg.smallModel = fast?.id ?? model;


    console.log('\n' + t.bold('  4. Дизайн терминала\n'));
    const themeNames = Object.keys(THEMES);
    themeNames.forEach((name, i) => {
      const th = createTheme(name);
      const swatch = [th.primary('███'), th.accent('███'), th.success('██'), th.warn('██'), th.error('██')].join('');
      console.log(`  ${t.primary(String(i + 1))}. ${th.bold(THEMES[name].label).padEnd(20)} ${swatch}`);
      console.log(`     ${t.muted(THEMES[name].description)}`);
      console.log(`     ${th.muted('пример:')} ${th.symbols.prompt} ${th.text('привет')}  ${th.primary(th.symbols.assistant)} ${th.muted('ответ агента')}`);
    });

    const tIdx = await ask(`\n  ${t.primary('❯')} Выбор [1]: `, '1');
    cfg.theme = themeNames[Math.max(0, Math.min(themeNames.length - 1, Number(tIdx) - 1))] ?? 'claude';


    const t2 = createTheme(cfg.theme);
    console.log('\n' + t2.bold('  5. Насколько агент свободен\n'));
    const modes = [
      { id: 'default', label: 'Спрашивать', note: 'подтверждение перед правкой файлов и командами — безопасно' },
      { id: 'acceptEdits', label: 'Править сам', note: 'файлы меняет без спроса, команды спрашивает' },
      { id: 'plan', label: 'Только чтение', note: 'ничего не меняет, только исследует и предлагает план' },
    ];
    modes.forEach((m, i) => {
      console.log(`  ${t2.primary(String(i + 1))}. ${t2.bold(m.label)}`);
      console.log(`     ${t2.muted(m.note)}`);
    });
    const modeIdx = await ask(`\n  ${t2.primary('❯')} Выбор [1]: `, '1');
    cfg.permissions.mode = modes[Math.max(0, Math.min(modes.length - 1, Number(modeIdx) - 1))]?.id ?? 'default';


    cfg.onboarded = true;
    saveConfig(cfg);

    const done = createTheme(cfg.theme);
    const summary = [
      `${done.muted('Провайдер:')} ${PROVIDER_PRESETS[cfg.provider].label}`,
      `${done.muted('Ключ:')}      ${maskKey(resolveProvider(cfg).apiKey)}`,
      `${done.muted('Модель:')}    ${done.primary(cfg.model)}`,
      `${done.muted('Дизайн:')}    ${THEMES[cfg.theme].label}`,
      `${done.muted('Режим:')}     ${modes.find((m) => m.id === cfg.permissions.mode)?.label ?? cfg.permissions.mode}`,
      '',
      done.muted(`Настройки: ${CONFIG_FILE}`),
    ].join('\n');

    console.log('\n' + box(summary, done, { title: '✓ Готово' }));
    console.log(
      '\n  ' + done.muted('Полезное: ') +
      done.primary('/help') + done.muted(' — команды, ') +
      done.primary('/theme') + done.muted(' — сменить дизайн, ') +
      done.primary('/web') + done.muted(' — интерфейс в браузере\n'),
    );

    return cfg;
  }
}


export async function changeKey(cfg) {
  const t = createTheme(cfg.theme);
  const providerId = cfg.provider;
  const preset = PROVIDER_PRESETS[providerId];

  console.log('\n  ' + t.bold(`Ключ для ${preset.label}`));
  console.log('  ' + t.muted(`Текущий: ${maskKey(resolveProvider(cfg).apiKey)}\n`));

  const key = await askSecret(`  ${t.primary('❯')} Новый ключ (Enter — отмена): `);
  if (!key) {
    console.log(t.muted('  Отменено.\n'));
    return cfg;
  }

  setProviderKey(cfg, providerId, key);
  process.stdout.write('  ' + t.muted('Проверяю… '));

  const check = await new Provider(cfg, providerId).validateKey();
  if (check.ok) {
    saveConfig(cfg);
    console.log(t.success(`✓ работает, моделей: ${check.models.length}\n`));
  } else {
    console.log(t.error(`✗ ${check.error}`));
    if (check.hint) console.log('  ' + t.muted(check.hint));
    console.log('  ' + t.muted('Ключ всё равно сохранён — поменяй через /key.\n'));
    saveConfig(cfg);
  }
  return cfg;
}

export { askSecret, VERSION };
