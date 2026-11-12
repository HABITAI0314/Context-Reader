import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { AiRecord, BookMeta, Favorite, Lookup, Progress } from '../types';

export type SyncKind = 'book' | 'progress' | 'favorite' | 'lookup' | 'ai' | 'file';
export interface OutboxEntry {
  key: string; // "kind:id"
  kind: SyncKind;
  id: string;
  updatedAt: number;
  deleted: boolean;
}

interface Schema extends DBSchema {
  books: { key: string; value: BookMeta };
  files: { key: string; value: ArrayBuffer | string };
  progress: { key: string; value: Progress };
  favorites: { key: string; value: Favorite; indexes: { bookId: string } };
  ai: { key: string; value: AiRecord };
  lookups: { key: string; value: Lookup; indexes: { bookId: string } };
  /** 等待上传到云端的改动 */
  outbox: { key: string; value: OutboxEntry };
  /** 同步游标等零散键值 */
  kv: { key: string; value: unknown };
}

let dbPromise: Promise<IDBPDatabase<Schema>> | null = null;

function db() {
  dbPromise ??= openDB<Schema>('context-reader', 3, {
    upgrade(d, oldVersion) {
      if (oldVersion < 1) {
        d.createObjectStore('books', { keyPath: 'id' });
        d.createObjectStore('files');
        d.createObjectStore('progress', { keyPath: 'bookId' });
        d.createObjectStore('favorites', { keyPath: 'id' }).createIndex('bookId', 'bookId');
        d.createObjectStore('ai', { keyPath: 'key' });
      }
      if (oldVersion < 2) {
        d.createObjectStore('lookups', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      }
      if (oldVersion < 3) {
        d.createObjectStore('outbox', { keyPath: 'key' });
        d.createObjectStore('kv');
      }
    },
  });
  return dbPromise;
}

// ---- 云同步：登记本地改动 ----
const changeListeners = new Set<() => void>();
/** 本地数据有改动时通知（同步模块据此安排上传） */
export function onLocalChange(fn: () => void) {
  changeListeners.add(fn);
  return () => {
    changeListeners.delete(fn);
  };
}
let lastMark = 0;
async function mark(kind: SyncKind, id: string, deleted = false) {
  // 保证时间严格递增，同一毫秒内的两次改动也能分出先后
  const now = Math.max(Date.now(), lastMark + 1);
  lastMark = now;
  await (await db()).put('outbox', { key: `${kind}:${id}`, kind, id, updatedAt: now, deleted });
  changeListeners.forEach((fn) => fn());
}

// ---- 书籍 ----
export async function listBooks(): Promise<BookMeta[]> {
  const all = await (await db()).getAll('books');
  return all.sort((a, b) => Math.max(b.lastReadAt, b.addedAt) - Math.max(a.lastReadAt, a.addedAt));
}
export async function getBook(id: string) {
  return (await db()).get('books', id);
}
export async function getBookFile(id: string) {
  return (await db()).get('files', id);
}
export async function saveBook(meta: BookMeta, file: ArrayBuffer | string) {
  const tx = (await db()).transaction(['books', 'files'], 'readwrite');
  await Promise.all([tx.objectStore('books').put(meta), tx.objectStore('files').put(file, meta.id), tx.done]);
  await mark('file', meta.id);
  await mark('book', meta.id);
}
export async function putBookMeta(meta: BookMeta) {
  await (await db()).put('books', meta);
  await mark('book', meta.id);
}
export async function touchBook(id: string) {
  const d = await db();
  const meta = await d.get('books', id);
  if (meta) {
    await d.put('books', { ...meta, lastReadAt: Date.now() });
    await mark('book', id);
  }
}
/** 删除书籍（同步后所有设备和云端都会删除）；进度和收藏属于学习记录，保留 */
export async function deleteBook(id: string) {
  const tx = (await db()).transaction(['books', 'files', 'outbox'], 'readwrite');
  await Promise.all([
    tx.objectStore('books').delete(id),
    tx.objectStore('files').delete(id),
    tx.objectStore('outbox').delete(`file:${id}`),
    tx.done,
  ]);
  await mark('book', id, true);
}
/** 保存从云端下载的书籍文件（不需要再上传） */
export async function storeBookFile(id: string, file: ArrayBuffer | string) {
  await (await db()).put('files', file, id);
}

// ---- 进度 ----
export async function getProgress(bookId: string) {
  return (await db()).get('progress', bookId);
}
export async function listProgress() {
  return (await db()).getAll('progress');
}
export async function saveProgress(p: Progress) {
  await (await db()).put('progress', p);
  await mark('progress', p.bookId);
}

// ---- 收藏 ----
export async function listFavorites(): Promise<Favorite[]> {
  const all = await (await db()).getAll('favorites');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function getFavorite(id: string) {
  return (await db()).get('favorites', id);
}
export async function putFavorite(f: Favorite) {
  await (await db()).put('favorites', f);
  await mark('favorite', f.id);
}
export async function deleteFavorite(id: string) {
  await (await db()).delete('favorites', id);
  await mark('favorite', id, true);
}

// ---- 查过的词句 ----
export async function listLookups(): Promise<Lookup[]> {
  const all = await (await db()).getAll('lookups');
  return all.sort((a, b) => b.createdAt - a.createdAt);
}
export async function putLookup(l: Lookup) {
  await (await db()).put('lookups', l);
  await mark('lookup', l.id);
}
export async function deleteLookup(id: string) {
  await (await db()).delete('lookups', id);
  await mark('lookup', id, true);
}

// ---- AI 结果 ----
export async function getAi(key: string) {
  return (await db()).get('ai', key);
}
export async function putAi(r: AiRecord) {
  await (await db()).put('ai', r);
  await mark('ai', r.key);
}
export async function listAi() {
  return (await db()).getAll('ai');
}

// ---- 云同步：供 sync.ts 使用的底层读写（不会登记为本地改动） ----
const STORE = { book: 'books', progress: 'progress', favorite: 'favorites', lookup: 'lookups', ai: 'ai' } as const;
export type RecordKind = keyof typeof STORE;

export async function readRecord(kind: RecordKind, id: string): Promise<unknown> {
  return (await db()).get(STORE[kind], id);
}
/** 写入从云端拉下来的记录；data 为 null 表示删除 */
export async function writeRemote(kind: RecordKind, id: string, data: unknown) {
  const d = await db();
  if (data == null) {
    if (kind === 'book') {
      const tx = d.transaction(['books', 'files'], 'readwrite');
      await Promise.all([tx.objectStore('books').delete(id), tx.objectStore('files').delete(id), tx.done]);
    } else await d.delete(STORE[kind], id);
  } else await d.put(STORE[kind], data as never);
}
export async function listOutbox() {
  return (await db()).getAll('outbox');
}
export async function getOutbox(key: string) {
  return (await db()).get('outbox', key);
}
/** 上传成功后移除；如果期间又有新改动（时间变了）则保留，下次再传 */
export async function clearOutbox(entry: OutboxEntry) {
  const tx = (await db()).transaction('outbox', 'readwrite');
  const cur = await tx.store.get(entry.key);
  if (cur && cur.updatedAt === entry.updatedAt) await tx.store.delete(entry.key);
  await tx.done;
}
export async function clearAllOutbox() {
  await (await db()).clear('outbox');
}
export async function dropOutbox(key: string) {
  await (await db()).delete('outbox', key);
}
/** 第一次同步时，把本机已有的全部数据登记为待上传（时间用数据本身的时间，便于和其他设备合并） */
export async function seedOutbox() {
  const d = await db();
  const [books, files, progress, favorites, lookups, ai, pending] = await Promise.all([
    d.getAll('books'),
    d.getAllKeys('files'),
    d.getAll('progress'),
    d.getAll('favorites'),
    d.getAll('lookups'),
    d.getAll('ai'),
    d.getAllKeys('outbox'),
  ]);
  const tx = d.transaction('outbox', 'readwrite');
  const skip = new Set(pending);
  const put = (kind: SyncKind, id: string, at: number) => {
    const key = `${kind}:${id}`;
    if (!skip.has(key)) tx.store.put({ key, kind, id, updatedAt: at || 1, deleted: false });
  };
  const fileSet = new Set(files);
  for (const b of books) {
    put('book', b.id, Math.max(b.addedAt, b.lastReadAt));
    if (fileSet.has(b.id)) put('file', b.id, b.addedAt);
  }
  for (const p of progress) put('progress', p.bookId, p.updatedAt);
  for (const f of favorites) put('favorite', f.id, f.createdAt);
  for (const l of lookups) put('lookup', l.id, l.createdAt);
  for (const r of ai) put('ai', r.key, r.createdAt);
  await tx.done;
}
export async function kvGet<T>(key: string): Promise<T | undefined> {
  return (await db()).get('kv', key) as Promise<T | undefined>;
}
export async function kvSet(key: string, value: unknown) {
  await (await db()).put('kv', value, key);
}

/** 请求浏览器不要自动清理本站数据（iOS 上添加到主屏幕后更可靠） */
export function requestPersist() {
  navigator.storage?.persist?.().catch(() => {});
}
