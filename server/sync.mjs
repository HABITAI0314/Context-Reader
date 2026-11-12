// 云同步接口。记录按“最后修改的为准”合并；客户端用 seq 游标增量拉取。
//
//   POST /api/sync              { cursor, changes: [{ kind, id, data, updatedAt, deleted }] }
//                               → { changes: [...], cursor, more }
//   PUT  /api/sync/file/:id     上传书籍文件（请求体就是文件内容）
//   GET  /api/sync/file/:id     下载书籍文件
//   DELETE /api/sync            清空云端全部数据（记录和书籍文件），返回新的游标

/**
 * @typedef {{ kind: string, id: string, data: any, updatedAt: number, deleted: boolean, seq?: number }} SyncRecord
 * @typedef {{
 *   push(changes: SyncRecord[]): Promise<string[]>,
 *   pull(cursor: number, limit: number): Promise<SyncRecord[]>,
 *   putFile(id: string, body: ReadableStream | ArrayBuffer, contentType: string): Promise<void>,
 *   getFile(id: string): Promise<{ body: any, contentType: string, size: number } | null>,
 *   hasFile(id: string): Promise<boolean>,
 *   deleteFile(id: string): Promise<void>,
 *   clear(): Promise<number>,
 * }} SyncStore
 */

const KINDS = new Set(['book', 'progress', 'favorite', 'lookup', 'ai']);
const MAX_SYNC_BODY = 8 * 1024 * 1024;
export const MAX_FILE = 95 * 1024 * 1024; // Cloudflare 免费套餐单个请求上限 100 MB
const PAGE = 500;
const ID = /^[A-Za-z0-9_-]{1,120}$/;

/**
 * @param {Request} request
 * @param {URL} url
 * @param {SyncStore | null | undefined} store
 * @param {(status: number, body: any) => Response} send
 */
export async function handleSync(request, url, store, send) {
  if (!store) return send(501, { error: '服务端没有配置云存储' });

  const fileMatch = url.pathname.match(/^\/api\/sync\/file\/([^/]+)$/);
  if (fileMatch) {
    const id = fileMatch[1];
    if (!ID.test(id)) return send(400, { error: '书籍编号无效' });
    if (request.method === 'PUT') {
      const size = Number(request.headers.get('content-length') || 0);
      if (size > MAX_FILE) return send(413, { error: '文件太大，超过 95 MB 无法同步' });
      if (!request.body) return send(400, { error: '没有文件内容' });
      await store.putFile(id, request.body, request.headers.get('content-type') || 'application/octet-stream');
      return send(200, { ok: true });
    }
    if (request.method === 'GET') {
      const f = await store.getFile(id);
      if (!f) return send(404, { error: '云端没有这本书的文件' });
      const headers = { 'Content-Type': f.contentType, 'Cache-Control': 'no-store' };
      if (f.size) headers['Content-Length'] = String(f.size);
      return new Response(f.body, { headers });
    }
    return send(405, { error: '不支持的请求' });
  }

  if (url.pathname === '/api/sync' && request.method === 'DELETE') {
    const cursor = await store.clear();
    return send(200, { ok: true, cursor });
  }

  if (url.pathname === '/api/sync' && request.method === 'POST') {
    if (Number(request.headers.get('content-length') || 0) > MAX_SYNC_BODY) return send(413, { error: '请求过大' });
    let body;
    try {
      body = JSON.parse(await request.text());
    } catch {
      return send(400, { error: '请求格式错误' });
    }
    const cursor = Number.isFinite(body?.cursor) ? body.cursor : 0;
    const changes = [];
    for (const c of Array.isArray(body?.changes) ? body.changes : []) {
      if (!KINDS.has(c?.kind) || typeof c.id !== 'string' || !c.id || c.id.length > 200 || !Number.isFinite(c.updatedAt)) continue;
      if (!c.deleted && (c.data == null || typeof c.data !== 'object')) continue;
      changes.push({ kind: c.kind, id: c.id, data: c.deleted ? null : c.data, updatedAt: c.updatedAt, deleted: Boolean(c.deleted) });
    }
    const deletedBooks = await store.push(changes);
    await Promise.all(deletedBooks.filter((id) => ID.test(id)).map((id) => store.deleteFile(id)));

    const rows = await store.pull(cursor, PAGE + 1);
    const more = rows.length > PAGE;
    const page = rows.slice(0, PAGE);
    return send(200, {
      changes: page.map(({ seq, ...r }) => r),
      cursor: page.length ? page[page.length - 1].seq : cursor,
      more,
    });
  }

  return send(404, { error: 'not found' });
}
