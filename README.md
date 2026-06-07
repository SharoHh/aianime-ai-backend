# AIanime AI backend

Отдельный backend для AI-подбора. Его можно держать на отдельном AI-VPS, чтобы ключи AI не лежали на основном сайте.

В этой версии основной дешёвый провайдер — Gemini. OpenAI оставлен только как legacy-вариант, если ты сам его включишь.

## Routes

- `GET /health` — проверка, что backend живой, какой provider/model активен.
- `POST /recommend` — подбор аниме из списка `candidates`.

Если Gemini/OpenAI не отвечает или ключ не задан, backend не валит сайт: он возвращает `external-local` — локальный запасной подбор по уже переданным кандидатам.

## Важно про `.env`

В этой версии backend сам читает файл `.env` через `dotenv`, поэтому можно спокойно создать `/var/www/aianime-ai-backend/.env` и запускать через PM2.

## Environment variables на AI-VPS

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash-lite
AI_BACKEND_SECRET=Aianime_ai_backend_secret_2026
AI_BACKEND_TIMEOUT_MS=12000
PORT=8787
```

Legacy OpenAI включать только осознанно:

```env
AI_PROVIDER=openai
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-4.1-mini
AI_BACKEND_SECRET=Aianime_ai_backend_secret_2026
```

## Запуск на AI-VPS

```bash
cd /var/www/aianime-ai-backend
npm install --registry=https://registry.npmjs.org/
npm run start
```

Через PM2:

```bash
cd /var/www/aianime-ai-backend
pm2 start server.js --name aianime-ai
pm2 save
```

Проверка:

```bash
curl -s http://127.0.0.1:8787/health
```

## Настройки на основном AIanime VPS

В `.env.production` основного сайта:

```env
AI_PROVIDER=gemini
AI_RECOMMEND_ENDPOINT=http://IP_ИЛИ_ДОМЕН_AI_VPS:8787/recommend
AI_RECOMMEND_SECRET=Aianime_ai_backend_secret_2026
AI_RECOMMEND_TIMEOUT_MS=8000
AI_RECOMMEND_CACHE_TTL_MS=21600000
```

Если хочешь держать Gemini прямо на основном сайте без отдельного backend:

```env
AI_PROVIDER=gemini
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-2.5-flash-lite
AI_RECOMMEND_TIMEOUT_MS=8000
```

## Vercel fallback routes

Если деплоишь backend на Vercel и `/recommend` возвращает 404, используй native route:

```env
AI_RECOMMEND_ENDPOINT=https://YOUR-VERCEL-DOMAIN.vercel.app/api/recommend
```
