// 云同步：本机改动登记在 outbox 里，联网时上传；再按游标拉取其他设备的改动。
// 合并规则：同一条记录以最后修改的为准。书籍文件单独上传，其他设备打开时按需下载。
import { useSyncExternalStore } from 'react';
import type { BookFormat } from '../types';
import {
  clearAllOutbox,
  clearOutbox,
  dropOutbox,
  getBookFile,
  getOutbox,
  kvGet,
  kvSet,
  listOutbox,
  onLocalChange,
  readRecord,
  seedOutbox,
  storeBookFile,
  writeRemote,
  type OutboxEntry,
  type RecordKind,
} from './db';
import { getSettings } from './settings';

interface RemoteChange {
  kind: RecordKind;
  id: string;
  data: unknown;
  updatedAt: number;
  deleted: boolean;
}

export interface SyncStatus {
  state: 'idle' | 'syncing' | 'error' | 'off';
  message: string;
  lastSync: number;
  pending: number;
}

const BATCH = 200;
const INTERVAL = 2 * 60 * 1000;

let status: SyncStatus = { state: 'idle', message: '', lastSync: 0, pending: 0 };
const listeners = new Set<() => void>();
function setStatus(patch: Partial<SyncStatus>) {
  status = { ...status, ...patch };
  listeners.forEach((fn) => fn());
}
export function useSyncStatus(): SyncStatus {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => status
  );
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function endpoint(path: string) {
  return getSettings().apiBase.trim().replace(/\/+$/, '') + path;
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const { token } = getSettings();
  if (!token) throw new HttpError(0, '未填写访问口令');
  let res: Response;
  try {
    res = await fetch(endpoint(path), { ...init, headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` } });
  } catch {
    throw new HttpError(0, navigator.onLine ? '无法连接到服务' : '当前离线');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new HttpError(res.status, data?.error || `请求失败（${res.status}）`);
  }
  return res;
}

/** 通知页面：云端拉下来的数据已写入本机 */
export const REMOTE_EVENT = 'cr-remote-change';

async function applyRemote(changes: RemoteChange[]): Promise<number> {
  let applied = 0;
  for (const c of changes) {
    const key = `${c.kind}:${c.id}`;
    const local = await getOutbox(key);
    // 本机有更新的未上传改动：保留本机的，稍后上传会覆盖云端
    if (local && local.updatedAt > c.updatedAt) continue;
    if (local) await dropOutbox(key);
    if (!c.deleted && c.kind === 'book') {
      // 书的元数据来了但文件还在云端，打开时再下载
      await writeRemote('book', c.id, c.data);
    } else {
      await writeRemote(c.kind, c.id, c.deleted ? null : c.data);
    }
    applied++;
  }
  return applied;
}

let skippedFiles = 0;

async function uploadFiles(entries: OutboxEntry[]) {
  for (const e of entries) {
    const file = await getBookFile(e.id);
    if (file === undefined) {
      await dropOutbox(e.key);
      continue;
    }
    const body =
      typeof file === 'string'
        ? new Blob([file], { type: 'text/plain; charset=utf-8' })
        : new Blob([file], { type: 'application/epub+zip' });
    try {
      await request(`/api/sync/file/${encodeURIComponent(e.id)}`, { method: 'PUT', body, headers: { 'Content-Type': body.type } });
    } catch (err) {
      // 文件过大传不上去：放弃这一本，不要卡住其他数据的同步
      if (err instanceof HttpError && err.status === 413) {
        await dropOutbox(e.key);
        skippedFiles++;
        continue;
      }
      throw err;
    }
    await clearOutbox(e);
  }
}

async function buildChange(e: OutboxEntry) {
  const kind = e.kind as RecordKind;
  const data = e.deleted ? null : await readRecord(kind, e.id);
  return { kind, id: e.id, updatedAt: e.updatedAt, deleted: data == null, data };
}

let running: Promise<void> | null = null;
let again = false;
let disabled = false; // 服务端没开云存储时，本次打开期间不再尝试

/** 手动同步（设置页）：也会重新检查服务端是否开启了云同步 */
export function retrySync() {
  disabled = false;
  return syncNow();
}

/** 立即同步一次；正在同步时会在结束后再补一次 */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await syncOnce();
      } while (again);
    } finally {
      running = null;
    }
  })();
  return running;
}

async function syncOnce() {
  if (!getSettings().token || disabled) {
    setStatus({ state: 'off', message: disabled ? '服务端没有开启云同步' : '填写访问口令后自动同步' });
    return;
  }
  if (!navigator.onLine) {
    setStatus({ state: 'idle', message: '当前离线，联网后自动同步', pending: (await listOutbox()).length });
    return;
  }
  setStatus({ state: 'syncing', message: '正在同步…' });
  try {
    if (!(await kvGet<boolean>('sync.seeded'))) {
      await seedOutbox();
      await kvSet('sync.seeded', true);
    }
    // 1. 先传书籍文件，其他设备收到书的记录时文件已经在云端了
    const files = (await listOutbox()).filter((e) => e.kind === 'file');
    for (let i = 0; i < files.length; i++) {
      setStatus({ message: `正在上传书籍 ${i + 1}/${files.length}…` });
      await uploadFiles([files[i]]);
    }

    // 2. 上传记录、拉取其他设备的改动
    let cursor = (await kvGet<number>('sync.cursor')) || 0;
    let applied = 0;
    for (;;) {
      const batch = (await listOutbox()).filter((e) => e.kind !== 'file').slice(0, BATCH);
      const changes = await Promise.all(batch.map(buildChange));
      const res = await request('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cursor, changes }),
      });
      const data: { changes: RemoteChange[]; cursor: number; more: boolean } = await res.json();
      for (const e of batch) await clearOutbox(e);
      applied += await applyRemote(data.changes);
      cursor = data.cursor;
      await kvSet('sync.cursor', cursor);
      if (!batch.length && !data.more) break;
    }
    if (applied) window.dispatchEvent(new Event(REMOTE_EVENT));
    const now = Date.now();
    await kvSet('sync.last', now);
    setStatus({
      state: 'idle',
      message: skippedFiles ? `${skippedFiles} 本书文件太大（超过 95 MB），没有上传到云端` : '',
      lastSync: now,
      pending: (await listOutbox()).length,
    });
  } catch (e) {
    if (e instanceof HttpError && e.status === 501) disabled = true;
    setStatus({ state: 'error', message: (e as Error).message || '同步失败', pending: (await listOutbox()).length });
  }
}

/**
 * 清空云端全部数据（书籍文件和所有记录）。本机数据不动，也不会再把现有数据传上去；
 * 之后本机的新改动照常同步。
 */
export async function clearCloud() {
  if (running) await running;
  const res = await request('/api/sync', { method: 'DELETE' });
  const { cursor } = (await res.json()) as { cursor: number };
  await clearAllOutbox();
  await kvSet('sync.seeded', true);
  await kvSet('sync.cursor', cursor);
  setStatus({ state: 'idle', message: '云端数据已清空', pending: 0 });
}

/** 本机没有文件时从云端下载（在其他设备上导入的书） */
export async function downloadBookFile(id: string, format: BookFormat, onProgress?: (pct: number) => void) {
  const res = await request(`/api/sync/file/${encodeURIComponent(id)}`);
  const total = Number(res.headers.get('content-length') || 0);
  let buf: ArrayBuffer;
  if (res.body && total) {
    const reader = res.body.getReader();
    const out = new Uint8Array(total);
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.set(value, got);
      got += value.length;
      onProgress?.(got / total);
    }
    buf = out.buffer;
  } else buf = await res.arrayBuffer();
  const file = format === 'txt' ? new TextDecoder().decode(buf) : buf;
  await storeBookFile(id, file);
  return file;
}

/** 启动自动同步：打开时、本机有改动后几秒、切到后台、恢复联网、以及每隔两分钟 */
export function startSync() {
  kvGet<number>('sync.last').then((t) => t && setStatus({ lastSync: t }));
  let timer = 0;
  const soon = (ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => syncNow(), ms);
  };
  onLocalChange(() => soon(4000));
  window.addEventListener('online', () => soon(500));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncNow();
    else soon(500);
  });
  setInterval(() => document.visibilityState === 'visible' && syncNow(), INTERVAL);
  soon(800);
}
