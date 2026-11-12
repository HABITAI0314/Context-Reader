// 正文里的生词标记。用 CSS Custom Highlight API 实现：只登记文字范围，不改动书的 DOM，
// 所以不会影响阅读位置（CFI）的计算。不支持该 API 的旧系统上自动跳过。

export interface Mark {
  range: Range;
  term: string;
}

export const MARK = 'cr-mark';
export const READING = 'cr-read';

/** 把生词列表编成一条正则（整词匹配、不分大小写） */
export function buildTermRegex(terms: string[]): RegExp | null {
  const clean = [...new Set(terms)].filter(Boolean).sort((a, b) => b.length - a.length).slice(0, 3000);
  if (!clean.length) return null;
  const escape = (t: string) =>
    t
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\s+/g, '\\s+')
      .replace(/'/g, "['’]");
  try {
    return new RegExp(`(?<![A-Za-z])(?:${clean.map(escape).join('|')})(?![A-Za-z])`, 'gi');
  } catch {
    return null; // 很旧的浏览器不支持后行断言
  }
}

function registry(doc: Document): { highlights: any; Highlight: any } | null {
  const win = doc.defaultView as any;
  return win?.CSS?.highlights && win.Highlight ? { highlights: win.CSS.highlights, Highlight: win.Highlight } : null;
}

/** 在一批根节点里找出所有生词出现的位置 */
export function findMarks(roots: Element[], regex: RegExp | null): Mark[] {
  const marks: Mark[] = [];
  if (!regex) return marks;
  for (const root of roots) {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.data.length < 2) continue;
      regex.lastIndex = 0;
      for (let m = regex.exec(node.data); m; m = regex.exec(node.data)) {
        const range = doc.createRange();
        range.setStart(node, m.index);
        range.setEnd(node, m.index + m[0].length);
        marks.push({ range, term: m[0].toLowerCase().replace(/\s+/g, ' ').replace(/’/g, "'") });
      }
    }
  }
  return marks;
}

/** 把一组范围登记为某个名字的高亮；传空数组即清除 */
export function setHighlight(doc: Document, name: string, ranges: Range[]) {
  const reg = registry(doc);
  if (!reg) return;
  if (!ranges.length) {
    reg.highlights.delete(name);
    return;
  }
  const h = new reg.Highlight();
  for (const r of ranges) h.add(r);
  reg.highlights.set(name, h);
}

/** 点击位置落在哪个标记上 */
export function markAt(doc: Document, x: number, y: number, marks: Mark[]): Mark | null {
  if (!marks.length) return null;
  let node: Node | null | undefined;
  let offset = 0;
  const d = doc as any;
  if (d.caretPositionFromPoint) {
    const p = d.caretPositionFromPoint(x, y);
    node = p?.offsetNode;
    offset = p?.offset ?? 0;
  } else if (d.caretRangeFromPoint) {
    const r: Range | null = d.caretRangeFromPoint(x, y);
    node = r?.startContainer;
    offset = r?.startOffset ?? 0;
  }
  if (!node) return null;
  return marks.find((m) => m.range.startContainer === node && offset >= m.range.startOffset && offset <= m.range.endOffset) || null;
}

/** 正文里两种高亮的样式（EPUB 的 iframe 和 TXT 页面共用） */
export function highlightCss(accent: string, soft: string, strong: string): string {
  return `
::highlight(${MARK}){text-decoration:underline;text-decoration-color:${accent};text-decoration-thickness:2px;text-underline-offset:3px;background-color:${soft};}
::highlight(${READING}){background-color:${strong};}
`;
}
