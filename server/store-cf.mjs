// 云同步存储（Cloudflare）：记录放 D1，书籍文件放 R2。
// D1 绑定名 env.DB（见 wrangler.toml）。
// R2 两种接法，任选其一：
//   - 同账号：R2 绑定 env.BOOKS
//   - 跨账号：用 S3 接口，环境变量 R2_S3_ENDPOINT、R2_ACCESS_KEY_ID、R2_SECRET_ACCESS_KEY、R2_BUCKET
import { s3Client } from './s3.mjs';

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS records (
    kind TEXT NOT NULL,
    id TEXT NOT NULL,
    data TEXT,
    updated_at INTEGER NOT NULL,
    deleted INTEGER NOT NULL DEFAULT 0,
    seq INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
  )`,
  'CREATE INDEX IF NOT EXISTS records_seq ON records (seq)',
];
// 清空云端后留下的一行占位，保证 seq 继续递增（其他设备的游标不会失效）
const MARKER = '_reset';
// 书籍文件统一放在这个前缀下；桶里如果还有别的东西（比如备份），清空时也不会碰到
const PREFIX = 'context-reader/books/';

let ready = null;

function fileBackend(env) {
  if (env.BOOKS) {
    const b = env.BOOKS;
    return {
      put: (key, body, contentType) => b.put(key, body, { httpMetadata: { contentType } }),
      async get(key) {
        const o = await b.get(key);
        return o ? { body: o.body, contentType: o.httpMetadata?.contentType || 'application/octet-stream', size: o.size } : null;
      },
      delete: (key) => b.delete(key),
      async list(prefix) {
        const keys = [];
        let cursor;
        do {
          const r = await b.list({ prefix, cursor });
          keys.push(...r.objects.map((o) => o.key));
          cursor = r.truncated ? r.cursor : undefined;
        } while (cursor);
        return keys;
      },
    };
  }
  if (env.R2_S3_ENDPOINT && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET) {
    const s3 = s3Client({
      endpoint: env.R2_S3_ENDPOINT,
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      bucket: env.R2_BUCKET,
    });
    return {
      // S3 上传需要知道长度，先读成 ArrayBuffer（单本书最大 95 MB）
      put: async (key, body, contentType) => s3.put(key, await new Response(body).arrayBuffer(), contentType),
      async get(key) {
        const res = await s3.get(key);
        if (!res) return null;
        return {
          body: res.body,
          contentType: res.headers.get('content-type') || 'application/octet-stream',
          size: Number(res.headers.get('content-length') || 0),
        };
      },
      delete: (key) => s3.delete(key),
      list: (prefix) => s3.list(prefix),
    };
  }
  return null;
}

/** @returns {import('./sync.mjs').SyncStore | null} */
export function cloudflareStore(env) {
  const db = env.DB;
  const files = fileBackend(env);
  if (!db || !files) return null;
  const init = () => (ready ??= db.batch(SCHEMA.map((s) => db.prepare(s))).catch((e) => ((ready = null), Promise.reject(e))));

  return {
    async push(changes) {
      await init();
      if (!changes.length) return [];
      // seq 取当前最大值 + 1，作为拉取游标；只有 updated_at 更新的一方才会覆盖
      const upsert = db.prepare(
        `INSERT INTO records (kind, id, data, updated_at, deleted, seq)
         VALUES (?1, ?2, ?3, ?4, ?5, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records))
         ON CONFLICT (kind, id) DO UPDATE SET
           data = excluded.data, updated_at = excluded.updated_at, deleted = excluded.deleted, seq = excluded.seq
         WHERE excluded.updated_at > records.updated_at`
      );
      await db.batch(changes.map((c) => upsert.bind(c.kind, c.id, c.deleted ? null : JSON.stringify(c.data), c.updatedAt, c.deleted ? 1 : 0)));
      // 返回最终处于删除状态的书，调用方据此清理文件
      const books = changes.filter((c) => c.kind === 'book' && c.deleted).map((c) => c.id);
      if (!books.length) return [];
      const { results } = await db
        .prepare(`SELECT id FROM records WHERE kind = 'book' AND deleted = 1 AND id IN (${books.map(() => '?').join(',')})`)
        .bind(...books)
        .all();
      return results.map((r) => r.id);
    },

    async pull(cursor, limit) {
      await init();
      const { results } = await db
        .prepare('SELECT kind, id, data, updated_at, deleted, seq FROM records WHERE seq > ?1 AND kind != ?3 ORDER BY seq LIMIT ?2')
        .bind(cursor, limit, MARKER)
        .all();
      return results.map((r) => ({
        kind: r.kind,
        id: r.id,
        data: r.data ? JSON.parse(r.data) : null,
        updatedAt: r.updated_at,
        deleted: Boolean(r.deleted),
        seq: r.seq,
      }));
    },

    async clear() {
      await init();
      for (const key of await files.list(PREFIX)) await files.delete(key);
      const max = (await db.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM records').first())?.m || 0;
      await db.batch([
        db.prepare('DELETE FROM records'),
        db.prepare('INSERT INTO records (kind, id, data, updated_at, deleted, seq) VALUES (?1, ?1, NULL, 0, 1, ?2)').bind(MARKER, max),
      ]);
      return max;
    },

    putFile: (id, body, contentType) => files.put(PREFIX + id, body, contentType),
    getFile: (id) => files.get(PREFIX + id),
    async hasFile(id) {
      return Boolean(await files.get(PREFIX + id));
    },
    deleteFile: (id) => files.delete(PREFIX + id),
  };
}
