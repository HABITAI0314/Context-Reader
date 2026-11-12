// 云同步存储（Node 服务 / 本地开发）：记录存成一个 JSON 文件，书籍文件存在目录里。
// 默认目录 ./data，可用 SYNC_DIR 修改。适合单人使用。
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** @returns {import('./sync.mjs').SyncStore} */
export function fsStore(dir) {
  const filesDir = join(dir, 'files');
  const dbFile = join(dir, 'records.json');
  mkdirSync(filesDir, { recursive: true });

  let state = { seq: 0, records: {} };
  if (existsSync(dbFile)) state = JSON.parse(readFileSync(dbFile, 'utf8'));
  const save = () => {
    writeFileSync(dbFile + '.tmp', JSON.stringify(state));
    renameSync(dbFile + '.tmp', dbFile);
  };
  const types = {};
  const file = (id) => join(filesDir, id);

  return {
    async push(changes) {
      const deletedBooks = [];
      for (const c of changes) {
        const key = `${c.kind}:${c.id}`;
        const old = state.records[key];
        if (!old || c.updatedAt > old.updatedAt) {
          state.records[key] = { kind: c.kind, id: c.id, data: c.deleted ? null : c.data, updatedAt: c.updatedAt, deleted: Boolean(c.deleted), seq: ++state.seq };
        }
        if (c.kind === 'book' && state.records[key].deleted) deletedBooks.push(c.id);
      }
      if (changes.length) save();
      return deletedBooks;
    },
    async pull(cursor, limit) {
      return Object.values(state.records)
        .filter((r) => r.seq > cursor)
        .sort((a, b) => a.seq - b.seq)
        .slice(0, limit);
    },
    async clear() {
      // 记录清空，但 seq 不归零，其他设备的游标继续有效
      state.records = {};
      save();
      rmSync(filesDir, { recursive: true, force: true });
      mkdirSync(filesDir, { recursive: true });
      return state.seq;
    },
    async putFile(id, body, contentType) {
      await writeFile(file(id), Buffer.from(await new Response(body).arrayBuffer()));
      writeFileSync(file(id) + '.type', contentType);
      types[id] = contentType;
    },
    async getFile(id) {
      if (!existsSync(file(id))) return null;
      const contentType = types[id] || (existsSync(file(id) + '.type') ? readFileSync(file(id) + '.type', 'utf8') : 'application/octet-stream');
      return { body: await readFile(file(id)), contentType, size: statSync(file(id)).size };
    },
    async hasFile(id) {
      return existsSync(file(id));
    },
    async deleteFile(id) {
      rmSync(file(id), { force: true });
      rmSync(file(id) + '.type', { force: true });
    },
  };
}
