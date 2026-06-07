# AIanime external AI backend

Небольшой Node.js backend для AI-подбора на сервере в поддерживаемом OpenAI регионе.
Основной сайт может оставаться на текущем VPS, а запросы `/api/ai/recommend` будут ходить сюда через `AI_RECOMMEND_ENDPOINT`.

## Env на AI backend сервере

```env
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL=gpt-5.5
AI_BACKEND_SECRET=long_random_secret
PORT=8787
```

## Запуск

```bash
npm install
npm start
```

Проверка:

```bash
curl http://127.0.0.1:8787/health
```

## Env на основном сайте

```env
AI_RECOMMEND_ENDPOINT=https://your-ai-backend.example.com/recommend
AI_RECOMMEND_SECRET=long_random_secret
```

`AI_RECOMMEND_SECRET` должен совпадать с `AI_BACKEND_SECRET` на AI backend сервере.
