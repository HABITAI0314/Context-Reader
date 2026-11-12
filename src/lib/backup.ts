import type { AiRecord, Favorite, Lookup, Progress } from '../types';
import { getProgress, listAi, listBooks, listFavorites, listLookups, listProgress, putAi, putFavorite, putLookup, saveProgress } from './db';
import { getSettings, updateSettings } from './settings';

interface Backup {
  app: 'context-reader';
  version: 1;
  exportedAt: string;
  books: { id: string; title: string; author: string; format: string }[];
  progress: Progress[];
  favorites: Favorite[];
  lookups?: Lookup[];
  ai: AiRecord[];
  settings: { fontSize: number; theme: string; speechRate: number };
}

/** 导出学习记录（进度、收藏、AI 结果、阅读偏好）。不含书籍文件，也不含访问口令。 */
export async function exportBackup(): Promise<void> {
  const s = getSettings();
  const data: Backup = {
    app: 'context-reader',
    version: 1,
    exportedAt: new Date().toISOString(),
    books: (await listBooks()).map(({ id, title, author, format }) => ({ id, title, author, format })),
    progress: await listProgress(),
    favorites: await listFavorites(),
    lookups: await listLookups(),
    ai: await listAi(),
    settings: { fontSize: s.fontSize, theme: s.theme, speechRate: s.speechRate },
  };
  const name = `context-reader-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data, null, 1)], name, { type: 'application/json' });

  // iOS 主屏幕模式下直接下载不可靠，优先用系统分享面板（可"存储到文件"）
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** 恢复学习记录：与本地合并，进度取较新的一份 */
export async function restoreBackup(file: File): Promise<{ progress: number; favorites: number; ai: number }> {
  let data: Backup;
  try {
    data = JSON.parse(await file.text());
  } catch {
    throw new Error('不是有效的备份文件');
  }
  if (data?.app !== 'context-reader') throw new Error('不是 Context Reader 的备份文件');

  let progress = 0;
  for (const p of data.progress || []) {
    if (!p?.bookId || typeof p.loc !== 'string') continue;
    const local = await getProgress(p.bookId);
    if (!local || local.updatedAt < p.updatedAt) {
      await saveProgress(p);
      progress++;
    }
  }
  let favorites = 0;
  for (const f of data.favorites || []) {
    if (!f?.id || typeof f.text !== 'string') continue;
    await putFavorite(f);
    favorites++;
  }
  for (const l of data.lookups || []) {
    if (l?.id && typeof l.text === 'string') await putLookup(l);
  }
  let ai = 0;
  for (const r of data.ai || []) {
    if (!r?.key || !r.action) continue;
    await putAi(r);
    ai++;
  }
  const s = data.settings;
  if (s && typeof s.fontSize === 'number') {
    updateSettings({ fontSize: s.fontSize, theme: s.theme as never, speechRate: s.speechRate });
  }
  return { progress, favorites, ai };
}
