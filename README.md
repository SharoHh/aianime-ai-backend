# AIanime AI backend

Отдельный backend для AI-подбора. Можно запускать локально/на Render как обычный Node-сервер или деплоить на Vercel как Express backend.

## Routes

- `GET /health` — проверка, что backend живой.
- `POST /recommend` — подбор аниме через OpenAI из списка candidates.

## Environment variables

```env
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5.5
AI_BACKEND_SECRET=Aianime_ai_backend_secret_2026
OPENAI_TIMEOUT_MS=30000
```

## Vercel

В отдельный GitHub repo загрузи содержимое этой папки так, чтобы в корне repo были:

```text
package.json
server.js
README.md
```

Vercel → New Project → Import repo.

Settings:

```text
Framework Preset: Other
Build Command: npm install
Output Directory: пусто
Install Command: npm install
```

Environment Variables в Vercel:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
AI_BACKEND_SECRET=Aianime_ai_backend_secret_2026
OPENAI_TIMEOUT_MS=30000
```

После деплоя проверь:

```bash
curl -s https://YOUR-VERCEL-DOMAIN.vercel.app/health
```

На основном сайте AIanime в `.env.local`:

```env
AI_RECOMMEND_ENDPOINT=https://YOUR-VERCEL-DOMAIN.vercel.app/recommend
AI_RECOMMEND_SECRET=Aianime_ai_backend_secret_2026
AI_RECOMMEND_TIMEOUT_MS=45000
```


## Vercel fallback routes

If `/health` or `/recommend` returns 404, test native Vercel routes:

```bash
curl -s https://YOUR-VERCEL-DOMAIN.vercel.app/api/health
```

For the main AIanime site you can use the native endpoint:

```env
AI_RECOMMEND_ENDPOINT=https://YOUR-VERCEL-DOMAIN.vercel.app/api/recommend
```
