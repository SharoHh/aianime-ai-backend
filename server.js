const PORT = Number(process.env.PORT || 8787)
const DEFAULT_MODEL = 'gpt-4.1-mini'

function sendJson(res, status, payload){
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Access-Control-Allow-Origin': process.env.AI_ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Aianime-AI-Secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  })
  res.end(body)
}

function truncateText(value = '', limit = 260){
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

async function readBody(req){
  const chunks = []
  for await (const chunk of req){
    chunks.push(chunk)
    if(Buffer.concat(chunks).length > 800_000){
      throw new Error('request_body_too_large')
    }
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function checkSecret(req){
  const expected = String(process.env.AI_BACKEND_SECRET || process.env.AI_RECOMMEND_SECRET || '').trim()
  if(!expected) return true
  const got = String(req.headers['x-aianime-ai-secret'] || '').trim()
  return got && got === expected
}

function buildPromptPayload(body){
  const candidates = Array.isArray(body?.candidates) ? body.candidates.slice(0, 90) : []
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
      status: item?.status || null,
      kind: item?.kind || null,
      genres: Array.isArray(item?.genres) ? item.genres.slice(0, 8) : [],
      studio: item?.studio || null,
      rating: item?.rating || null,
      localScore: item?.localScore || null,
      localReason: item?.localReason || '',
      description: item?.description || ''
    })).filter(item => item.slug)
  }
}

async function recommend(body){
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim()
  const model = String(process.env.OPENAI_MODEL || body?.model || DEFAULT_MODEL).trim()
  if(!apiKey){
    return {
      status: 500,
      payload: {
        ok:false,
        source:'external-openai',
        model,
        error:'missing_openai_api_key'
      }
    }
  }

  const promptPayload = buildPromptPayload(body)
  if(!promptPayload.user_query || !promptPayload.candidates.length){
    return {
      status: 400,
      payload: { ok:false, source:'external-openai', model, error:'empty_query_or_candidates' }
    }
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), Number(process.env.OPENAI_TIMEOUT_MS || 18000))

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
        max_output_tokens: 1700,
        input: [
          {
            role: 'developer',
            content: [{
              type: 'input_text',
              text: 'Ты умный рекомендатель аниме для AIanime. Верни строго JSON. Выбирай только из candidates. Нужно 8-12 тайтлов, если кандидатов достаточно. Учитывай смысл, жанры, вайб, отрицания и библиотеку пользователя. Не придумывай slug. reason пиши коротко по-русски.'
            }]
          },
          {
            role: 'user',
            content: [{ type:'input_text', text: JSON.stringify(promptPayload) }]
          }
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
      return {
        status: response.status,
        payload: {
          ok:false,
          source:'external-openai',
          model,
          error: truncateText(errorText || response.statusText, 360)
        }
      }
    }

    const data = await response.json().catch(() => null)
    const parsed = parseJsonPayload(parseOpenAiText(data)) || { summary:'', results:[] }

    return {
      status: 200,
      payload: {
        ok:true,
        source:'external-openai',
        model: data?.model || model,
        summary: truncateText(parsed.summary || 'AI подобрал тайтлы по смыслу запроса.', 220),
        results: Array.isArray(parsed.results) ? parsed.results.slice(0, 12) : [],
        openai: { ok:true, usage:data?.usage || null }
      }
    }
  }catch(error){
    clearTimeout(timeout)
    return {
      status: 500,
      payload: {
        ok:false,
        source:'external-openai',
        model,
        error: truncateText(error?.message || error, 300)
      }
    }
  }
}

const server = (await import('node:http')).createServer(async (req, res) => {
  if(req.method === 'OPTIONS'){
    return sendJson(res, 204, {})
  }

  if(req.url === '/health'){
    return sendJson(res, 200, { ok:true, service:'aianime-ai-backend' })
  }

  if(req.url !== '/recommend' || req.method !== 'POST'){
    return sendJson(res, 404, { ok:false, error:'not_found' })
  }

  if(!checkSecret(req)){
    return sendJson(res, 401, { ok:false, error:'bad_ai_secret' })
  }

  try{
    const body = await readBody(req)
    const result = await recommend(body)
    return sendJson(res, result.status, result.payload)
  }catch(error){
    return sendJson(res, 400, { ok:false, error:truncateText(error?.message || error, 240) })
  }
})

server.listen(PORT, () => {
  console.log(`AIanime AI backend listening on :${PORT}`)
})
