// 生产环境入口：同一个进程提供静态页面（dist）和 /api 接口。零依赖。
import { createServer } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApi, loadEnvFile } from './api.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
loadEnvFile(join(root, '.env'));

const dist = join(root, 'dist');
const api = createApi(process.env, root);
const port = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end();
  }
  let pathname = '/';
  try {
    pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
  } catch {}
  let file = normalize(join(dist, pathname));
  if (!file.startsWith(dist)) file = join(dist, 'index.html');
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
  if (!existsSync(file)) {
    res.statusCode = 404;
    return res.end('dist 不存在，请先运行 npm run build');
  }
  const ext = extname(file);
  res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream');
  // 带 hash 的资源长期缓存；入口和 service worker 每次校验
  const immutable = file.includes(`${join(dist, 'assets')}`);
  res.setHeader('Cache-Control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.method === 'HEAD') return res.end();
  createReadStream(file).pipe(res);
}

createServer(async (req, res) => {
  try {
    if (await api(req, res)) return;
    serveStatic(req, res);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) res.statusCode = 500;
    res.end();
  }
}).listen(port, () => {
  console.log(`Context Reader 已启动: http://localhost:${port}`);
  if (!process.env.ACCESS_TOKEN) console.warn('警告：未设置 ACCESS_TOKEN，AI 接口不可用');
});
