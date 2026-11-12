export type BookFormat = 'epub' | 'txt';

export interface BookMeta {
  id: string;
  title: string;
  author: string;
  format: BookFormat;
  cover?: string; // 缩略图 data URL
  series?: string; // 所属系列
  seriesIndex?: number; // 在系列中的序号
  size: number;
  addedAt: number;
  lastReadAt: number;
}

export interface Progress {
  bookId: string;
  loc: string; // EPUB: CFI；TXT: "章:段"
  percent: number; // 0~1
  label: string; // 当前章节名
  updatedAt: number;
}

export interface Favorite {
  id: string;
  bookId: string;
  bookTitle: string;
  text: string;
  context: string;
  loc: string;
  createdAt: number;
  chapter?: string; // 收藏时所在的章节名
  known?: boolean; // 复习时标记为"认识"
}

/** 查过的词句：翻译或讲解过就自动记下，用于正文标记和章末回顾 */
export interface Lookup {
  id: string; // 由小写文本生成，同一个词只有一条
  bookId: string;
  bookTitle: string;
  text: string;
  context: string;
  loc: string;
  chapter: string;
  createdAt: number;
  known?: boolean;
}

export type AiAction = 'translate' | 'explain';

export interface Explanation {
  phonetic?: string; // 单词或短语的音标
  pos?: string; // 词性
  meaning: string;
  phrases: { en: string; zh: string }[];
  grammar: string;
  translation: string;
}

export interface AiRecord {
  key: string;
  action: AiAction;
  text: string;
  context: string;
  result: string | Explanation;
  createdAt: number;
}

export interface TocItem {
  label: string;
  target: string;
  level: number;
}

export interface SelectionInfo {
  text: string;
  context: string;
  loc: string;
}

export type ThemeSetting = 'auto' | 'light' | 'sepia' | 'dark';
export type ThemeName = 'light' | 'sepia' | 'dark';

export interface Settings {
  fontSize: number;
  theme: ThemeSetting;
  speechRate: number;
  apiBase: string;
  token: string;
  /** 朗读用的系统声音（voiceURI），空表示自动挑选 */
  voice: string;
}

export interface RelocateInfo {
  loc: string;
  percent: number;
  label: string;
  tocTarget: string;
  hasPrev: boolean;
  hasNext: boolean;
}

export interface ViewHandle {
  goTo(target: string): void;
  next(): void;
  prev(): void;
  /** 当前已加载的各章内容根节点，按阅读顺序（听读用） */
  roots(): Element[];
  /** 正文的滚动容器 */
  scroller(): HTMLElement | null;
}

export interface ViewProps {
  data: ArrayBuffer | string;
  initialLoc: string;
  fontSize: number;
  theme: ThemeName;
  onReady(toc: TocItem[]): void;
  onRelocate(info: RelocateInfo): void;
  /** 需要在正文里标记出来的生词（小写） */
  terms: string[];
  onSelect(sel: SelectionInfo | null): void;
  /** 点了一个被标记的生词 */
  onRecall(term: string): void;
  onTap(): void;
  onScrollDown(): void;
  onError(message: string): void;
}
