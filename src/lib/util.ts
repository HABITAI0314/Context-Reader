import type { SelectionInfo, ThemeName } from '../types';

/** 不依赖 crypto.subtle 的内容哈希（局域网 http 调试时 subtle 不可用） */
export function hashBytes(bytes: Uint8Array): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    h1 = Math.imul(h1 ^ b, 0x01000193);
    h2 = Math.imul(h2 + b, 0x85ebca6b) ^ (h2 >>> 13);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h1) + hex(h2) + bytes.length.toString(16);
}

export function hashString(s: string): string {
  return hashBytes(new TextEncoder().encode(s));
}

export const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** mark：生词标记的淡底色；read：听读时当前句的底色 */
export const THEME_COLORS: Record<ThemeName, { bg: string; fg: string; accent: string; selection: string; mark: string; read: string }> = {
  light: { bg: '#f7f5f0', fg: '#22201c', accent: '#2f6f5e', selection: 'rgba(47,111,94,0.25)', mark: 'rgba(47,111,94,0.10)', read: 'rgba(240,196,60,0.42)' },
  sepia: { bg: '#f3e9d2', fg: '#3b3226', accent: '#8a5a2b', selection: 'rgba(138,90,43,0.25)', mark: 'rgba(138,90,43,0.12)', read: 'rgba(226,160,60,0.42)' },
  dark: { bg: '#121212', fg: '#cfccc6', accent: '#6dbfa6', selection: 'rgba(109,191,166,0.35)', mark: 'rgba(109,191,166,0.14)', read: 'rgba(214,170,60,0.34)' },
};

export const READING_FONT = '"Iowan Old Style", Charter, Georgia, "Songti SC", serif';

const BLOCK = 'p,li,blockquote,dd,dt,td,th,h1,h2,h3,h4,h5,h6,pre,figcaption,div,section,article';
const CONTEXT_LIMIT = 500;

/** 取选区所在段落作为"少量上下文"，过长时只保留选区前后各一小段 */
function contextOf(range: Range, text: string): string {
  let node: Node | null = range.commonAncestorContainer;
  if (node.nodeType !== 1) node = node.parentNode;
  const block = (node as Element | null)?.closest?.(BLOCK);
  if (!block || block === block.ownerDocument.body) return '';
  const full = squash(block.textContent || '');
  if (!full || full === text) return '';
  if (full.length <= CONTEXT_LIMIT) return full;
  const at = full.indexOf(text);
  if (at < 0) return full.slice(0, CONTEXT_LIMIT);
  const pad = Math.max(60, Math.floor((CONTEXT_LIMIT - text.length) / 2));
  let start = Math.max(0, at - pad);
  let end = Math.min(full.length, at + text.length + pad);
  if (start > 0) start = full.indexOf(' ', start) + 1 || start;
  if (end < full.length) end = full.lastIndexOf(' ', end) > at + text.length ? full.lastIndexOf(' ', end) : end;
  return (start > 0 ? '…' : '') + full.slice(start, end) + (end < full.length ? '…' : '');
}

/** 读取某个窗口（主页面或 EPUB iframe）当前的文字选区 */
export function readSelection(win: Window): { info: Omit<SelectionInfo, 'loc'>; range: Range } | null {
  const sel = win.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const text = squash(sel.toString());
  if (!text) return null;
  const range = sel.getRangeAt(0);
  return { info: { text, context: contextOf(range, text) }, range };
}

/** 生词的统一写法：小写、单空格、直撇号。用作记录的键和正文匹配 */
export const normTerm = (text: string) => squash(text).toLowerCase().replace(/’/g, "'");

/** 单词或很短的短语（会在正文里标记出来） */
export const isTerm = (text: string) => text.length <= 40 && /^[A-Za-z][A-Za-z'’-]*(\s+[A-Za-z'’-]+){0,3}$/.test(text.trim());
