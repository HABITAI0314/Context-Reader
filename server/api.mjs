// Node 适配层：把 Node 的 req/res 转成 Web 标准的 Request/Response，交给 core.mjs 处理。
// 生产 Node 服务（server/index.mjs）和 Vite 开发服务器（vite.config.ts）都用这里。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { handleApi } from './core.mjs';
import { fsStore } from './store-fs.mjs';
import { MAX_FILE } from './sync.mjs';

/** 读取 .env（不覆盖已存在的环境变量） */
export function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

function readBody(req, MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * 返回一个 Node 请求处理函数：处理了 /api/* 则返回 true，否则返回 false。
 */
export function createApi(env = process.env, root = process.cwd()) {
  // 云同步数据目录；设置 SYNC_DIR=off 可关闭
  const store = env.SYNC_DIR === 'off' ? null : fsStore(resolve(root, env.SYNC_DIR || 'data'));
  return async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    let body;
    if (req.method === 'POST' || req.method === 'PUT') {
      const limit = url.pathname.startsWith('/api/sync/file/') ? MAX_FILE : url.pathname === '/api/sync' ? 8 * 1024 * 1024 : 16 * 1024;
      try {
        body = await readBody(req, limit);
      } catch {
        res.statusCode = 413;
        res.end();
        return true;
      }
    }
    const request = new Request(url, { method: req.method, headers, body });
    const response = await handleApi(request, env, { ip: req.socket?.remoteAddress, store });

    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    res.end(Buffer.from(await response.arrayBuffer()));
    return true;
  };
}
