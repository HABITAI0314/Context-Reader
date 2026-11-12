// 轻量 AI 接口核心：校验个人访问口令后，把选中内容和少量上下文转发给模型。
// 只用 Web 标准 API（Request / Response / fetch / crypto.subtle），
// Node 服务（server/api.mjs）和 Cloudflare Pages Functions（functions/api）共用这一份。
// 模型地址、名称、API Key 只从服务端环境变量读取。
import { handleSync } from './sync.mjs';

const MAX_TEXT = 2000;
const MAX_CONTEXT = 1500;
const MAX_BODY = 16 * 1024;

// 模型常在字符串里直接写 "Race you!" 这样的英文双引号，导致整段 JSON 无效
const QUOTE_RULE = '字符串里如果要引用英文原文，请用「」括起来，不要使用英文双引号。\n';

const PROMPTS = {
  translate:
    '你是英语阅读助手。把用户选中的英文译成自然、准确的简体中文。' +
    '如果选中的是单个单词或短语，给出它在上下文中的含义，必要时附词性和一个常见的其他义项，不超过两行。' +
    '只输出译文本身，不要解释，不要加引号。',
  explain:
    '你是面向中文读者的英语阅读讲解助手。针对用户选中的英文（单词、短语或句子），结合上下文给出简短讲解。' +
    '只输出一个 JSON 对象，不要 Markdown 代码块，字段如下：\n' +
    'meaning：用一两句中文说明它在此处的意思（讲清楚含义、语气或言外之意，而不是逐字翻译）；\n' +
    'phrases：数组，最多 4 项，每项为 {"en": 原文短语, "zh": 此处含义}，列出关键短语、搭配或生词，没有则为空数组；\n' +
    'grammar：仅在语法结构影响理解时，用一两句中文点明（如从句、倒装、省略、虚拟语气），否则为空字符串；\n' +
    'translation：完整通顺的中文译文。\n' +
    QUOTE_RULE +
    '整体保持简短。',
  // 选中的是单词或很短的短语时用这一条：多给音标和词性
  explainWord:
    '你是面向中文读者的英语阅读讲解助手。用户选中了一个英文单词或短语，请结合上下文给出简短讲解。' +
    '只输出一个 JSON 对象，不要 Markdown 代码块，字段如下：\n' +
    'phonetic：美式音标，写在两条斜线之间，例如 /ˈwɪspər/；短语可以为空字符串；\n' +
    'pos：它在此处的词性，用中文缩写，例如 名词、动词、形容词、短语动词；\n' +
    'meaning：用一句中文说明它在这句话里的意思；如果原文是变形（过去式、复数等），顺带写出原形；\n' +
    'phrases：数组，最多 3 项，每项为 {"en": 常见搭配或例子, "zh": 中文意思}，没有合适的则为空数组；\n' +
    'grammar：空字符串；\n' +
    'translation：它所在那一句话的中文译文，没有上下文则为空字符串。\n' +
    QUOTE_RULE +
    '整体保持简短。',
};

const isTerm = (text) => text.length <= 40 && /^[A-Za-z][A-Za-z'’-]*(\s+[A-Za-z'’-]+){0,3}$/.test(text);

function userMessage(text, context) {
  let msg = `选中内容：\n${text}`;
  if (context) msg += `\n\n所在上下文（仅用于理解，不要翻译或讲解上下文）：\n${context}`;
  return msg;
}

/** 先各自做 SHA-256 再逐字节比较，耗时与内容无关 */
async function sameToken(a, b) {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(a)),
    crypto.subtle.digest('SHA-256', enc.encode(b)),
  ]);
  const x = new Uint8Array(ha), y = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

const FIELDS = ['phonetic', 'pos', 'meaning', 'phrases', 'grammar', 'translation'];

/** JSON 不合法时（通常是字符串里有未转义的引号），按字段名逐个把值抠出来 */
export function salvage(raw) {
  const spots = FIELDS.map((k) => ({ k, i: raw.search(new RegExp(`"${k}"\\s*:`)) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i);
  const obj = {};
  spots.forEach(({ k, i }, n) => {
    const end = n + 1 < spots.length ? spots[n + 1].i : raw.lastIndexOf('}');
    const v = raw.slice(raw.indexOf(':', i) + 1, end).trim().replace(/,$/, '').trim();
    if (k === 'phrases') {
      obj.phrases = [...v.matchAll(/"en"\s*:\s*"([\s\S]*?)"\s*,\s*"zh"\s*:\s*"([\s\S]*?)"\s*}/g)].map((m) => ({ en: m[1], zh: m[2] }));
    } else {
      obj[k] = v.replace(/^"/, '').replace(/"$/, '').replace(/\\"/g, '"');
    }
  });
  if (!obj.meaning && !obj.translation) throw new Error('无法解析');
  return obj;
}

export function parseExplanation(raw) {
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    let obj;
    try {
      obj = JSON.parse(raw.slice(start, end + 1));
    } catch {
      obj = salvage(raw.slice(start, end + 1));
    }
    return {
      phonetic: str(obj.phonetic),
      pos: str(obj.pos),
      meaning: str(obj.meaning),
      phrases: (Array.isArray(obj.phrases) ? obj.phrases : [])
        .map((p) => ({ en: str(p?.en), zh: str(p?.zh) }))
        .filter((p) => p.en)
        .slice(0, 6),
      grammar: str(obj.grammar),
      translation: str(obj.translation),
    };
  } catch {
    return { meaning: raw.trim(), phrases: [], grammar: '', translation: '' };
  }
}

async function callModel(env, action, text, context) {
  const base = (env.AI_BASE_URL || '').replace(/\/+$/, '');
  const post = (jsonMode) =>
    fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.AI_API_KEY}` },
      body: JSON.stringify({
        model: env.AI_MODEL,
        messages: [
          { role: 'system', content: PROMPTS[action === 'explain' && isTerm(text) ? 'explainWord' : action] },
          { role: 'user', content: userMessage(text, context) },
        ],
        // 讲解要求模型直接输出合法 JSON
        ...(jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
      signal: AbortSignal.timeout(60_000),
    });
  let res = await post(action === 'explain');
  // 有的模型服务不支持 response_format，去掉再试一次
  if (res.status === 400 && action === 'explain') res = await post(false);
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    console.error(`[ai] upstream ${res.status}: ${detail}`);
    throw new Error(`模型服务返回 ${res.status}`);
  }
  const data = await res.json();
  let content = data?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map((c) => c?.text || '').join('');
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回内容');
  // 部分推理模型会把思考过程放在 <think> 标签里
  return content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// 简单限流：ip -> 最近一分钟的请求时间戳。
// 在 Cloudflare 上它只在单个实例内有效，作为兜底足够；真正的门槛是访问口令。
const hits = new Map();
function limited(ip, max) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > max;
}

/**
 * 处理 /api/* 请求，返回 Response；不是 /api/ 路径时返回 null。
 * @param {Request} request
 * @param {Record<string, string | undefined>} env
 * @param {{ ip?: string, store?: import('./sync.mjs').SyncStore | null }} [meta]
 */
export async function handleApi(request, env, meta = {}) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;

  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  if (env.ALLOWED_ORIGIN) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      Vary: 'Origin',
    });
  }
  const send = (status, body) => new Response(JSON.stringify(body), { status, headers });

  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  // 同步时会连续发很多请求，限额放宽
  const isSync = url.pathname.startsWith('/api/sync');
  if (limited(meta.ip || 'unknown', isSync ? 600 : 60)) return send(429, { error: '请求过于频繁，请稍后再试' });

  if (!env.ACCESS_TOKEN) return send(503, { error: '服务端未设置 ACCESS_TOKEN' });
  const auth = request.headers.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token || !(await sameToken(token, env.ACCESS_TOKEN))) return send(401, { error: '访问口令不正确' });

  const configured = Boolean(env.AI_BASE_URL && env.AI_MODEL && env.AI_API_KEY);

  if (url.pathname === '/api/ping' && request.method === 'GET') {
    return send(200, { ok: true, configured, sync: Boolean(meta.store) });
  }

  if (isSync) return handleSync(request, url, meta.store, send);

  if (url.pathname === '/api/ai' && request.method === 'POST') {
    if (!configured) return send(503, { error: '服务端未配置 AI_BASE_URL / AI_MODEL / AI_API_KEY' });
    if (Number(request.headers.get('content-length') || 0) > MAX_BODY) return send(413, { error: '请求过大' });
    let body;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return send(413, { error: '请求过大' });
      body = JSON.parse(raw);
    } catch {
      return send(400, { error: '请求格式错误' });
    }
    const action = body?.action;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const context = typeof body?.context === 'string' ? body.context.trim().slice(0, MAX_CONTEXT) : '';
    if (action !== 'translate' && action !== 'explain') return send(400, { error: '未知操作' });
    if (!text) return send(400, { error: '没有选中内容' });
    if (text.length > MAX_TEXT) return send(400, { error: '选中内容过长' });
    try {
      const raw = await callModel(env, action, text, context);
      return send(200, { result: action === 'explain' ? parseExplanation(raw) : raw });
    } catch (e) {
      const msg = e?.name === 'TimeoutError' ? '模型响应超时' : e?.message || '调用模型失败';
      return send(502, { error: msg });
    }
  }

  return send(404, { error: 'not found' });
}
