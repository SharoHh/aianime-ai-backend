import 'dotenv/config'
import express from 'express'

const PORT = Number(process.env.PORT || 8787)
const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini'
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite'

const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '300kb' }))

const GEMINI_COOLDOWN_MS = Math.min(Math.max(Number(process.env.GEMINI_429_COOLDOWN_MS || process.env.AI_BACKEND_429_COOLDOWN_MS || 10 * 60 * 1000), 60 * 1000), 30 * 60 * 1000)
const GEMINI_COOLDOWN = globalThis.__aianimeGeminiCooldown || { until: 0, status: null, reason: '' }
globalThis.__aianimeGeminiCooldown = GEMINI_COOLDOWN

function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': process.env.AI_ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Aianime-AI-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  }
}

function sendJson(res, status, payload){
  res.status(status)
  res.set({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    ...corsHeaders()
  })
  return status === 204 ? res.end() : res.json(payload)
}

function truncateText(value = '', limit = 260){
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if(text.length <= limit) return text
  return `${text.slice(0, limit - 1).trim()}…`
}


function normalizeReasonText(value = ''){
  return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/[^a-zа-я0-9]+/g, '')
}

function cleanBackendReason(reason = '', fallback = ''){
  const text = truncateText(reason || fallback || 'Подходит по настроению запроса и выглядит самым близким вариантом из каталога.', 220)
  const n = normalizeReasonText(text)
  if(!text || n.includes(normalizeReasonText('жанры:')) || n.includes(normalizeReasonText('подходит по жанрам')) || n.includes(normalizeReasonText('короткий формат')) || n.includes(normalizeReasonText('удобный формат'))){
    return truncateText(fallback || 'Подходит не по сухому жанру, а по общему вайбу запроса и ощущению от истории.', 220)
  }
  return text
}


function normalizeFranchiseText(value = ''){
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/g, ' ')
    .trim()
}

function compactFranchiseText(value = ''){
  return normalizeFranchiseText(value).replace(/\s+/g, '')
}

function backendFranchiseKey(item = {}){
  const blob = normalizeFranchiseText(`${item.slug || ''} ${item.title || ''} ${item.originalTitle || ''}`)
  const known = [
    ['aot', ['shingeki no kyojin', 'attack on titan', 'атака титанов']],
    ['tokyo-ghoul', ['tokyo ghoul', 'токийский гуль']],
    ['mushoku-tensei', ['mushoku tensei', 'реинкарнация безработного']],
    ['no-game-no-life', ['no game no life', 'нет игры', 'нет жизни']],
    ['re-zero', ['re zero', 're:zero', 'жизнь с нуля']],
    ['one-piece', ['one piece', 'ван пис', 'ван-пис']],
    ['naruto', ['naruto', 'наруто']],
    ['bleach', ['bleach', 'блич']],
    ['demon-slayer', ['kimetsu no yaiba', 'demon slayer', 'клинок']],
    ['steins-gate', ['steins gate', 'steins;gate', 'врата штейна']],
    ['chainsaw-man', ['chainsaw man', 'человек бензопила']],
    ['fullmetal-alchemist', ['fullmetal alchemist', 'стальной алхимик']]
  ]
  for(const [key, words] of known){
    if(words.some(word => blob.includes(normalizeFranchiseText(word)))) return key
  }
  return compactFranchiseText(`${item.title || item.originalTitle || item.slug || ''}`)
    .replace(/tv|ova|ona|movie|film|season|part|final|special|тв|ова|фильм|сезон|часть|финал|спецвыпуски|спешл|[0-9]/g, '')
    .slice(0, 80) || String(item.slug || '')
}

function diversifyBackendItems(items = [], limit = 12){
  const source = items.filter(item => item?.slug)
  const counts = new Map()
  const selected = []
  const used = new Set()

  const pushPass = (cap) => {
    for(const item of source){
      const slug = String(item.slug)
      if(used.has(slug)) continue
      const key = backendFranchiseKey(item)
      const current = counts.get(key) || 0
      if(current >= cap) continue
      counts.set(key, current + 1)
      selected.push(item)
      used.add(slug)
      if(selected.length >= limit) return
    }
  }

  // Keep Gemini's answer diverse before it even reaches the main site.
  // Broad mood prompts should not become a list of seasons from one franchise.
  pushPass(1)
  if(selected.length < limit) pushPass(2)

  const uniqueFranchises = new Set(source.map(backendFranchiseKey)).size
  if(selected.length < limit){
    pushPass(uniqueFranchises >= Math.min(5, limit) ? 2 : 4)
  }

  return selected.slice(0, limit)
}

function parseOpenAiText(data){
  if(data?.output_text) return String(data.output_text)
  const parts = []
  for(const item of data?.output || []){
    for(const content of item?.content || []){
      if(content?.type === 'output_text' && content?.text) parts.push(content.text)
      if(typeof content?.text === 'string') parts.push(content.text)
    }
  }
  return parts.join('\n').trim()
}

function parseGeminiText(data){
  const parts = []
  for(const candidate of data?.candidates || []){
    for(const part of candidate?.content?.parts || []){
      if(typeof part?.text === 'string') parts.push(part.text)
    }
  }
  return parts.join('\n').trim()
}

function parseJsonPayload(text){
  const raw = String(text || '').trim()
  if(!raw) return null
  try{ return JSON.parse(raw) }catch{}
  const match = raw.match(/\{[\s\S]*\}/)
  if(match){
    try{ return JSON.parse(match[0]) }catch{}
  }
  return null
}

function checkSecret(req){
  const expected = String(process.env.AI_BACKEND_SECRET || process.env.AI_RECOMMEND_SECRET || '').trim()
  if(!expected) return true
  const got = String(req.headers['x-aianime-ai-secret'] || '').trim()
  return Boolean(got && got === expected)
}

function configuredProvider(body = {}){
  const raw = String(body?.provider || process.env.AI_PROVIDER || process.env.AI_RECOMMEND_PROVIDER || '').trim().toLowerCase()
  if(['local','none','off','disabled','0'].includes(raw)) return 'local'
  if(['openai','gpt','chatgpt'].includes(raw)) return 'openai'
  if(['gemini','google','google-gemini','google_ai'].includes(raw)) return 'gemini'
  if(String(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '').trim()) return 'gemini'
  if(String(process.env.OPENAI_API_KEY || '').trim()) return 'openai'
  return 'local'
}

function modelFor(provider, body = {}){
  if(provider === 'gemini') return String(process.env.GEMINI_MODEL || process.env.GOOGLE_AI_MODEL || body?.model || DEFAULT_GEMINI_MODEL).trim()
  if(provider === 'openai') return String(process.env.OPENAI_MODEL || body?.model || DEFAULT_OPENAI_MODEL).trim()
  return null
}

function geminiModelPath(model){
  return String(model || DEFAULT_GEMINI_MODEL).trim().replace(/^models\//, '')
}

function buildPromptPayload(body){
  const rawCandidates = Array.isArray(body?.candidates) ? body.candidates : []
  const candidates = diversifyBackendItems(rawCandidates, Math.min(Math.max(Number(process.env.AI_BACKEND_CANDIDATE_LIMIT || 20), 8), 24))
  return {
    user_query: String(body?.user_query || body?.query || '').trim(),
    rules: Array.isArray(body?.rules) ? body.rules : [],
    user_library: body?.user_library && typeof body.user_library === 'object' ? body.user_library : {},
    candidates: candidates.map(item => ({
      slug: String(item?.slug || ''),
      title: String(item?.title || ''),
      originalTitle: item?.originalTitle || null,
      year: item?.year || null,
      episodes: item?.episodes || null,
      genres: Array.isArray(item?.genres) ? item.genres.slice(0, 3) : [],
      localScore: Number(item?.localScore || 0) || 0,
      localReason: truncateText(item?.localReason || '', 90),
    })).filter(item => item.slug)
  }
}

function localResults(promptPayload, limit = 12){
  return diversifyBackendItems(promptPayload.candidates
    .slice()
    .sort((a,b) => Number(b.localScore || 0) - Number(a.localScore || 0)), Math.min(Math.max(Number(limit || 12), 1), 12))
    .map(item => ({
      slug: item.slug,
      match: Math.min(96, Math.max(62, Math.round(68 + Number(item.localScore || 0) / 20))),
      reason: cleanBackendReason(item.localReason, 'Выбран как ближайший быстрый вариант по смыслу запроса, пока AI уточняет выдачу.')
    }))
}

function localPayload(promptPayload, body, reason, meta = {}){
  return {
    status: 200,
    payload: {
      ok:true,
      source:'external-local',
      model:null,
      summary: reason,
      results: localResults(promptPayload, body?.limit || 12),
      meta: { provider:'local', ...meta }
    }
  }
}

function systemPrompt(){
  return 'Ты живой аниме-куратор AIanime. Верни только JSON: {"summary":"...","results":[{"slug":"...","match":90,"reason":"..."}]}. Выбирай только из candidates, slug не придумывай. Сначала пойми человеческий смысл запроса: персонаж, настроение, похожий тайтл, ограничение. reason 14-28 слов, разный и убедительный. Для широких вайб-запросов не забивай выдачу сезонами одной франшизы: максимум 1-2 из одной серии, дальше разнообразь. Запрещены шаблоны: жанры:, подходит по жанрам, короткий формат, удобный формат.'
}

async function recommendGemini(promptPayload, body, model){
  const apiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_AI_API_KEY || '').trim()
  if(!apiKey) return localPayload(promptPayload, body, 'Gemini API key не задан на AI-backend, показан локальный запасной подбор.', { reason:'missing_gemini_api_key' })

  if(Date.now() < Number(GEMINI_COOLDOWN.until || 0)){
    return localPayload(promptPayload, body, 'Gemini временно на лимите, показан быстрый запасной подбор.', { provider:'gemini', ok:false, status:GEMINI_COOLDOWN.status || 429, error:GEMINI_COOLDOWN.reason || 'gemini_cooldown' })
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Math.min(Number(process.env.GEMINI_TIMEOUT_MS || process.env.AI_BACKEND_TIMEOUT_MS || 5500), 7000))

  try{
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiModelPath(model)}:generateContent?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt() }] },
        contents: [{ role:'user', parts:[{ text: JSON.stringify(promptPayload) }] }],
        generationConfig: {
          temperature: 0.18,
          topP: 0.75,
          maxOutputTokens: Math.min(Math.max(Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || process.env.AI_BACKEND_MAX_OUTPUT_TOKENS || 640), 300), 700),
          responseMimeType: 'application/json'
        }
      })
    })

    clearTimeout(timeout)

    if(!response.ok){
      const errorText = await response.text().catch(() => '')
      if(response.status === 429){
        GEMINI_COOLDOWN.until = Date.now() + GEMINI_COOLDOWN_MS
        GEMINI_COOLDOWN.status = 429
        GEMINI_COOLDOWN.reason = 'Gemini quota/rate limit cooldown'
      }
      return localPayload(promptPayload, body, 'Gemini сейчас на лимите, показан быстрый запасной подбор.', { provider:'gemini', ok:false, status:response.status, error:truncateText(errorText || response.statusText, 420) })
    }

    const data = await response.json().catch(() => null)
    const parsed = parseJsonPayload(parseGeminiText(data)) || { summary:'', results:[] }

    return {
      status: 200,
      payload: {
        ok:true,
        source:'external-gemini',
        model: data?.modelVersion || model,
        summary: truncateText(parsed.summary || 'Gemini подобрал тайтлы по смыслу запроса.', 220),
        results: Array.isArray(parsed.results) ? parsed.results.slice(0, 8) : [],
        meta: { provider:'gemini', ok:true, usage:data?.usageMetadata || null }
      }
    }
  }catch(error){
    clearTimeout(timeout)
    return localPayload(promptPayload, body, 'Gemini не ответил по таймауту/ошибке, показан локальный запасной подбор.', { provider:'gemini', ok:false, error:truncateText(error?.message || error, 420) })
  }
}

async function recommendOpenAI(promptPayload, body, model){
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  if(!apiKey) return localPayload(promptPayload, body, 'OpenAI API key не задан на AI-backend, показан локальный запасной подбор.', { reason:'missing_openai_api_key' })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TIMEOUT_MS || process.env.AI_BACKEND_TIMEOUT_MS || 12000))

  try{
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: Math.min(Math.max(Number(process.env.OPENAI_MAX_OUTPUT_TOKENS || process.env.AI_BACKEND_MAX_OUTPUT_TOKENS || 650), 300), 900),
        input: [
          { role: 'developer', content: [{ type: 'input_text', text: systemPrompt() }] },
          { role: 'user', content: [{ type:'input_text', text: JSON.stringify(promptPayload) }] }
        ],
        text: {
          format: {
            type: 'json_schema',
            name: 'aianime_recommendations',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              required: ['summary', 'results'],
              properties: {
                summary: { type: 'string' },
                results: {
                  type: 'array',
                  minItems: 0,
                  maxItems: 12,
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['slug', 'match', 'reason'],
                    properties: {
                      slug: { type: 'string' },
                      match: { type: 'number' },
                      reason: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      })
    })

    clearTimeout(timeout)

    if(!response.ok){
      const errorText = await response.text().catch(() => '')
      return localPayload(promptPayload, body, 'OpenAI сейчас не ответил, показан локальный запасной подбор.', { provider:'openai', ok:false, status:response.status, error:truncateText(errorText || response.statusText, 420) })
    }

    const data = await response.json().catch(() => null)
    const parsed = parseJsonPayload(parseOpenAiText(data)) || { summary:'', results:[] }

    return {
      status: 200,
      payload: {
        ok:true,
        source:'external-openai',
        model: data?.model || model,
        summary: truncateText(parsed.summary || 'OpenAI подобрал тайтлы по смыслу запроса.', 220),
        results: Array.isArray(parsed.results) ? parsed.results.slice(0, 8) : [],
        meta: { provider:'openai', ok:true, usage:data?.usage || null }
      }
    }
  }catch(error){
    clearTimeout(timeout)
    return localPayload(promptPayload, body, 'OpenAI не ответил по таймауту/ошибке, показан локальный запасной подбор.', { provider:'openai', ok:false, error:truncateText(error?.message || error, 420) })
  }
}

async function recommend(body){
  const promptPayload = buildPromptPayload(body)
  if(!promptPayload.user_query || !promptPayload.candidates.length){
    return { status: 400, payload: { ok:false, source:'external-local', model:null, error:'empty_query_or_candidates' } }
  }

  const provider = configuredProvider(body)
  const model = modelFor(provider, body)

  if(provider === 'gemini') return recommendGemini(promptPayload, body, model)
  if(provider === 'openai') return recommendOpenAI(promptPayload, body, model)
  return localPayload(promptPayload, body, 'AI-провайдер отключён, показан локальный запасной подбор.', { reason:'provider_local' })
}

app.options('*any', (req, res) => sendJson(res, 204, {}))

app.get('/', (req, res) => sendJson(res, 200, { ok:true, service:'aianime-ai-backend', routes:['/health','/recommend'] }))
app.get(['/health','/api/health'], (req, res) => sendJson(res, 200, {
  ok:true,
  service:'aianime-ai-backend',
  runtime: process.env.VERCEL ? 'vercel' : 'node',
  provider: configuredProvider({}),
  model: modelFor(configuredProvider({}), {})
}))

app.post(['/recommend','/api/recommend'], async (req, res) => {
  if(!checkSecret(req)) return sendJson(res, 401, { ok:false, error:'bad_ai_secret' })
  try{
    const result = await recommend(req.body || {})
    return sendJson(res, result.status, result.payload)
  }catch(error){
    return sendJson(res, 400, { ok:false, error:truncateText(error?.message || error, 240) })
  }
})

app.use((req, res) => sendJson(res, 404, { ok:false, error:'not_found' }))

if(!process.env.VERCEL){
  app.listen(PORT, () => {
    console.log(`AIanime AI backend listening on :${PORT}`)
  })
}

export default app
