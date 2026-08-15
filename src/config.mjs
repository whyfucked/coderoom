import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export const CONFIG_DIR = process.env.CODEROOM_HOME
  ? path.resolve(process.env.CODEROOM_HOME)
  : path.join(os.homedir(), '.coderoom');

export const VERSION = '1.1.5';

export const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
export const SESSIONS_DIR = path.join(CONFIG_DIR, 'sessions');
export const GLOBAL_MEMORY = path.join(CONFIG_DIR, 'CODEROOM.md');

// Разделы моделей — по ним строятся группы в /model и подсказки в UI.
// Группируем по создателю модели (а не по «скорости»): так проще искать глазами,
// и не приходится придумывать, чем «мощная» отличается от «прочей».
// Порядок важен: так они и рисуются в селекторе.
export const MODEL_TIERS = {
  anthropic: { label: 'Anthropic', note: 'Claude — умеют инструменты',   order: 1 },
  openai:    { label: 'ChatGPT',   note: 'GPT и GPT-OSS',                order: 2 },
  nvidia:    { label: 'Nvidia',    note: 'Nemotron',                     order: 3 },
  deepseek:  { label: 'DeepSeek',  note: 'сильные под код',              order: 4 },
  google:    { label: 'Google',    note: 'Gemini, Gemma, CodeGemma',     order: 5 },
  qwen:      { label: 'Qwen',      note: '',                                      order: 6 },
  zai:       { label: 'Z-AI',      note: 'GLM',                                   order: 7 },
  other:     { label: 'Прочие',    note: 'Grok, NN, роутеры и всё остальное',      order: 8 },
};


export const PROVIDER_PRESETS = {
  // Единственный провайдер клиента — наш шлюз. Всё, что раньше ходило напрямую
  // к чужим API, теперь идёт через него: клиент видит один ключ cr-… и публичные
  // имена моделей, а какой апстрим отвечает — забота сервера (см. server/gateway.mjs).
  //
  // Пометка tools — из реальных замеров (/v1/chat/completions с tool_choice=required):
  // tool_calls отдают только claude-opus-*/claude-sonnet-5, остальные молча игнорируют
  // tools, поэтому для агента (правки файлов, bash) годятся не все — только чат/smallModel.
  coderoom: {
    id: 'coderoom',
    label: 'CodeRoom',
    baseUrl: 'https://api.as201823.run',
    api: 'openai',
    keyEnv: 'CODEROOM_KEY',
    keyPrefix: 'cr-',
    isGateway: true,
    defaultModel: 'nemotron-3-ultra-550b',
    smallModel: 'nemotron-3-nano-30b',
    site: '',
    models: [
      // ── Anthropic ──
      { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'anthropic', tools: true, recommended: true, note: 'Флагман. Инструменты ✓ (~19s)' },
      { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'anthropic', tools: true, note: 'Top Claude Opus tier for the hardest reasoning, coding, and long-horizon agents' },
      { id: 'claude-opus-5', label: 'Claude Opus 5', tier: 'anthropic', tools: true, note: 'Agent-ready GPT for coding and computer-use workflows' },
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'anthropic', tools: true, note: 'Дешевле Opus, инструменты ✓ (~12–28s)' },
      { id: 'claude-sonnet', label: 'Claude Sonnet', tier: 'anthropic', note: 'Универсальная' },
      { id: 'claude-haiku', label: 'Claude Haiku', tier: 'anthropic', note: 'Лёгкая и быстрая' },
      { id: 'claude-fable-5', label: 'Claude Fable 5', tier: 'anthropic', tools: false, note: 'С tools зависает >75s — не брать для агента' },

      // ── ChatGPT ──
      { id: 'gpt-5-4', label: 'GPT-5.4', tier: 'openai', tools: false, note: 'Самая быстрая (~8.8s). Без инструментов' },
      { id: 'gpt-5-5', label: 'GPT-5.5', tier: 'openai', tools: false, note: 'Быстрая (~9.6s). Без инструментов' },
      { id: 'gpt-5-6-luna', label: 'GPT-5.6 Luna', tier: 'openai', tools: false, note: 'Быстрая (~11–16s). Без инструментов' },
      { id: 'gpt-5.6', label: 'GPT-5.6', tier: 'openai', tools: false, note: 'Без инструментов (~15–52s, нестабильно)' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', tier: 'openai', tools: false, note: 'Frontier GPT-5.6 model for complex professional work, coding, and agentic workflows' },
      { id: 'gpt-5-6-terra', label: 'GPT-5.6 Terra', tier: 'openai', tools: false, note: 'Без инструментов (~12–47s)' },
      { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'openai', note: 'Открытая, крупная' },
      { id: 'gpt-oss-20b', label: 'GPT-OSS 20B', tier: 'openai', note: 'Открытая, лёгкая' },

      // ── Nvidia ──
      { id: 'nemotron-3-ultra-550b', label: 'Nemotron 3 Ultra 550B', tier: 'nvidia', note: 'Флагман с рассуждением', recommended: true },
      { id: 'nemotron-3-super-120b', label: 'Nemotron 3 Super 120B', tier: 'nvidia', note: 'С рассуждением' },
      { id: 'nemotron-3-nano-30b', label: 'Nemotron 3 Nano 30B', tier: 'nvidia', note: 'Быстрая, для правок' },
      { id: 'nemotron-nano-9b-v2', label: 'Nemotron Nano 9B v2', tier: 'nvidia', note: 'Лёгкая' },
      { id: 'llama-nemotron-super-49b-v1.5', label: 'Llama Nemotron Super 49B v1.5', tier: 'nvidia' },
      { id: 'llama-nemotron-super-49b', label: 'Llama Nemotron Super 49B', tier: 'nvidia' },
      { id: 'llama-nemotron-70b', label: 'Llama Nemotron 70B', tier: 'nvidia' },

      // ── DeepSeek ──
      { id: 'DeepSeek-V4-Pro', label: 'DeepSeek V4 Pro', tier: 'deepseek', note: 'Сильная, для кода' },
      { id: 'DeepSeek-V4-Flash', label: 'DeepSeek V4 Flash', tier: 'deepseek', note: 'Быстрая MoE' },
      { id: 'DeepSeek-V4-Flash-0731', label: 'DeepSeek V4 Flash (0731)', tier: 'deepseek', note: 'Снапшот 0731' },

      // ── Google ──
      { id: 'gemini-3-flash', label: 'Gemini 3 Flash', tier: 'google', tools: false, note: 'Быстрая (~17s). Без инструментов' },
      { id: 'gemini-3-1-pro', label: 'Gemini 3.1 Pro', tier: 'google', tools: false, note: 'Без инструментов, бывает 500/таймаут' },
      { id: 'gemini-3-pro', label: 'Gemini 3 Pro', tier: 'google', tools: false, note: 'Медленная (до ~74s), бывает 500' },
      { id: 'gemma-4', label: 'Gemma 4', tier: 'google' },
      { id: 'gemma-4-26b', label: 'Gemma 4 26B', tier: 'google' },
      { id: 'gemma-3-12b', label: 'Gemma 3 12B', tier: 'google', note: 'Лёгкая' },
      { id: 'gemma-2-2b', label: 'Gemma 2 2B', tier: 'google', note: 'Совсем маленькая' },
      { id: 'codegemma-7b', label: 'CodeGemma 7B', tier: 'google', note: 'Под код' },
      { id: 'diffusiongemma-26b', label: 'DiffusionGemma 26B A4B', tier: 'google', note: 'Диффузионная' },

      // ── Qwen ──
      { id: 'qwen3-coder-480b', label: 'Qwen3 Coder 480B-A35B', tier: 'qwen', note: 'Заточена под код' },
      { id: 'qwen3-next-80b', label: 'Qwen3 Next 80B-A3B', tier: 'qwen' },
      { id: 'qwen3.5-122b', label: 'Qwen3.5 122B-A10B', tier: 'qwen' },
      { id: 'Qwen3.5-397B-A17B', label: 'Qwen3.5 397B-A17B', tier: 'qwen', note: 'Крупная MoE' },
      { id: 'qwen3.5-397b-alt', label: 'Qwen3.5 397B-A17B · alt', tier: 'qwen', note: 'Крупная MoE' },
      { id: 'Qwen3.6-35B-A3B', label: 'Qwen3.6 35B-A3B', tier: 'qwen', note: 'Лёгкая MoE' },
      { id: 'qwen2.5', label: 'Qwen2.5', tier: 'qwen' },

      // ── Z-AI ──
      { id: 'glm-5.2', label: 'GLM 5.2', tier: 'zai', note: 'Топ, но медленная' },
      { id: 'glm-5.2-alt', label: 'GLM 5.2 · alt', tier: 'zai' },
      { id: 'glm-5.1', label: 'GLM 5.1', tier: 'zai', note: 'Длинные задачи' },
      { id: 'glm-5.1-alt', label: 'GLM 5.1 · alt', tier: 'zai' },

      // ── Прочие: роутеры и всё, что не попало в разделы выше ──
      { id: 'auto', label: 'Auto', tier: 'other', note: 'Роутер: сам выбирает модель', recommended: true },
      { id: 'step-router-v1', label: 'Step Router v1', tier: 'other', note: 'Роутер step/deepseek' },
      { id: 'grok-4-5', label: 'Grok 4.5', tier: 'other', tools: false, note: 'Без инструментов (~13–57s)' },
      { id: 'kat-coder-pro-v2.5', label: 'KAT Coder Pro v2.5', tier: 'other', note: 'Заточена под код' },
      { id: 'Kimi-K2.6', label: 'Kimi K2.6', tier: 'other' },
      { id: 'MiniMax-M3', label: 'MiniMax M3', tier: 'other', note: 'Мультимодальная' },
      { id: 'sensenova-6.7-flash-lite', label: 'SenseNova 6.7 Flash Lite', tier: 'other', note: 'Лёгкая' },
      { id: 'step-3.7-flash', label: 'Step 3.7 Flash', tier: 'other' },
      { id: 'step-3.5-flash', label: 'Step 3.5 Flash', tier: 'other' },
      { id: 'step-3.5-flash-2603', label: 'Step 3.5 Flash (2603)', tier: 'other' },
    ],
  },
};


export const DEFAULT_CONFIG = {
  version: 1,
  provider: 'coderoom',
  model: 'auto',
  smallModel: 'nemotron-3-nano-30b',
  theme: 'claude',
  webTheme: 'aurora',
  lang: 'ru',
  providers: {},
  hosts: {},          // серверы для SSH: имя → { host, user, port, keyFile }
  customPrompts: {},  // пользовательские промты: имя → { name, prompt, description }
  activeCustomPrompt: null,
  permissions: {
    mode: 'yolo',
    allow: ['Read(**)', 'Glob(**)', 'Grep(**)', 'List(**)', 'Todo(**)'],
    ask: ['Write(**)', 'Edit(**)', 'Bash(**)', 'WebFetch(**)', 'Ssh(**)'],
    deny: [],
  },
  security: {
    restrictToWorkspace: true,
    confirmDangerousCommands: true,
    redactSecrets: true,
    blockedPaths: ['.env', '.env.*', 'id_rsa', 'id_ed25519', '*.pem', '*.key', 'credentials.json'],
  },
  agent: {
    maxSteps: 40,
    maxTokens: 8192,
    temperature: 0.2,
    autoCompactAt: 140000,
    streamReasoning: true,
  },
  ui: {
    showTokenUsage: true,
    showCost: true,
    compactToolOutput: true,
    maxToolOutputLines: 24,
    banner: true,
  },
  web: {
    port: 4517,
    host: '127.0.0.1',
    autoOpen: true,
  },
  update: {
    check: true,          // смотреть, не вышла ли новая версия в npm
    prompt: true,         // спрашивать «обновить?» при запуске
    autoInstall: false,   // ставить сразу, без вопросов
    intervalHours: 24,    // как часто ходить в реестр
    channel: 'latest',    // dist-tag: latest | next | …
    skipVersion: null,    // версия, про которую больше не напоминать
  },
  telemetry: false,
  onboarded: false,
};

function deepMerge(base, over) {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return over ?? base;
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function ensureConfigDir() {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export function loadConfig({ cwd = process.cwd() } = {}) {
  let cfg = structuredClone(DEFAULT_CONFIG);

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      cfg = deepMerge(cfg, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
    } catch (e) {
      cfg._loadError = `Не смог прочитать ${CONFIG_FILE}: ${e.message}`;
    }
  }

  const projectFile = path.join(cwd, '.coderoom', 'settings.json');
  if (fs.existsSync(projectFile)) {
    try {
      const proj = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
      delete proj.providers;
      cfg = deepMerge(cfg, proj);
      cfg._projectSettings = projectFile;
    } catch (e) {
      cfg._loadError = `Не смог прочитать ${projectFile}: ${e.message}`;
    }
  }

  if (process.env.CODEROOM_MODEL) cfg.model = process.env.CODEROOM_MODEL;
  if (process.env.CODEROOM_THEME) cfg.theme = process.env.CODEROOM_THEME;

  if (!PROVIDER_PRESETS[cfg.provider]) {
    cfg.provider = DEFAULT_CONFIG.provider;
  }

  if (/^\d+$/.test(String(cfg.model ?? ''))) {
    cfg.model = PROVIDER_PRESETS[cfg.provider]?.defaultModel || 'auto';
  }

  return cfg;
}

export function saveConfig(cfg) {
  ensureConfigDir();
  const clean = { ...cfg };
  for (const k of Object.keys(clean)) if (k.startsWith('_')) delete clean[k];

  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_FILE);
  try {
    fs.chmodSync(CONFIG_FILE, 0o600);
  } catch {
  }
  return CONFIG_FILE;
}

export function resolveProvider(cfg, providerId = cfg.provider) {
  const preset = PROVIDER_PRESETS[providerId];
  if (!preset) throw new Error(`Неизвестный провайдер: ${providerId}`);

  const saved = cfg.providers?.[providerId] ?? {};
  const envKey = preset.keyEnv ? process.env[preset.keyEnv] : undefined;

  return {
    ...preset,
    ...saved,
    apiKey: envKey || saved.apiKey || '',
    baseUrl: (process.env.CODEROOM_BASE_URL || saved.baseUrl || preset.baseUrl || '')
      .replace(/\/+$/, '').replace(/\/v1$/, ''),
    userAgent: saved.userAgent || preset.userAgent || `coderoom/${VERSION} (cli)`,
    keySource: envKey ? `env:${preset.keyEnv}` : saved.apiKey ? 'config' : 'none',
  };
}

export function setProviderKey(cfg, providerId, apiKey, extra = {}) {
  cfg.providers ??= {};
  cfg.providers[providerId] = { ...(cfg.providers[providerId] ?? {}), apiKey, ...extra };
  return cfg;
}

export function projectId(cwd = process.cwd()) {
  const hash = crypto.createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 12);
  const base = path.basename(path.resolve(cwd)).replace(/[^\w.-]+/g, '_').slice(0, 32) || 'project';
  return `${base}-${hash}`;
}


const HISTORY_FILE = path.join(CONFIG_DIR, 'history.json');
const HISTORY_MAX = 500;

export function loadHistory() {
  try {
    const arr = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    return Array.isArray(arr) ? arr.filter((s) => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function saveHistory(list) {
  try {
    ensureConfigDir();
    const tail = list.slice(-HISTORY_MAX);
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(tail), { mode: 0o600 });
  } catch {
  }
}

export function maskKey(key) {
  if (!key) return '(не задан)';
  if (key.length <= 12) return key.slice(0, 3) + '***';
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
