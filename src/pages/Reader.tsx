import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookMeta, Lookup, Progress, RelocateInfo, SelectionInfo, ThemeSetting, TocItem, ViewHandle, ViewProps } from '../types';
import { EpubView } from '../components/EpubView';
import { TxtView } from '../components/TxtView';
import { ReviewDeck, type ReviewItem } from '../components/ReviewDeck';
import { StudySheet } from '../components/StudySheet';
import { Icon, Sheet } from '../components/ui';
import { getBook, getBookFile, getProgress, listLookups, putLookup, saveProgress, touchBook } from '../lib/db';
import { Narrator, type NarrationState } from '../lib/narrate';
import { FONT_MAX, FONT_MIN, updateSettings, useSettings, useTheme } from '../lib/settings';
import { speechSupported } from '../lib/speech';
import { downloadBookFile } from '../lib/sync';
import { isTerm, normTerm } from '../lib/util';

const THEMES: { value: ThemeSetting; label: string }[] = [
  { value: 'auto', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'sepia', label: '护眼' },
  { value: 'dark', label: '深色' },
];

type Loaded = { meta: BookMeta; data: ArrayBuffer | string; loc: string };
type Shown = SelectionInfo & { recall?: boolean };

const toItem = (l: Lookup): ReviewItem => ({ id: l.id, text: l.text, context: l.context, source: [l.bookTitle, l.chapter].filter(Boolean).join(' · ') });

export function Reader({ bookId, jump, onExit }: { bookId: string; jump?: string; onExit(): void }) {
  const settings = useSettings();
  const theme = useTheme();
  const [book, setBook] = useState<Loaded | 'missing' | null>(null);
  const [opening, setOpening] = useState('正在打开…');
  const [error, setError] = useState('');
  const [chrome, setChrome] = useState(true);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [info, setInfo] = useState<RelocateInfo | null>(null);
  const [panel, setPanel] = useState<'toc' | 'aa' | 'vocab' | null>(null);
  const [sel, setSel] = useState<Shown | null>(null);
  const [lookups, setLookups] = useState<Lookup[]>([]);
  const [deck, setDeck] = useState<{ title: string; items: ReviewItem[] } | null>(null);
  const [recap, setRecap] = useState<{ chapter: string; items: Lookup[] } | null>(null);
  const [narration, setNarration] = useState<NarrationState>('stopped');
  const view = useRef<ViewHandle>(null);
  const selRef = useRef(sel);
  selRef.current = sel;
  const pinned = useRef(false);
  const pending = useRef<Progress | null>(null);
  const saveTimer = useRef(0);
  const lastChapter = useRef<{ label: string; percent: number } | null>(null);
  const recapTimer = useRef(0);
  const rate = useRef(settings.speechRate);
  rate.current = settings.speechRate;
  const narrator = useRef<Narrator | null>(null);

  const refreshLookups = () => listLookups().then(setLookups);

  useEffect(() => {
    let dead = false;
    (async () => {
      const [meta, stored, progress] = await Promise.all([getBook(bookId), getBookFile(bookId), getProgress(bookId)]);
      if (dead) return;
      if (!meta) return setBook('missing');
      let data = stored;
      if (data === undefined) {
        // 在其他设备上导入的书：从云端下载到本机
        setOpening('正在从云端下载这本书…');
        try {
          data = await downloadBookFile(bookId, meta.format, (p) => !dead && setOpening(`正在从云端下载这本书… ${Math.round(p * 100)}%`));
        } catch (e) {
          if (!dead) setError(`这本书还不在本机上，从云端下载失败：${(e as Error).message}`);
          return;
        }
        if (dead) return;
      }
      setBook({ meta, data, loc: jump || progress?.loc || '' });
      touchBook(bookId);
    })();
    refreshLookups();
    return () => {
      dead = true;
    };
  }, [bookId]);

  // 阅读位置：滚动停下后稍等片刻写入；切到后台或离开页面时立即写入
  const flush = () => {
    clearTimeout(saveTimer.current);
    if (pending.current) {
      saveProgress(pending.current);
      pending.current = null;
    }
  };
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState !== 'hidden') return;
      flush();
      narrator.current?.pause(); // 切到后台时系统会停掉朗读
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
      clearTimeout(recapTimer.current);
      narrator.current?.stop();
      flush();
    };
  }, []);

  // 正文里要标出的生词：还没标记为"认识"的单词和短语（所有书通用）
  const terms = useMemo(() => lookups.filter((l) => !l.known && isTerm(l.text)).map((l) => normTerm(l.text)), [lookups]);
  const byTerm = useMemo(() => new Map(lookups.map((l) => [normTerm(l.text), l])), [lookups]);
  const mine = useMemo(() => lookups.filter((l) => l.bookId === bookId), [lookups, bookId]);

  if (book === 'missing' || error) {
    return (
      <div className="page center">
        <p>{error || '这本书不在本机上，请重新导入。'}</p>
        <button className="btn" onClick={onExit}>
          返回书架
        </button>
      </div>
    );
  }
  if (!book) return <div className="page center muted">{opening}</div>;

  const chapterNow = info?.label || '';

  const viewProps: ViewProps = {
    data: book.data,
    initialLoc: book.loc,
    fontSize: settings.fontSize,
    theme,
    terms,
    onReady: setToc,
    onRelocate(next) {
      setInfo(next);
      // 往前读进了新的一章：如果上一章查过生词，提示回顾
      const prev = lastChapter.current;
      if (prev && next.label && prev.label && next.label !== prev.label && next.percent > prev.percent) {
        const items = mine.filter((l) => !l.known && l.chapter === prev.label);
        if (items.length) {
          setRecap({ chapter: prev.label, items });
          clearTimeout(recapTimer.current);
          recapTimer.current = window.setTimeout(() => setRecap(null), 12000);
        }
      }
      if (next.label) lastChapter.current = { label: next.label, percent: next.percent };
      if (!next.loc) return;
      pending.current = { bookId, loc: next.loc, percent: next.percent, label: next.label, updatedAt: Date.now() };
      clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(flush, 400);
    },
    onSelect(next) {
      if (next) {
        pinned.current = false;
        setChrome(false);
        narrator.current?.pause(); // 查词时先停下朗读
        setSel((prev) => (prev && prev.text === next.text && prev.loc === next.loc ? prev : next));
      } else if (!pinned.current) {
        setSel(null);
      }
    },
    onRecall(term) {
      const l = byTerm.get(term);
      if (!l) return;
      pinned.current = true;
      narrator.current?.pause();
      setChrome(false);
      setSel({ text: l.text, context: l.context, loc: l.loc, recall: true });
    },
    onTap() {
      // 弹窗开着时，点正文先关弹窗；否则切换顶部/底部栏
      if (selRef.current) setSel(null);
      else setChrome((c) => !c);
    },
    onScrollDown: () => setChrome(false),
    onError: setError,
  };

  const View = book.meta.format === 'epub' ? EpubView : TxtView;
  const percent = info ? Math.round(info.percent * 100) : 0;
  const setFont = (d: number) => updateSettings({ fontSize: Math.min(FONT_MAX, Math.max(FONT_MIN, settings.fontSize + d)) });
  const setRate = (d: number) => updateSettings({ speechRate: Math.min(1.3, Math.max(0.6, Math.round((settings.speechRate + d) * 20) / 20)) });

  const startNarration = () => {
    if (!view.current) return;
    narrator.current ??= new Narrator(view.current, () => rate.current, setNarration);
    setSel(null);
    setChrome(false);
    narrator.current.start();
  };

  const openDeck = (title: string, items: Lookup[]) => {
    setPanel(null);
    setRecap(null);
    narrator.current?.pause();
    setDeck({ title, items: items.map(toItem) });
  };

  // 生词本：按章节分组，当前章排最前
  const groups: { chapter: string; items: Lookup[] }[] = [];
  for (const l of mine) {
    const key = l.chapter || '未分章';
    const g = groups.find((x) => x.chapter === key);
    if (g) g.items.push(l);
    else groups.push({ chapter: key, items: [l] });
  }
  groups.sort((a, b) => Number(b.chapter === chapterNow) - Number(a.chapter === chapterNow));
  const unknown = mine.filter((l) => !l.known);

  return (
    <div className="reader">
      <div className="reader-view">
        <View key={bookId} ref={view} {...viewProps} />
      </div>

      <header className={'reader-top' + (chrome ? '' : ' away')}>
        <button className="icon-btn" onClick={onExit} aria-label="返回书架">
          <Icon name="back" />
        </button>
        <div className="reader-title">{book.meta.title}</div>
        {speechSupported && (
          <button className="icon-btn" onClick={startNarration} aria-label="听读">
            <Icon name="listen" />
          </button>
        )}
        <button className="icon-btn" onClick={() => setPanel('vocab')} aria-label="生词本">
          <Icon name="cards" />
        </button>
        <button className="icon-btn" onClick={() => setPanel('toc')} aria-label="目录">
          <Icon name="list" />
        </button>
        <button className="icon-btn text-btn" onClick={() => setPanel('aa')} aria-label="字号与主题">
          Aa
        </button>
      </header>

      <footer className={'reader-bottom' + (chrome && narration === 'stopped' ? '' : ' away')}>
        <button className="link" disabled={!info?.hasPrev} onClick={() => view.current?.prev()}>
          上一章
        </button>
        <div className="reader-pos">
          <span>{info?.label || book.meta.title}</span>
          <small>{percent}%</small>
        </div>
        <button className="link" disabled={!info?.hasNext} onClick={() => view.current?.next()}>
          下一章
        </button>
      </footer>

      {narration !== 'stopped' && !sel && (
        <div className="narrate" role="group" aria-label="听读控制">
          <button className="icon-btn" onClick={() => narrator.current?.skip(-1)} aria-label="上一句">
            <Icon name="prev" />
          </button>
          <button
            className="icon-btn play"
            onClick={() => (narration === 'playing' ? narrator.current?.pause() : narrator.current?.resume())}
            aria-label={narration === 'playing' ? '暂停' : '继续'}
          >
            <Icon name={narration === 'playing' ? 'pause' : 'play'} filled />
          </button>
          <button className="icon-btn" onClick={() => narrator.current?.skip(1)} aria-label="下一句">
            <Icon name="next" />
          </button>
          <div className="narrate-rate">
            <button onClick={() => setRate(-0.05)} aria-label="放慢">
              −
            </button>
            <span>{settings.speechRate.toFixed(2)}×</span>
            <button onClick={() => setRate(0.05)} aria-label="加快">
              +
            </button>
          </div>
          <button className="icon-btn" onClick={() => narrator.current?.stop()} aria-label="结束听读">
            <Icon name="close" size={20} />
          </button>
        </div>
      )}

      {recap && !sel && narration === 'stopped' && (
        <button className="recap" onClick={() => openDeck(`回顾 · ${recap.chapter}`, recap.items)}>
          回顾上一章的 {recap.items.length} 个生词
        </button>
      )}

      {panel === 'toc' && (
        <Sheet title="目录" onClose={() => setPanel(null)}>
          <div className="toc">
            {toc.length === 0 && <div className="muted pad">这本书没有目录</div>}
            {toc.map((item, i) => (
              <button
                key={i}
                className={'toc-item' + (item.target === info?.tocTarget ? ' current' : '')}
                style={{ paddingLeft: 20 + item.level * 16 }}
                onClick={() => {
                  narrator.current?.stop();
                  view.current?.goTo(item.target);
                  setPanel(null);
                  setChrome(false);
                }}
              >
                {item.label}
              </button>
            ))}
          </div>
        </Sheet>
      )}

      {panel === 'aa' && (
        <Sheet onClose={() => setPanel(null)}>
          <div className="aa">
            <div className="aa-row">
              <button className="aa-step small" disabled={settings.fontSize <= FONT_MIN} onClick={() => setFont(-1)} aria-label="减小字号">
                A
              </button>
              <span className="aa-size">{settings.fontSize}</span>
              <button className="aa-step" disabled={settings.fontSize >= FONT_MAX} onClick={() => setFont(1)} aria-label="增大字号">
                A
              </button>
            </div>
            <div className="segmented">
              {THEMES.map((t) => (
                <button key={t.value} className={settings.theme === t.value ? 'on' : ''} onClick={() => updateSettings({ theme: t.value })}>
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </Sheet>
      )}

      {panel === 'vocab' && (
        <Sheet title="生词本" onClose={() => setPanel(null)}>
          {mine.length === 0 ? (
            <div className="pad muted">这本书里还没有查过词。翻译或讲解过的词句会自动记在这里，并在正文里标出来。</div>
          ) : (
            <div className="toc">
              {unknown.length > 0 && (
                <button className="row" onClick={() => openDeck(`复习 · ${book.meta.title}`, unknown)}>
                  复习这本书里还不熟的 {unknown.length} 个
                </button>
              )}
              {groups.map((g) => (
                <div key={g.chapter}>
                  <div className="vocab-head">
                    <span>{g.chapter}</span>
                    {g.items.some((l) => !l.known) && (
                      <button className="link" onClick={() => openDeck(`回顾 · ${g.chapter}`, g.items.filter((l) => !l.known))}>
                        回顾
                      </button>
                    )}
                  </div>
                  {g.items.map((l) => (
                    <button
                      key={l.id}
                      className={'vocab-item' + (l.known ? ' known' : '')}
                      onClick={() => {
                        setPanel(null);
                        pinned.current = true;
                        setSel({ text: l.text, context: l.context, loc: l.loc, recall: true });
                      }}
                    >
                      <span lang="en">{l.text}</span>
                      {l.known && <small>已认识</small>}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          )}
        </Sheet>
      )}

      {sel && (
        <StudySheet
          key={sel.loc + '|' + sel.text}
          sel={sel}
          bookId={bookId}
          bookTitle={book.meta.title}
          chapter={chapterNow}
          autoOpen={sel.recall}
          onClose={() => setSel(null)}
          onTouch={() => (pinned.current = true)}
          onLookup={refreshLookups}
        />
      )}

      {deck && (
        <ReviewDeck
          title={deck.title}
          items={deck.items}
          onMark={(item, known) => {
            const l = lookups.find((x) => x.id === item.id);
            if (l) putLookup({ ...l, known }).then(refreshLookups);
          }}
          onClose={() => setDeck(null)}
        />
      )}
    </div>
  );
}
