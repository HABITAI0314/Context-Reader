import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
// @ts-ignore 纯 JS 模块
import { createApi, loadEnvFile } from './server/api.mjs';

/** 开发时把 /api 直接挂在 Vite 上，一条命令即可启动前后端 */
function devApi(): Plugin {
  return {
    name: 'dev-api',
    configureServer(server) {
      loadEnvFile(join(server.config.root, '.env'));
      const api = createApi(process.env, server.config.root);
      server.middlewares.use(async (req, res, next) => {
        try {
          if (!(await api(req, res))) next();
        } catch (e) {
          next(e as Error);
        }
      });
    },
  };
}

/** 构建后生成 service worker：预缓存全部静态资源，使应用外壳可离线打开 */
function serviceWorker(): Plugin {
  let outDir = 'dist';
  return {
    name: 'simple-sw',
    apply: 'build',
    configResolved(config) {
      outDir = join(config.root, config.build.outDir);
    },
    closeBundle() {
      const files: string[] = [];
      const walk = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (name !== 'sw.js' && !name.startsWith('_')) files.push(full); // _headers 等是 Cloudflare 配置，不是可访问的资源
        }
      };
      walk(outDir);
      const hash = createHash('sha256');
      const urls = files.sort().map((f) => {
        hash.update(f).update(readFileSync(f));
        const u = '/' + relative(outDir, f).replace(/\\/g, '/');
        return u === '/index.html' ? '/' : u; // 首页用 / 缓存，避免 Cloudflare 的跳转
      });
      const version = hash.digest('hex').slice(0, 12);
      const sw = `// 自动生成，请勿手改
const CACHE = 'reader-${version}';
const FILES = ${JSON.stringify(urls)};
// Safari 不接受“经过重定向”的缓存响应作为页面（Cloudflare 会把 /index.html 跳到 /），
// 所以存进缓存前去掉重定向标记
const clean = (r) => (r && r.redirected ? r.blob().then((b) => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers })) : r);
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.all(FILES.map((f) => fetch(f, { cache: 'reload' }).then((r) => {
        if (!r.ok) throw new Error(f + ' ' + r.status);
        return Promise.resolve(clean(r)).then((ok) => c.put(f, ok));
      }))))
      .then(() => self.skipWaiting())
  );
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('reader-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('/').then((r) => (r ? clean(r) : fetch(req))));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((r) => (r ? clean(r) : fetch(req))));
});
`;
      writeFileSync(join(outDir, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  plugins: [react(), devApi(), serviceWorker()],
  server: { port: 5173 },
  build: { target: 'es2020', chunkSizeWarningLimit: 1200 },
});
