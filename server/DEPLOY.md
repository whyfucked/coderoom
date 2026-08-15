# Деплой шлюза на VDS + домен `api.as201823.run` через anycast.ac

Схема: **клиент → `https://api.as201823.run` → anycast.ac (edge, TLS) → твой VDS `:8787` → апстримы.**

Шлюз слушает `0.0.0.0:8787`, TLS выдаёт anycast.ac на своём edge (Let's Encrypt).

---

## 1. Залить и поднять сервис

С локальной машины (из корня проекта):

```bash
scp -r server root@VDS_IP:/tmp/coderoom-server
ssh root@VDS_IP 'bash /tmp/coderoom-server/deploy/install.sh'
```

Скрипт: ставит Node 22, заводит пользователя `coderoom`, кладёт код в `/opt/coderoom/server`,
включает systemd-сервис `coderoom-gateway`, открывает порт в ufw и проверяет `/health`.

Проверка снаружи (с любой машины):

```bash
curl http://VDS_IP:8787/health
# {"ok":true,"service":"coderoom-gateway"}
```

## 2. Настроить `.env` на сервере

```bash
ssh root@VDS_IP
nano /opt/coderoom/server/.env
```

Обязательно:

```
AGENTROUTER_API_KEY=sk-...
HCNSEC_API_KEY=sk-...
NVIDIA_API_KEY=nvapi-...

CODEROOM_GATEWAY_HOST=0.0.0.0
CODEROOM_GATEWAY_PORT=8787
CODEROOM_PUBLIC_URL=https://api.as201823.run

# длинный случайный — /admin будет доступен из интернета
GATEWAY_ADMIN_TOKEN=<48+ случайных символов>
```

Сгенерировать токен: `openssl rand -hex 32`. Затем `systemctl restart coderoom-gateway`.

## 3. DNS у регистратора домена `as201823.run`

Добавь **CNAME**:

```
api   CNAME   cname.anycast.ac
```

(anycast.ac — не регистратор и не DNS-хостинг, только защита трафика; запись создаётся там,
где обслуживается домен.)

## 4. Панель anycast.ac

Создай сайт:

- **Domain:** `api.as201823.run`
- **Origin URL:** `http://VDS_IP:8787`
- TLS — режим ACME/Let's Encrypt (по умолчанию), выпуск занимает 30–90 секунд после DNS.

Проверка:

```bash
curl https://api.as201823.run/health
```

## 5. Ключ клиенту

На сервере:

```bash
sudo -u coderoom node /opt/coderoom/server/keys.mjs new --label "мой ноут"
```

На своей машине — в клиенте провайдер `coderoom` уже смотрит на `https://api.as201823.run`,
остаётся вставить ключ:

```bash
coderoom        # мастер спросит URL (Enter — по умолчанию) и ключ cr-…
# или:
set CODEROOM_KEY=cr-...
```

---

## Что проверить после подключения

**Стриминг.** Ответы моделей идут по SSE. Прокси, которые буферизуют ответ, ломают стрим —
у anycast.ac это в доках не описано, поэтому проверь:

```bash
curl -N -X POST https://api.as201823.run/v1/chat/completions \
  -H "Authorization: Bearer cr-ТВОЙ_КЛЮЧ" -H "Content-Type: application/json" \
  -d '{"model":"nvidia/nemotron-3-nano-30b-a3b","stream":true,"messages":[{"role":"user","content":"считай до 20"}]}'
```

Токены должны идти **порциями**, а не вывалиться одним куском в конце. Если валятся одним
куском — стрим буферизуется на edge; тогда либо отключи проксирование для этого хоста,
либо заведи второй поддомен с A-записью прямо на VDS и ходи через него.

**Таймауты.** Длинные ответы (Opus, nemotron-ultra) могут идти минутами. Если рвётся —
смотри лимиты в панели anycast.ac.

---

## Безопасность

- Порт 8787 открыт в интернет, поэтому origin можно найти в обход защиты. Доступ к `/v1/*`
  всё равно только по ключу `cr-…`, к `/admin` — по `GATEWAY_ADMIN_TOKEN`. **Токен обязателен.**
- Список edge-IP anycast.ac не публикует, поэтому «пустить только их» через ufw не выйдет.
  Если нужно жёстче — смени порт на нестандартный и укажи его в Origin URL.
- Ключи апстримов лежат только в `/opt/coderoom/server/.env` (права 600, владелец `coderoom`).
  Клиент их не видит никогда.
- База `data/coderoom.db` (права 700) — ключи `cr-…` и учёт токенов.

## Обслуживание

```bash
journalctl -u coderoom-gateway -f                 # логи
systemctl restart coderoom-gateway                # рестарт
sudo -u coderoom node /opt/coderoom/server/keys.mjs ls      # ключи
sudo -u coderoom node /opt/coderoom/server/keys.mjs stats   # расход по моделям
sudo -u coderoom node /opt/coderoom/server/keys.mjs rm <id> # отозвать ключ
```

Обновление кода — повторить шаг 1 (`.env` и `data/` скрипт не трогает).
