// 听读：从屏幕上第一句开始，一句一句连续朗读，当前句高亮并自动滚动跟随。
import { READING, setHighlight } from './marks';
import { speak, stopSpeaking } from './speech';

const BLOCKS = 'p,li,h1,h2,h3,h4,h5,h6,blockquote,dd,dt,figcaption,div';

export interface Sentence {
  text: string;
  range: Range;
}

export interface NarrationHost {
  roots(): Element[];
  scroller(): HTMLElement | null;
}

export type NarrationState = 'playing' | 'paused' | 'stopped';

/** 可朗读的段落：最内层、含有文字的块级元素，按阅读顺序 */
function readableBlocks(roots: Element[]): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(BLOCKS))) {
      if (el.querySelector(BLOCKS) || el.hasAttribute('aria-hidden')) continue;
      if ((el.textContent || '').trim().length > 0) out.push(el);
    }
  }
  return out;
}

/** 把一个段落切成句子，并给出每句在 DOM 里的范围 */
export function splitSentences(block: Element): Sentence[] {
  const doc = block.ownerDocument;
  const nodes: { node: Text; start: number }[] = [];
  let full = '';
  const walker = doc.createTreeWalker(block, 4 /* NodeFilter.SHOW_TEXT */);
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    nodes.push({ node: n, start: full.length });
    full += n.data;
  }
  if (!full.trim()) return [];

  const pieces: { index: number; text: string }[] = [];
  const Segmenter = (Intl as any).Segmenter;
  if (Segmenter) {
    for (const s of new Segmenter('en', { granularity: 'sentence' }).segment(full)) pieces.push({ index: s.index, text: s.segment });
  } else {
    const re = /[^.!?…]+(?:[.!?…]+["'”’)\]]*\s*|$)/g;
    for (let m = re.exec(full); m && m[0]; m = re.exec(full)) pieces.push({ index: m.index, text: m[0] });
  }

  const locate = (pos: number) => {
    let i = nodes.length - 1;
    while (i > 0 && nodes[i].start > pos) i--;
    return { node: nodes[i].node, offset: Math.min(nodes[i].node.data.length, pos - nodes[i].start) };
  };
  const out: Sentence[] = [];
  for (const p of pieces) {
    const lead = p.text.length - p.text.trimStart().length;
    const body = p.text.trim();
    if (!/[A-Za-z0-9]/.test(body)) continue;
    const a = locate(p.index + lead);
    const b = locate(p.index + lead + body.length);
    const range = doc.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, b.offset);
    out.push({ text: body.replace(/\s+/g, ' '), range });
  }
  return out;
}

/** 元素或范围在屏幕上的纵向位置（EPUB 的内容在 iframe 里，要加上 iframe 的偏移） */
function screenBox(target: Range | Element): { top: number; bottom: number } {
  const r = target.getBoundingClientRect();
  const doc = 'ownerDocument' in target && target.ownerDocument ? target.ownerDocument : (target as Range).startContainer.ownerDocument!;
  const frame = doc.defaultView?.frameElement;
  const shift = frame ? frame.getBoundingClientRect().top : 0;
  return { top: r.top + shift, bottom: r.bottom + shift };
}

export class Narrator {
  state: NarrationState = 'stopped';
  private block: HTMLElement | null = null;
  private sentences: Sentence[] = [];
  private index = 0;
  private lit: Document | null = null;
  private waits = 0;
  private timer = 0;

  constructor(
    private host: NarrationHost,
    private rate: () => number,
    private onState: (s: NarrationState) => void
  ) {}

  /** 从屏幕上第一句看得见的话开始读。必须在用户点击的回调里调用（iOS 的要求） */
  start() {
    const top = 70;
    for (const block of readableBlocks(this.host.roots())) {
      if (screenBox(block).bottom <= top) continue;
      const sentences = splitSentences(block);
      if (!sentences.length) continue;
      const first = sentences.findIndex((s) => screenBox(s.range).bottom > top);
      this.block = block;
      this.sentences = sentences;
      this.index = Math.max(0, first);
      this.setState('playing');
      this.speakCurrent();
      return;
    }
  }

  pause() {
    if (this.state !== 'playing') return;
    clearTimeout(this.timer);
    stopSpeaking(); // iOS 上 pause/resume 不可靠：暂停就停掉，继续时把当前句重读一遍
    this.setState('paused');
  }

  resume() {
    if (this.state !== 'paused') return;
    this.setState('playing');
    this.speakCurrent();
  }

  /** 前进或后退若干句 */
  skip(delta: number) {
    if (this.state === 'stopped') return;
    clearTimeout(this.timer);
    stopSpeaking();
    this.move(delta);
  }

  stop() {
    clearTimeout(this.timer);
    stopSpeaking();
    this.light(null);
    this.block = null;
    this.sentences = [];
    this.setState('stopped');
  }

  private setState(s: NarrationState) {
    this.state = s;
    this.onState(s);
  }

  private light(range: Range | null) {
    const doc = range ? range.startContainer.ownerDocument : null;
    if (this.lit && this.lit !== doc) setHighlight(this.lit, READING, []);
    if (doc && range) setHighlight(doc, READING, [range]);
    this.lit = doc;
  }

  private speakCurrent() {
    const s = this.sentences[this.index];
    if (!s || !this.block?.isConnected) return this.stop();
    this.light(s.range);
    this.reveal(s.range);
    speak(s.text, this.rate(), () => {
      if (this.state === 'playing') this.move(1);
    });
  }

  private move(delta: number) {
    let i = this.index + delta;
    if (i >= 0 && i < this.sentences.length) {
      this.index = i;
    } else {
      // 换到相邻的段落；后面的章节可能还在加载，等一会儿再找
      const blocks = readableBlocks(this.host.roots());
      const at = this.block ? blocks.indexOf(this.block) : -1;
      if (at < 0) return this.stop();
      const step = delta > 0 ? 1 : -1;
      let j = at + step;
      let found: Sentence[] = [];
      while (j >= 0 && j < blocks.length && !(found = splitSentences(blocks[j])).length) j += step;
      if (!found.length) {
        if (delta > 0 && this.waits < 12) {
          this.waits++;
          const sc = this.host.scroller();
          sc?.scrollTo({ top: sc.scrollHeight }); // 滚到底，让阅读器把下一章接上
          this.timer = window.setTimeout(() => this.move(delta), 350);
          return;
        }
        if (delta > 0) return this.stop(); // 全书读完
        i = 0;
        this.index = 0;
      } else {
        this.block = blocks[j];
        this.sentences = found;
        this.index = delta > 0 ? 0 : found.length - 1;
      }
    }
    this.waits = 0;
    if (this.state === 'playing') this.speakCurrent();
    else {
      const s = this.sentences[this.index];
      if (s) {
        this.light(s.range);
        this.reveal(s.range);
      }
    }
  }

  /** 让当前句保持在屏幕上方三分之一附近 */
  private reveal(range: Range) {
    const sc = this.host.scroller();
    if (!sc) return;
    const box = screenBox(range);
    const vh = window.innerHeight;
    if (box.top < 70 || box.bottom > vh * 0.62) sc.scrollBy({ top: box.top - vh * 0.3, behavior: 'smooth' });
  }
}
