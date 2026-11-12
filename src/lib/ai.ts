import type { AiAction, AiRecord } from '../types';
import { getAi, putAi } from './db';
import { getSettings } from './settings';
import { hashString } from './util';

export const aiKey = (action: AiAction, text: string, context: string) =>
  hashString(`${action}\n${text}\n${context}`);

function endpoint(path: string) {
  return getSettings().apiBase.trim().replace(/\/+$/, '') + path;
}

async function call(path: string, init: RequestInit) {
  const { token } = getSettings();
  if (!token) throw new Error('请先在「设置」中填写访问口令');
  let res: Response;
  try {
    res = await fetch(endpoint(path), {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
  } catch {
    throw new Error(navigator.onLine ? '无法连接到服务' : '当前离线，联网后可用');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `请求失败（${res.status}）`);
  return data;
}

/** 旧版本解析失败时，会把模型原始 JSON 整段塞进 meaning 里存下来；这类缓存当作没有 */
const broken = (r: AiRecord | undefined) =>
  r?.action === 'explain' && typeof r.result === 'object' && /^\s*[{`]/.test(r.result.meaning || '');

export async function getCachedAi(action: AiAction, text: string, context: string) {
  const r = await getAi(aiKey(action, text, context));
  return broken(r) ? undefined : r;
}

/** 调用翻译 / 讲解；结果写入本地，之后离线也能看 */
export async function askAi(action: AiAction, text: string, context: string): Promise<AiRecord['result']> {
  const key = aiKey(action, text, context);
  const cached = await getAi(key);
  if (cached && !broken(cached)) return cached.result;
  const data = await call('/api/ai', { method: 'POST', body: JSON.stringify({ action, text, context }) });
  const result = data.result as AiRecord['result'];
  await putAi({ key, action, text, context, result, createdAt: Date.now() });
  return result;
}

export async function pingServer(): Promise<{ configured: boolean }> {
  return call('/api/ping', { method: 'GET' });
}
