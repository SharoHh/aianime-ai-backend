# AIanime AI backend for Vercel

Upload these files to the root of the separate Vercel repository:

- `package.json`
- `vercel.json`
- `api/health.js`
- `api/recommend.js`

Vercel environment variables:

```env
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-5.5
AI_BACKEND_SECRET=Aianime_ai_backend_secret_2026
OPENAI_TIMEOUT_MS=30000
```

Check after deploy:

```bash
curl https://YOUR-VERCEL-DOMAIN/api/health
curl -X POST https://YOUR-VERCEL-DOMAIN/api/recommend \
  -H "Content-Type: application/json" \
  -H "X-Aianime-AI-Secret: Aianime_ai_backend_secret_2026" \
  -d '{"query":"лёгкое романтическое аниме про школу","limit":8,"candidates":[{"slug":"kaguya","title":"Кагуя","genres":["Комедия","Романтика","Школа"]}]}'
```
