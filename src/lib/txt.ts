export interface TxtChapter {
  title: string;
  paras: string[];
}

const HEADING = /^\s*((chapter|part|book|volume|section|prologue|epilogue|preface|introduction)\b.{0,70}|第\s*[0-9一二三四五六七八九十百千零两]+\s*[章节回卷部篇].{0,40})\s*$/i;
const CHUNK = 24000; // 没有章节标题时，每部分的大致字符数

export function decodeText(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(buf);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(buf);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** 把纯文本拆成段落：兼容"每行硬换行 + 空行分段"（如 Project Gutenberg）与"一行一段"两种排版 */
function toParagraphs(text: string): string[] {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  const nonBlank = lines.filter((l) => l.trim());
  const blank = lines.length - nonBlank.length;
  const avg = nonBlank.reduce((n, l) => n + l.length, 0) / Math.max(1, nonBlank.length);
  const hardWrapped = blank > lines.length * 0.08 && avg < 90;
  if (!hardWrapped) return nonBlank.map((l) => l.trim());
  const paras: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (cur.length) paras.push(cur.join(' '));
    cur = [];
  };
  for (const line of lines) {
    const t = line.trim();
    if (!t) flush();
    else if (HEADING.test(t)) {
      flush();
      paras.push(t);
    } else cur.push(t);
  }
  flush();
  return paras;
}

function splitLong(ch: TxtChapter, out: TxtChapter[]) {
  let size = 0;
  let part: string[] = [];
  let n = 1;
  const push = () => {
    if (!part.length) return;
    out.push({ title: n === 1 ? ch.title : `${ch.title} (${n})`, paras: part });
    n++;
    part = [];
    size = 0;
  };
  for (const p of ch.paras) {
    part.push(p);
    size += p.length;
    if (size > CHUNK * 1.6) push();
  }
  push();
}

export function parseTxt(text: string): TxtChapter[] {
  const paras = toParagraphs(text);
  const headings = paras.filter((p) => p.length < 80 && HEADING.test(p)).length;
  const raw: TxtChapter[] = [];

  if (headings >= 2) {
    let cur: TxtChapter = { title: '开头', paras: [] };
    for (const p of paras) {
      if (p.length < 80 && HEADING.test(p)) {
        if (cur.paras.length) raw.push(cur);
        cur = { title: p, paras: [p] };
      } else cur.paras.push(p);
    }
    if (cur.paras.length) raw.push(cur);
  } else {
    let cur: string[] = [];
    let size = 0;
    for (const p of paras) {
      cur.push(p);
      size += p.length;
      if (size > CHUNK) {
        raw.push({ title: `第 ${raw.length + 1} 部分`, paras: cur });
        cur = [];
        size = 0;
      }
    }
    if (cur.length) raw.push({ title: `第 ${raw.length + 1} 部分`, paras: cur });
  }

  const out: TxtChapter[] = [];
  for (const ch of raw) splitLong(ch, out);
  return out.length ? out : [{ title: '正文', paras: ['（空文件）'] }];
}
