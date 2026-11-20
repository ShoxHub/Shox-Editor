/**
 * Shoxy Editor — Vercel Serverless Function
 * POST /api/ai
 *
 * Keys nur aus der Umgebung, nie aus dem Browser:
 *   OPENROUTER_API_KEY
 *   GEMINI_API_KEY
 * Optional: GEMINI_MODEL (Fallback, wenn das gewünschte Modell kein Gemini-Modell ist)
 *
 * Antwort ist OpenRouter-förmig (choices[0].message.content / finish_reason),
 * damit der bestehende KI-Tab, Parser und die Editor-Befehle unverändert bleiben.
 * Bei einem Limit oder Fehler des ersten Anbieters wird der andere versucht.
 */
export const maxDuration = 120;

export const config = {
  maxDuration: 120,
  api: { bodyParser: { sizeLimit: '8mb' } }
};

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';
const BUDGET_MS = 110000;

function errMessage(json, status) {
  const e = json && json.error;
  if (!e) return 'HTTP ' + status;
  if (typeof e === 'string') return e;
  if (typeof e.message === 'string') return e.message;
  try { return JSON.stringify(e); } catch (_) { return 'HTTP ' + status; }
}

function geminiModelId(orModel) {
  const raw = String(orModel || '').trim();
  const env = String(process.env.GEMINI_MODEL || '').trim();
  if (raw.startsWith('google/')) return raw.slice('google/'.length);
  if (/^gemini/i.test(raw)) return raw;
  return env || 'gemini-3.7-flash';
}

function dataUrlToInline(url) {
  const m = String(url || '').match(/^data:([^;,]+);base64,([\s\S]+)$/);
  if (!m) return null;
  return { mimeType: m[1], data: m[2] };
}

export function toGeminiBody(payload) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const system = [];
  const contents = [];
  for (const msg of messages) {
    const role = msg && (msg.role === 'assistant' || msg.role === 'model')
      ? 'model'
      : msg && msg.role === 'system' ? 'system' : 'user';
    const parts = [];
    const c = msg && msg.content;
    if (typeof c === 'string') {
      if (c) parts.push({ text: c });
    } else if (Array.isArray(c)) {
      for (const p of c) {
        if (!p) continue;
        if (p.type === 'text' && p.text) parts.push({ text: String(p.text) });
        else if (p.type === 'image_url') {
          const url = p.image_url && (typeof p.image_url === 'string' ? p.image_url : p.image_url.url);
          const inl = dataUrlToInline(url);
          if (inl) parts.push({ inlineData: inl });
        } else if (p.text) parts.push({ text: String(p.text) });
      }
    }
    if (!parts.length) continue;
    if (role === 'system') { system.push(...parts); continue; }
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  }
  if (contents.length && contents[0].role !== 'user') {
    contents.unshift({ role: 'user', parts: [{ text: '(Kontext)' }] });
  }
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: '' }] });
  const generationConfig = {};
  if (payload.temperature != null && payload.temperature !== '') generationConfig.temperature = Number(payload.temperature);
  if (payload.max_tokens != null && payload.max_tokens !== '') generationConfig.maxOutputTokens = Number(payload.max_tokens);
  if (payload.response_format && payload.response_format.type === 'json_object') generationConfig.responseMimeType = 'application/json';
  const body = { contents };
  if (system.length) body.systemInstruction = { parts: system };
  if (Object.keys(generationConfig).length) body.generationConfig = generationConfig;
  return body;
}

export function geminiToOpenRouter(json, model) {
  const cand = json && json.candidates && json.candidates[0];
  const parts = (cand && cand.content && cand.content.parts) || [];
  const text = parts.filter(p => p && p.text && !p.thought).map(p => p.text).join('');
  const reasoning = parts.filter(p => p && p.thought && p.text).map(p => p.text).join('\n');
  const finishMap = { STOP: 'stop', MAX_TOKENS: 'length', SAFETY: 'content_filter', RECITATION: 'content_filter', BLOCKLIST: 'content_filter', PROHIBITED_CONTENT: 'content_filter', SPII: 'content_filter', OTHER: 'stop' };
  const message = { content: text };
  if (reasoning) message.reasoning = reasoning;
  return {
    model: model,
    provider: 'gemini',
    choices: [{ index: 0, message, finish_reason: finishMap[cand && cand.finishReason] || 'stop' }]
  };
}

function openRouterPayload(payload) {
  const body = {
    model: payload.model,
    messages: payload.messages
  };
  if (payload.temperature != null && payload.temperature !== '') body.temperature = payload.temperature;
  if (payload.max_tokens != null && payload.max_tokens !== '') body.max_tokens = payload.max_tokens;
  if (payload.response_format) body.response_format = payload.response_format;
  return body;
}

async function postJson(url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    const raw = await r.text();
    let json = {};
    try { json = raw ? JSON.parse(raw) : {}; }
    catch (_) { json = { error: { message: (raw || ('HTTP ' + r.status)).slice(0, 600) } }; }
    return { ok: r.ok, status: r.status, json };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    return {
      ok: false,
      status: aborted ? 504 : 502,
      json: { error: { message: aborted ? 'Zeitüberschreitung beim Anbieter' : ('Netzwerkfehler zum Anbieter: ' + (e && e.message || e)) } }
    };
  } finally {
    clearTimeout(timer);
  }
}

function hasText(json) {
  const m = json && json.choices && json.choices[0] && json.choices[0].message;
  if (!m) return false;
  const c = m.content;
  if (typeof c === 'string' && c.trim()) return true;
  if (Array.isArray(c) && c.some(p => p && (p.text || p.content))) return true;
  if (m.reasoning && String(m.reasoning).includes('{')) return true;
  return false;
}

async function callOpenRouter(payload, key, timeoutMs) {
  return postJson(OPENROUTER_URL, {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer ' + key,
    'HTTP-Referer': 'https://shoxy.editor',
    'X-Title': 'Shoxy Editor'
  }, openRouterPayload(payload), timeoutMs);
}

async function callGemini(payload, key, timeoutMs) {
  const model = geminiModelId(payload.model);
  const url = GEMINI_BASE + encodeURIComponent(model) + ':generateContent';
  const res = await postJson(url, {
    'Content-Type': 'application/json',
    'x-goog-api-key': key
  }, toGeminiBody(payload), timeoutMs);
  if (!res.ok) return res;
  const block = res.json && res.json.promptFeedback && res.json.promptFeedback.blockReason;
  if (block && !(res.json.candidates && res.json.candidates.length)) {
    return { ok: false, status: 400, json: { error: { message: 'Gemini hat die Anfrage blockiert: ' + block } } };
  }
  const shaped = geminiToOpenRouter(res.json, model);
  if (!hasText(shaped)) {
    const why = (res.json && res.json.candidates && res.json.candidates[0] && res.json.candidates[0].finishReason) || 'leer';
    return { ok: false, status: 502, json: { error: { message: 'Leere Antwort von Gemini (' + why + ')' } } };
  }
  return { ok: true, status: 200, json: shaped };
}

export async function runAi(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { status: 400, body: { error: { message: 'Anfrage muss ein JSON-Objekt sein.' } } };
  }
  if (!Array.isArray(payload.messages) || !payload.messages.length) {
    return { status: 400, body: { error: { message: 'messages fehlt. Der KI-Tab muss das bisherige Chat-Format senden.' } } };
  }
  const orKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  const gemKey = String(process.env.GEMINI_API_KEY || '').trim();
  if (!orKey && !gemKey) {
    return { status: 500, body: { error: { message: 'Server ist nicht konfiguriert: OPENROUTER_API_KEY oder GEMINI_API_KEY fehlt.' } } };
  }

  const started = Date.now();
  const left = () => Math.max(8000, BUDGET_MS - (Date.now() - started));
  const failures = [];

  if (orKey) {
    const res = await callOpenRouter(payload, orKey, Math.min(90000, left()));
    if (res.ok && hasText(res.json)) {
      return { status: 200, body: res.json };
    }
    failures.push('OpenRouter: ' + errMessage(res.json, res.status));
  }

  if (gemKey && left() > 7000) {
    const res = await callGemini(payload, gemKey, Math.min(90000, left()));
    if (res.ok && hasText(res.json)) {
      return { status: 200, body: res.json };
    }
    failures.push('Gemini: ' + errMessage(res.json, res.status));
  }

  const message = failures.length
    ? ('Kein Anbieter hat geantwortet. ' + failures.join(' | '))
    : 'Kein Anbieter hat geantwortet.';
  const status = /429|quota|rate|Limit/i.test(message) ? 429 : /nicht konfiguriert|API key|unauthorized|401/i.test(message) ? 401 : 502;
  return { status, body: { error: { message } } };
}

async function readNodeBody(req) {
  if (req.body != null && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body || '{}');
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(req.body)) return JSON.parse(req.body.toString('utf8') || '{}');
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof Buffer !== 'undefined' ? Buffer.from(chunk) : chunk);
  const raw = typeof Buffer !== 'undefined' ? Buffer.concat(chunks).toString('utf8') : chunks.join('');
  return raw ? JSON.parse(raw) : {};
}

export default async function handler(req, res) {
  const web = !res || typeof res.status !== 'function';
  try {
    const method = req && req.method;
    if (method && method !== 'POST') {
      const body = { error: { message: 'Nur POST ist erlaubt.' } };
      if (web) return Response.json(body, { status: 405 });
      res.status(405).json(body);
      return;
    }
    let payload;
    try {
      payload = web ? await req.json() : await readNodeBody(req);
    } catch (_) {
      const body = { error: { message: 'Anfrage ist kein gültiges JSON.' } };
      if (web) return Response.json(body, { status: 400 });
      res.status(400).json(body);
      return;
    }
    if (payload && typeof payload === 'object') {
      delete payload.apiKey;
      delete payload.api_key;
      delete payload.authorization;
      delete payload.key;
    }
    const out = await runAi(payload);
    if (web) return Response.json(out.body, { status: out.status });
    res.status(out.status).json(out.body);
  } catch (e) {
    const body = { error: { message: 'Serverfehler: ' + (e && e.message || e) } };
    if (web) return Response.json(body, { status: 500 });
    try { res.status(500).json(body); } catch (_) {}
  }
    }
