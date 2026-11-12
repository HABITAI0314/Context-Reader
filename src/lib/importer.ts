import ePub from 'epubjs';
import type { BookMeta } from '../types';
import { getBook, listBooks, putBookMeta, saveBook } from './db';
import { decodeText } from './txt';
import { hashBytes } from './util';

const FONT_OBFUSCATION = ['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'];

function timeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
}

/** 把封面缩成小图存入书架 */
async function thumbnail(url: string): Promise<string | undefined> {
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = 240;
    const h = Math.round((img.naturalHeight / img.naturalWidth) * w) || 340;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.min(h, 400);
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    return undefined;
  }
}

async function readEpub(buf: ArrayBuffer, fallbackTitle: string) {
  const book = ePub(buf.slice(0));
  try {
    await timeout(book.ready, 20000, '无法解析这个 EPUB 文件');
    const zip = (book as any).archive?.zip;
    const enc = zip?.file('META-INF/encryption.xml');
    if (enc) {
      const xml: string = await enc.async('string');
      const algorithms = [...xml.matchAll(/EncryptionMethod[^>]*Algorithm="([^"]+)"/g)].map((m) => m[1]);
      if (algorithms.some((a) => !FONT_OBFUSCATION.includes(a))) {
        throw new Error('这本书带有 DRM 加密，无法阅读');
      }
    }
    const md = (book as any).packaging?.metadata || {};
    const coverUrl = await book.coverUrl().catch(() => null);
    return {
      title: (md.title || '').trim() || fallbackTitle,
      author: (md.creator || '').trim(),
      cover: coverUrl ? await thumbnail(coverUrl) : undefined,
    };
  } finally {
    try {
      book.destroy();
    } catch {}
  }
}

/** "01 - Dinosaurs Before Dark" → 序号 1 + 标题 */
function parseName(name: string): { index?: number; title: string } {
  const m = name.match(/^\s*(?:vol(?:ume)?\.?\s*|book\s*|#)?(\d{1,3})\s*[-–—._:)\]]+\s*(.+)$/i);
  return m ? { index: Number(m[1]), title: m[2].trim() } : { title: name.trim() };
}

/** 从书内标题猜系列名："Magic Tree House #3: Mummies in the Morning" → "Magic Tree House" */
function seriesFromTitle(title: string): string {
  const m = title.match(/^(.{3,60}?)[\s®™?]*(?:\((?:TM|R)\))?\s*#?\s*\d{1,3}\s*[:：]/);
  return m ? m[1].replace(/[\s®™?:,-]+$/, '').trim() : '';
}

interface Imported {
  meta: BookMeta;
  /** 书内的原始标题，用来猜系列名 */
  rawTitle: string;
  numbered: boolean;
}

async function importOne(file: File): Promise<Imported> {
  const name = file.name.replace(/\.[^.]+$/, '');
  const parsed = parseName(name);
  const ext = file.name.split('.').pop()?.toLowerCase();
  const buf = await file.arrayBuffer();
  const id = hashBytes(new Uint8Array(buf));
  const existing = await getBook(id);
  if (existing) {
    // 之前导入过：如果当时没有识别出序号，这次按文件名补上
    if (parsed.index != null && existing.seriesIndex == null) {
      const updated: BookMeta = { ...existing, seriesIndex: parsed.index, title: parsed.title };
      await putBookMeta(updated);
      return { meta: updated, rawTitle: existing.title, numbered: true };
    }
    return { meta: existing, rawTitle: existing.title, numbered: parsed.index != null };
  }

  const base = { id, size: buf.byteLength, addedAt: Date.now(), lastReadAt: 0, seriesIndex: parsed.index };
  const isZip = new Uint8Array(buf, 0, 2).join() === '80,75'; // "PK"

  if (ext === 'epub' || (isZip && ext !== 'txt')) {
    if (!isZip) throw new Error('不是有效的 EPUB 文件');
    const info = await readEpub(buf, name);
    // 文件名带序号时，用文件名里的标题（书内标题常常夹着系列名和商标符号）
    const meta: BookMeta = { ...base, format: 'epub', ...info, title: parsed.index != null ? parsed.title : info.title };
    await saveBook(meta, buf);
    return { meta, rawTitle: info.title, numbered: parsed.index != null };
  }
  if (ext === 'txt' || file.type.startsWith('text/')) {
    const text = decodeText(buf);
    if (!text.trim()) throw new Error('文件是空的');
    const meta: BookMeta = { ...base, format: 'txt', title: parsed.title, author: '' };
    await saveBook(meta, text);
    return { meta, rawTitle: name, numbered: parsed.index != null };
  }
  throw new Error('只支持 EPUB 和 TXT 文件');
}

export interface ImportResult {
  imported: BookMeta[];
  errors: { name: string; message: string }[];
}

/**
 * 批量导入。文件名带序号的书会自动归入系列：
 * 系列名取这批书内标题里出现最多的那个；猜不出来时并入同作者已有的系列。
 */
export async function importFiles(files: File[], onProgress?: (done: number, total: number, name: string) => void): Promise<ImportResult> {
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const done: Imported[] = [];
  const errors: ImportResult['errors'] = [];
  for (let i = 0; i < sorted.length; i++) {
    onProgress?.(i, sorted.length, sorted[i].name);
    try {
      done.push(await importOne(sorted[i]));
    } catch (e) {
      errors.push({ name: sorted[i].name, message: (e as Error).message || '导入失败' });
    }
  }

  const numbered = done.filter((d) => d.numbered && !d.meta.series);
  if (numbered.length) {
    const votes = new Map<string, number>();
    for (const d of numbered) {
      const guess = seriesFromTitle(d.rawTitle);
      if (guess) votes.set(guess, (votes.get(guess) || 0) + 1);
    }
    let series = [...votes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const existing = (await listBooks()).filter((b) => b.series);
    const known = existing.find((b) => b.series!.toLowerCase() === series.toLowerCase());
    if (known) series = known.series!;
    for (const d of numbered) {
      // 这批书猜不出系列名时，看同作者是否只有一个已有系列
      let target = series;
      if (!target && d.meta.author) {
        const sameAuthor = new Set(existing.filter((b) => b.author === d.meta.author).map((b) => b.series!));
        if (sameAuthor.size === 1) target = [...sameAuthor][0];
      }
      if (!target) continue;
      d.meta = { ...d.meta, series: target };
      await putBookMeta(d.meta);
    }
  }
  return { imported: done.map((d) => d.meta), errors };
}
