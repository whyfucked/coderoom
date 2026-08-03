import { resolveProvider } from './config.mjs';

export class ProviderError extends Error {
  constructor(message, { status, body, retryable = false, hint } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.body = body;
    this.retryable = retryable;
    this.hint = hint;
  }
}

async function* parseSSE(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + buffer.slice(idx).match(/^\r?\n\r?\n/)[0].length);

        let eventName = null;
        const dataLines = [];
        for (const line of rawEvent.split(/\r?\n/)) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
        }
        if (!dataLines.length) continue;

        const data = dataLines.join('\n');
        if (data === '[DONE]') return;

        try {
          yield { event: eventName, data: JSON.parse(data) };
        } catch {
        }
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Provider {
  constructor(cfg, providerId = cfg.provider) {
    this.cfg = cfg;
    this.settings = resolveProvider(cfg, providerId);
  }

  get id() {
    return this.settings.id;
  }
  get label() {
    return this.settings.label;
  }
  get hasKey() {
    return Boolean(this.settings.apiKey) || this.settings.keyOptional;
  }

  headers(extra = {}) {
    const s = this.settings;
    const h = {
      'Content-Type': 'application/json',
      'User-Agent': s.userAgent,
      ...extra,
    };
    if (s.apiKey) h.Authorization = `Bearer ${s.apiKey}`;
    return h;
  }

  async listModels({ timeoutMs = 20000 } = {}) {
    const res = await this.#fetch('/v1/models', { method: 'GET' }, { timeoutMs });
    const json = await res.json().catch(() => ({}));
    const data = Array.isArray(json?.data) ? json.data : [];
    return data.map((m) => ({
      id: m.id,
      endpoints: m.supported_endpoint_types ?? [],
      ownedBy: m.owned_by,
    }));
  }

  async validateKey() {
    try {
      const models = await this.listModels({ timeoutMs: 20000 });
      return { ok: true, models };
    } catch (e) {
      return {
        ok: false,
        error: e.message,
        status: e.status,
        hint: e.hint,
      };
    }
  }

  async #fetch(pathname, init, { timeoutMs = 300000, signal } = {}) {
    if (!this.settings.apiKey && !this.settings.keyOptional) {
      throw new ProviderError(`Не задан API-ключ для провайдера ${this.settings.label}`, {
        status: 401,
        retryable: false,
        hint: `Задай ключ: coderoom --setup, команда /key${this.settings.keyEnv ? `, или переменная окружения ${this.settings.keyEnv}` : ''}`,
      });
    }

    const bases = [this.settings.baseUrl, ...(this.settings.fallbackBaseUrls ?? [])].filter(Boolean);
    if (!bases.length) {
      throw new ProviderError(`Не задан базовый URL для провайдера ${this.settings.label}`, {
        status: 0,
        retryable: false,
        hint: 'Укажи baseUrl в настройках провайдера (coderoom --setup)',
      });
    }
    let lastErr;

    for (const base of bases) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctrl.abort(new Error('timeout')), timeoutMs);

      try {
        const res = await fetch(base + pathname, {
          ...init,
          headers: this.headers(init.headers),
          signal: ctrl.signal,
        });

        if (!res.ok) {
          const text = await res.text().catch(() => '');
          const err = this.#toError(res.status, text);
          if (err.retryable && bases.length > 1) {
            lastErr = err;
            continue;
          }
          throw err;
        }
        return res;
      } catch (e) {
        if (signal?.aborted) throw new ProviderError('Отменено пользователем', { retryable: false });
        lastErr = e instanceof ProviderError
          ? e
          : new ProviderError(this.#netMessage(e), { retryable: true, hint: this.#netHint() });
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr ?? new ProviderError('Не удалось выполнить запрос');
  }

  #netMessage(e) {
    if (e?.message === 'timeout' || e?.name === 'TimeoutError') return 'Таймаут запроса к провайдеру';
    if (e?.name === 'AbortError') return 'Запрос прерван';

    const code = e?.cause?.code;
    if (this.settings.isGateway && (code === 'ENOTFOUND' || code === 'ECONNREFUSED' || code === 'ETIMEDOUT')) {
      return `Шлюз недоступен: ${this.settings.baseUrl}`;
    }
    if (code === 'ENOTFOUND') return 'DNS не резолвится — проверь интернет/прокси';
    if (code === 'ECONNREFUSED') return 'Соединение отклонено — сервер недоступен';
    return `Сетевая ошибка: ${e?.message ?? e}`;
  }

  #netHint() {
    if (!this.settings.isGateway) return undefined;
    return 'Подними шлюз:  cd server && npm start\n' +
      `Или укажи другой адрес:  /gateway http://127.0.0.1:8787  (сейчас ${this.settings.baseUrl})`;
  }

  #toError(status, text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
    }
    const msg = parsed?.error?.message ?? parsed?.message ?? text?.slice(0, 300) ?? '';

    if (status === 401 || status === 403) {
      const isUaBlock = /unauthorized client/i.test(msg);
      const s = this.settings;
      const keyHint = s.isGateway
        ? `Нужен действующий ключ ${s.keyPrefix ?? 'cr-'}… от владельца шлюза. Сменить: /key` +
          (s.keyEnv ? `, либо переменная ${s.keyEnv}` : '')
        : `Проверь ключ: /key${s.keyEnv ? `. Или задай переменную окружения ${s.keyEnv}` : ''}`;

      return new ProviderError(
        isUaBlock
          ? 'Провайдер отклонил клиента (проверка User-Agent)'
          : 'Неверный или истёкший API-ключ',
        {
          status,
          body: msg,
          retryable: false,
          hint: isUaBlock
            ? `Релей пропускает только «известные» клиенты. Нужен User-Agent вида claude-cli/... — задаётся в providers.${s.id}.userAgent`
            : keyHint,
        },
      );
    }
    if (status === 402 || /insufficient|quota|balance|余额/i.test(msg)) {
      return new ProviderError('Закончились кредиты/квота у провайдера', {
        status, body: msg, retryable: false,
        hint: 'Проверь баланс в личном кабинете провайдера',
      });
    }
    if (status === 404) {
      return new ProviderError(`Модель или endpoint не найдены: ${msg}`, {
        status, body: msg, retryable: false,
        hint: 'Проверь имя модели через /model',
      });
    }
    if (status === 429) {
      return new ProviderError('Слишком много запросов (rate limit)', { status, body: msg, retryable: true });
    }
    if (status === 502 || status === 503 || status === 504) {
      return new ProviderError(`Провайдер временно недоступен (${status})`, {
        status, body: msg, retryable: true,
        hint: 'Бэкенд перегружен или на секунду лёг (частая история у роутеров вроде auto). Повтори запрос или выбери другую модель: /model',
      });
    }
    if (status >= 500) {
      return new ProviderError(`Ошибка на стороне провайдера (${status})`, { status, body: msg, retryable: true });
    }
    return new ProviderError(`Запрос отклонён (${status}): ${msg}`, { status, body: msg, retryable: false });
  }

  async *stream({ model, messages, tools, system, maxTokens, temperature, signal }) {
    const body = this.#body({ model, messages, tools, system, maxTokens, temperature });

    let res;
    let attempt = 0;
    const maxAttempts = 4;
    while (true) {
      try {
        res = await this.#fetch('/v1/chat/completions', { method: 'POST', body: JSON.stringify(body) }, { signal });
        break;
      } catch (e) {
        attempt++;
        if (!e.retryable || attempt >= maxAttempts || signal?.aborted) throw e;
        yield { type: 'retry', attempt, error: e.message };
        await sleep(Math.min(8000, 700 * 2 ** (attempt - 1)));
      }
    }

    yield* this.#streamOpenAI(res, signal);
  }

  #body({ model, messages, tools, system, maxTokens, temperature }) {
    const msgs = [];
    if (system) msgs.push({ role: 'system', content: system });
    msgs.push(...messages);

    const body = {
      model,
      messages: msgs,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (maxTokens) body.max_tokens = maxTokens;
    if (typeof temperature === 'number') body.temperature = temperature;
    if (tools?.length) {
      body.tools = tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }
    return body;
  }

  async *#streamOpenAI(res, signal) {
    let text = '';
    let reasoning = '';
    const toolCalls = [];
    let usage = null;
    let finishReason = null;

    for await (const { data } of parseSSE(res, signal)) {
      if (data?.usage) usage = data.usage;
      const choice = data?.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? {};

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const rDelta = delta.reasoning_content ?? delta.reasoning ?? null;
      if (rDelta) {
        reasoning += rDelta;
        yield { type: 'reasoning', delta: rDelta };
      }

      if (typeof delta.content === 'string' && delta.content) {
        text += delta.content;
        yield { type: 'text', delta: delta.content };
      } else if (Array.isArray(delta.content)) {
        for (const part of delta.content) {
          if (part?.type === 'text' && part.text) {
            text += part.text;
            yield { type: 'text', delta: part.text };
          }
        }
      }

      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        if (!toolCalls[i]) {
          toolCalls[i] = { id: tc.id ?? `call_${i}`, name: '', args: '' };
          if (tc.function?.name) {
            toolCalls[i].name = tc.function.name;
            yield { type: 'tool_start', index: i, id: toolCalls[i].id, name: tc.function.name };
          }
        } else if (tc.function?.name && !toolCalls[i].name) {
          toolCalls[i].name = tc.function.name;
          yield { type: 'tool_start', index: i, id: toolCalls[i].id, name: tc.function.name };
        }
        if (tc.id && !toolCalls[i].id.startsWith('call_')) toolCalls[i].id = tc.id;
        if (tc.function?.arguments) {
          toolCalls[i].args += tc.function.arguments;
          yield { type: 'tool_args', index: i, delta: tc.function.arguments };
        }
      }
    }

    const calls = toolCalls.filter(Boolean).map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.args,
    }));

    yield {
      type: 'done',
      finishReason: finishReason ?? (calls.length ? 'tool_calls' : 'stop'),
      message: buildAssistantMessage({ text, reasoning, calls }),
      usage: normalizeUsage(usage),
    };
  }

}

function buildAssistantMessage({ text, reasoning, calls }) {
  const msg = { role: 'assistant', content: text || '' };
  if (reasoning) msg.reasoning = reasoning;
  if (calls.length) {
    msg.tool_calls = calls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments || '{}' },
    }));
  }
  return msg;
}

function normalizeUsage(u) {
  if (!u) return null;
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  return {
    input,
    output,
    cacheRead: u.cache_read_input_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0,
    cacheWrite: u.cache_creation_input_tokens ?? 0,
    total: u.total_tokens ?? input + output,
  };
}

export function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) chars += JSON.stringify(m.content).length;
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 3.5);
}
