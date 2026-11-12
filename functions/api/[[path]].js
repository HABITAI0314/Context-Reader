// Cloudflare Pages Functions 入口：所有 /api/* 请求都交给共用的 core.mjs 处理。
// 环境变量（ACCESS_TOKEN、AI_BASE_URL、AI_MODEL、AI_API_KEY）在 Cloudflare 后台设置；
// 云同步用到的 D1（DB）和 R2（BOOKS）绑定写在 wrangler.toml。
import { handleApi } from '../../server/core.mjs';
import { cloudflareStore } from '../../server/store-cf.mjs';

export async function onRequest({ request, env }) {
  const res = await handleApi(request, env, {
    ip: request.headers.get('CF-Connecting-IP') || undefined,
    store: cloudflareStore(env),
  });
  return res || new Response('not found', { status: 404 });
}
