function corsHeaders(){
  return {
    'Access-Control-Allow-Origin': process.env.AI_ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Aianime-AI-Secret',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  }
}

function sendJson(res, status, payload){
  for(const [key, value] of Object.entries({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    ...corsHeaders()
  })) res.setHeader(key, value)
  return res.status(status).json(payload)
}

function truncateText(value = '', limit = 520){
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if(text.length <= limit) return text
  return `${text.slice(0, limit - 1).trim()}…`
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

async function readJson(req){
  if(req.body && typeof req.body === 'object') return req.body
  if(typeof req.body === 'string'){
    try{ return JSON.parse(req.body) }catch{ return {} }
  }
  const chunks = []
  for await (const chunk of req) chunks.push(Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  if(!raw.trim()) return {}
  try{ return JSON.parse(raw) }catch{ return {} }
}

function checkSecret(req){
  const expected = String(process.env.AI_BACKEND_SECRET || process.env.AI_RECOMMEND_SECRET || '').trim()
  if(!expected) return true
  const got = String(req.headers['x-aianime-ai-secret'] || req.headers['X-Aianime-AI-Secret'] || '').trim()
  return Boolean(got && got === expected)
}

function buildPromptPayload(body){
  const candidates = Array.isArray(body?.candidates) ? body.candidates.slice(0, 120) : []
  return {
    user_query: String(body?.user_query || body?.query || '').trim(),
    limit: Math.max(1, Math.min(12, Number(body?.limit || 8))),
    rules: Array.isArray(body?.rules) ? body.rules : [],
    user_library: body?.user_library && typeof body.user_library === 'object' ? body.user_library : {},
    candidates: candidates.map(item => ({
      slug: String(item?.slug || ''),
      title: String(item?.title || ''),
      originalTitle: item?.originalTitle || null,
      year: item?.year || null,
      episodes: item?.episodes || null,
      status: item?.status || null,
      kind: item?.kind || null,
      genres: Array.isArray(item?.genres) ? item.genres.slice(0, 10) : [],
      studio: item?.studio || null,
      rating: item?.rating || null,
      localScore: item?.localScore || item?.match || null,
      localReason: item?.localReason || item?.reason || '',
      description: item?.description || ''
    })).filter(item => item.slug)
  }
}

async function callOpenAI(body){
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  const model = String(process.env.OPENAI_MODEL || body?.model || 'gpt-5.5').trim()
  if(!apiKey) return { status:500, payload:{ ok:false, source:'external-openai', model, error:'missing_openai_api_key' } }

  const promptPayload = buildPromptPayload(body)
  if(!promptPayload.user_query || !promptPayload.candidates.length){
    return { status:400, payload:{ ok:false, source:'external-openai', model, error:'empty_query_or_candidates' } }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TIMEOUT_MS || 30000))

  try{
    const response = await fetch('https://api.openai.com/v1/responses', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 1800,
        input: [
          { role: 'developer', content: [{ type: 'input_text', text: 'Ты умный рекомендатель аниме для AIanime. Верни строго JSON. Выбирай только из candidates. Если кандидатов достаточно, верни 8-12 разных тайтлов. Учитывай смысл запроса, жанры, вайб, отрицания и библиотеку пользователя. Не придумывай slug. reason пиши коротко по-русски.' }] },
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
      return { status: response.status, payload:{ ok:false, source:'external-openai', model, error: truncateText(errorText || response.statusText, 700) } }
    }

    const data = await response.json().catch(() => null)
    const parsed = parseJsonPayload(parseOpenAiText(data)) || { summary:'', results:[] }
    return {
      status: 200,
      payload: {
        ok:true,
        source:'external-openai',
        model: data?.model || model,
        summary: truncateText(parsed.summary || 'AI подобрал тайтлы по смыслу запроса.', 240),
        results: Array.isArray(parsed.results) ? parsed.results.slice(0, 12) : [],
        openai: { ok:true, usage:data?.usage || null }
      }
    }
  }catch(error){
    clearTimeout(timeout)
    return { status:500, payload:{ ok:false, source:'external-openai', model, error: truncateText(error?.message || error, 700) } }
  }
}

export default async function handler(req, res){
  if(req.method === 'OPTIONS') return sendJson(res, 204, {})
  if(req.method === 'GET') return sendJson(res, 200, { ok:true, service:'aianime-ai-backend', route:'/api/recommend', method:'POST' })
  if(req.method !== 'POST') return sendJson(res, 405, { ok:false, error:'method_not_allowed' })
  if(!checkSecret(req)) return sendJson(res, 401, { ok:false, error:'bad_ai_secret' })
  const body = await readJson(req)
  const result = await callOpenAI(body)
  return sendJson(res, result.status, result.payload)
}
