import { useEffect, useMemo, useRef, useState } from 'react';
import type { BookMeta, Favorite, Lookup, Progress } from '../types';
import { ReviewDeck, type ReviewItem } from '../components/ReviewDeck';
import { StudySheet } from '../components/StudySheet';
import { Icon, Sheet, toast } from '../components/ui';
import { deleteBook, listBooks, listFavorites, listLookups, listProgress, putBookMeta, putFavorite, putLookup, requestPersist } from '../lib/db';
import { importFiles } from '../lib/importer';
import { REMOTE_EVENT } from '../lib/sync';
import { formatDate } from '../lib/util';

interface Props {
  onOpen(bookId: string, loc?: string): void;
  onSettings(): void;
}

/** 读到这个比例就算读完（书末通常还有几页附录和版权页） */
const FINISHED = 0.93;

type Entry = { kind: 'book'; book: BookMeta; at: number } | { kind: 'series'; name: string; books: BookMeta[]; at: number };

const recency = (b: BookMeta) => Math.max(b.lastReadAt, b.addedAt);
const byIndex = (a: BookMeta, b: BookMeta) =>
  (a.seriesIndex ?? 9999) - (b.seriesIndex ?? 9999) || a.title.localeCompare(b.title, undefined, { numeric: true });

export function Shelf({ onOpen, onSettings }: Props) {
  const [tab, setTab] = useState<'books' | 'favorites'>(() => (sessionStorage.getItem('cr.shelfTab') === 'favorites' ? 'favorites' : 'books'));
  const [books, setBooks] = useState<BookMeta[] | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [favorites, setFavorites] = useState<Favorite[]>([]);
  const [busy, setBusy] = useState('');
  const [openSeries, setOpenSeries] = useState(() => sessionStorage.getItem('cr.series') || '');
  const [menu, setMenu] = useState<BookMeta | null>(null);
  const [seriesMenu, setSeriesMenu] = useState(false);
  const [active, setActive] = useState<Favorite | null>(null);
  const [lookups, setLookups] = useState<Lookup[]>([]);
  const [deck, setDeck] = useState<{ kind: 'favorite' | 'lookup'; title: string; items: ReviewItem[] } | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    const [b, p, f, l] = await Promise.all([listBooks(), listProgress(), listFavorites(), listLookups()]);
    setLookups(l);
    setBooks(b);
    setProgress(Object.fromEntries(p.map((x) => [x.bookId, x])));
    setFavorites(f);
  };
  useEffect(() => {
    refresh();
    // 云同步拉下了其他设备的改动
    window.addEventListener(REMOTE_EVENT, refresh);
    return () => window.removeEventListener(REMOTE_EVENT, refresh);
  }, []);
  useEffect(() => sessionStorage.setItem('cr.shelfTab', tab), [tab]);
  useEffect(() => sessionStorage.setItem('cr.series', openSeries), [openSeries]);

  const entries = useMemo<Entry[]>(() => {
    const groups = new Map<string, BookMeta[]>();
    const out: Entry[] = [];
    for (const b of books || []) {
      if (!b.series) out.push({ kind: 'book', book: b, at: recency(b) });
      else groups.set(b.series, [...(groups.get(b.series) || []), b]);
    }
    for (const [name, list] of groups) {
      out.push({ kind: 'series', name, books: list.sort(byIndex), at: Math.max(...list.map(recency)) });
    }
    return out.sort((a, b) => b.at - a.at);
  }, [books]);

  // 收藏按 书 → 章节 分组
  const favGroups = useMemo(() => {
    const out: { title: string; chapters: { name: string; items: Favorite[] }[] }[] = [];
    for (const f of favorites) {
      let book = out.find((b) => b.title === f.bookTitle);
      if (!book) out.push((book = { title: f.bookTitle, chapters: [] }));
      const name = f.chapter || '';
      let ch = book.chapters.find((c) => c.name === name);
      if (!ch) book.chapters.push((ch = { name, items: [] }));
      ch.items.push(f);
    }
    return out;
  }, [favorites]);
  const pendingLookups = useMemo(() => lookups.filter((l) => !l.known), [lookups]);
  const source = (x: { bookTitle: string; chapter?: string }) => [x.bookTitle, x.chapter].filter(Boolean).join(' · ');
  const favItem = (f: Favorite): ReviewItem => ({ id: f.id, text: f.text, context: f.context, source: source(f) });
  const lookupItem = (l: Lookup): ReviewItem => ({ id: l.id, text: l.text, context: l.context, source: source(l) });

  const seriesNames = useMemo(() => entries.flatMap((e) => (e.kind === 'series' ? [e.name] : [])), [entries]);
  const current = entries.find((e): e is Extract<Entry, { kind: 'series' }> => e.kind === 'series' && e.name === openSeries);
  const pct = (b: BookMeta) => progress[b.id]?.percent ?? 0;
  const finished = (b: BookMeta) => pct(b) >= FINISHED;

  /** 系列里接下来该读哪一本：先接着读没读完的，否则读完的最后一本之后的那本 */
  const nextUp = (list: BookMeta[]): BookMeta => {
    const reading = list.filter((b) => b.lastReadAt && !finished(b)).sort((a, b) => b.lastReadAt - a.lastReadAt)[0];
    if (reading) return reading;
    let last = -1;
    list.forEach((b, i) => finished(b) && (last = i));
    return list[last + 1] || list.find((b) => !finished(b)) || list[0];
  };

  const onFiles = async (list: FileList | null) => {
    if (!list?.length) return;
    requestPersist();
    const result = await importFiles(Array.from(list), (done, total, name) =>
      setBusy(total > 1 ? `正在导入 ${done + 1}/${total}：${name}` : `正在导入《${name}》…`)
    );
    setBusy('');
    if (input.current) input.current.value = '';
    if (result.errors.length) {
      const first = result.errors[0];
      toast(result.errors.length > 1 ? `${result.errors.length} 个文件导入失败，例如 ${first.name}：${first.message}` : `${first.name}：${first.message}`);
    }
    if (result.imported.length) {
      setTab('books');
      const series = new Set(result.imported.map((b) => b.series).filter(Boolean));
      if (result.imported.length > 1 && series.size === 1) toast(`已导入 ${result.imported.length} 本，归入「${[...series][0]}」`);
      refresh();
    }
  };

  const removeBook = async (b: BookMeta) => {
    await deleteBook(b.id);
    setMenu(null);
    refresh();
  };

  const hasBook = (id: string) => Boolean(books?.some((b) => b.id === id));

  const cover = (b: BookMeta) =>
    b.cover ? (
      <img src={b.cover} alt="" />
    ) : (
      <span className="book-fallback">
        <b>{b.title}</b>
        <i>{b.format.toUpperCase()}</i>
      </span>
    );

  // ---------- 系列详情 ----------
  if (current && tab === 'books') {
    const target = nextUp(current.books);
    const doneCount = current.books.filter(finished).length;
    const started = pct(target) > 0;
    return (
      <div className="page">
        <header className="page-head">
          <button className="icon-btn" onClick={() => setOpenSeries('')} aria-label="返回书架">
            <Icon name="back" />
          </button>
          <h1 className="series-name">{current.name}</h1>
          <button className="icon-btn" onClick={() => setSeriesMenu(true)} aria-label="系列操作">
            <Icon name="more" />
          </button>
        </header>
        <main className="page-body">
          <button className="continue" onClick={() => onOpen(target.id)}>
            <span className="continue-cover">{cover(target)}</span>
            <span className="continue-text">
              <small>{started ? '继续阅读' : '开始阅读'}</small>
              <b>
                {target.seriesIndex != null ? `#${target.seriesIndex} ` : ''}
                {target.title}
              </b>
              <small>
                已读完 {doneCount} / {current.books.length} 本{started ? ` · 本册 ${Math.round(pct(target) * 100)}%` : ''}
              </small>
            </span>
          </button>
          <ul className="volumes">
            {current.books.map((b) => (
              <li key={b.id} className={b.id === target.id ? 'next' : ''}>
                <button className="volume" onClick={() => onOpen(b.id)}>
                  <span className="volume-no">{b.seriesIndex ?? '·'}</span>
                  <span className="volume-title">{b.title}</span>
                  <span className={'volume-state' + (finished(b) ? ' done' : '')}>
                    {finished(b) ? '已读' : pct(b) > 0 ? `${Math.round(pct(b) * 100)}%` : ''}
                  </span>
                </button>
                <button className="icon-btn mini" onClick={() => setMenu(b)} aria-label={`${b.title} 的更多操作`}>
                  <Icon name="more" size={18} />
                </button>
              </li>
            ))}
          </ul>
        </main>
        {menu && <BookSheet book={menu} seriesNames={seriesNames} onClose={() => setMenu(null)} onChanged={refresh} onDelete={() => removeBook(menu)} />}
        {seriesMenu && (
          <SeriesSheet
            name={current.name}
            books={current.books}
            onClose={() => setSeriesMenu(false)}
            onRenamed={(name) => {
              setOpenSeries(name);
              refresh();
            }}
            onDeleted={() => {
              setOpenSeries('');
              refresh();
            }}
          />
        )}
      </div>
    );
  }

  // ---------- 书架 ----------
  return (
    <div className="page">
      <header className="page-head">
        <h1>书架</h1>
        <button className="icon-btn" onClick={() => input.current?.click()} aria-label="导入书籍">
          <Icon name="plus" />
        </button>
        <button className="icon-btn" onClick={onSettings} aria-label="设置">
          <Icon name="gear" />
        </button>
        <input ref={input} type="file" hidden multiple accept=".epub,.txt,application/epub+zip,text/plain" onChange={(e) => onFiles(e.target.files)} />
      </header>

      <div className="segmented shelf-tabs">
        <button className={tab === 'books' ? 'on' : ''} onClick={() => setTab('books')}>
          书籍
        </button>
        <button className={tab === 'favorites' ? 'on' : ''} onClick={() => setTab('favorites')}>
          收藏{favorites.length ? ` ${favorites.length}` : ''}
        </button>
      </div>

      {busy && <div className="banner">{busy}</div>}

      <main className="page-body">
        {tab === 'books' && books && books.length === 0 && (
          <div className="empty">
            <p>还没有书。</p>
            <p className="muted">导入无加密的 EPUB 或 TXT 文件，可以一次多选。文件名形如「01 - 书名」的书会自动归成一个系列。</p>
            <button className="btn" onClick={() => input.current?.click()}>
              导入书籍
            </button>
          </div>
        )}

        {tab === 'books' && entries.length > 0 && (
          <div className="grid">
            {entries.map((e) => {
              if (e.kind === 'series') {
                const target = nextUp(e.books);
                const doneCount = e.books.filter(finished).length;
                return (
                  <div className="book" key={'s:' + e.name}>
                    <button className="book-cover stack" onClick={() => setOpenSeries(e.name)} aria-label={`打开系列 ${e.name}`}>
                      {cover(target)}
                      <span className="stack-count">{e.books.length} 本</span>
                    </button>
                    <div className="book-meta">
                      <div className="book-title">{e.name}</div>
                      <div className="book-sub">
                        <span>
                          已读 {doneCount}/{e.books.length}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              }
              const b = e.book;
              return (
                <div className="book" key={b.id}>
                  <button className="book-cover" onClick={() => onOpen(b.id)} aria-label={`打开 ${b.title}`}>
                    {cover(b)}
                  </button>
                  <div className="book-meta">
                    <div className="book-title">{b.title}</div>
                    <div className="book-sub">
                      <span>{finished(b) ? '已读' : pct(b) > 0 ? `${Math.round(pct(b) * 100)}%` : '未读'}</span>
                      <button className="icon-btn mini" onClick={() => setMenu(b)} aria-label={`${b.title} 的更多操作`}>
                        <Icon name="more" size={18} />
                      </button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {tab === 'favorites' && favorites.length === 0 && (
          <div className="empty">
            <p>还没有收藏。</p>
            <p className="muted">阅读时长按选中单词或句子，在弹窗里点「收藏」。</p>
          </div>
        )}

        {tab === 'favorites' && (favorites.length > 0 || pendingLookups.length > 0) && (
          <div className="review-entry">
            {favorites.length > 0 && (
              <button
                className="review-btn"
                onClick={() => {
                  const todo = favorites.filter((f) => !f.known);
                  setDeck({ kind: 'favorite', title: '复习收藏', items: (todo.length ? todo : favorites).map(favItem) });
                }}
              >
                <b>复习收藏</b>
                <small>
                  {favorites.filter((f) => !f.known).length} 条待复习 · 共 {favorites.length} 条
                </small>
              </button>
            )}
            {pendingLookups.length > 0 && (
              <button className="review-btn" onClick={() => setDeck({ kind: 'lookup', title: '复习查过的词句', items: pendingLookups.map(lookupItem) })}>
                <b>复习查过的词句</b>
                <small>{pendingLookups.length} 个还不熟</small>
              </button>
            )}
          </div>
        )}

        {tab === 'favorites' &&
          favGroups.map((book) => (
            <section className="fav-book" key={book.title}>
              <h2>{book.title}</h2>
              {book.chapters.map((ch) => (
                <div key={ch.name}>
                  {ch.name && <div className="fav-chapter">{ch.name}</div>}
                  <ul className="favs">
                    {ch.items.map((f) => (
                      <li key={f.id}>
                        <button onClick={() => setActive(f)}>
                          <span className={'fav-text' + (f.known ? ' known' : '')} lang="en">
                            {f.text}
                          </span>
                          <span className="fav-sub">
                            {formatDate(f.createdAt)}
                            {f.known ? ' · 已认识' : ''}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </section>
          ))}
      </main>

      {deck && (
        <ReviewDeck
          title={deck.title}
          items={deck.items}
          onMark={async (item, known) => {
            if (deck.kind === 'favorite') {
              const f = favorites.find((x) => x.id === item.id);
              if (f) await putFavorite({ ...f, known });
            } else {
              const l = lookups.find((x) => x.id === item.id);
              if (l) await putLookup({ ...l, known });
            }
          }}
          onClose={() => {
            setDeck(null);
            refresh();
          }}
        />
      )}

      {menu && <BookSheet book={menu} seriesNames={seriesNames} onClose={() => setMenu(null)} onChanged={refresh} onDelete={() => removeBook(menu)} />}

      {active && (
        <StudySheet
          key={active.id}
          modal
          sel={{ text: active.text, context: active.context, loc: active.loc }}
          bookId={active.bookId}
          bookTitle={active.bookTitle}
          onClose={() => setActive(null)}
          onFavoriteChange={refresh}
          onJump={hasBook(active.bookId) && active.loc ? () => onOpen(active.bookId, active.loc) : undefined}
        />
      )}
    </div>
  );
}

/** 单本书的操作：改系列/序号、删除 */
function BookSheet(props: { book: BookMeta; seriesNames: string[]; onClose(): void; onChanged(): void; onDelete(): void }) {
  const { book } = props;
  const [series, setSeries] = useState(book.series || '');
  const [index, setIndex] = useState(book.seriesIndex != null ? String(book.seriesIndex) : '');
  const dirty = series.trim() !== (book.series || '') || index.trim() !== (book.seriesIndex != null ? String(book.seriesIndex) : '');

  const save = async () => {
    const n = Number(index);
    await putBookMeta({
      ...book,
      series: series.trim() || undefined,
      seriesIndex: index.trim() && Number.isFinite(n) ? n : undefined,
    });
    props.onChanged();
    props.onClose();
  };

  return (
    <Sheet title={book.title} onClose={props.onClose}>
      <div className="pad muted small">
        {book.author ? `${book.author} · ` : ''}
        {book.format.toUpperCase()} · {(book.size / 1024 / 1024).toFixed(1)} MB
      </div>
      <div className="sheet-form">
        <label className="field grow">
          <span>所属系列</span>
          <input type="text" value={series} list="series-names" placeholder="不属于系列则留空" onChange={(e) => setSeries(e.target.value)} />
          <datalist id="series-names">
            {props.seriesNames.map((n) => (
              <option key={n} value={n} />
            ))}
          </datalist>
        </label>
        <label className="field narrow">
          <span>序号</span>
          <input type="number" inputMode="numeric" value={index} onChange={(e) => setIndex(e.target.value)} />
        </label>
      </div>
      {dirty && (
        <button className="row" onClick={save}>
          保存
        </button>
      )}
      <button className="row danger" onClick={props.onDelete}>
        删除这本书（所有设备）
      </button>
      <div className="pad muted small">阅读进度和收藏会保留，重新导入同一文件后可继续。</div>
    </Sheet>
  );
}

/** 整个系列的操作：改名、解散、全部删除 */
function SeriesSheet(props: { name: string; books: BookMeta[]; onClose(): void; onRenamed(name: string): void; onDeleted(): void }) {
  const [name, setName] = useState(props.name);
  const [confirm, setConfirm] = useState(false);

  const apply = async (series: string | undefined) => {
    for (const b of props.books) await putBookMeta({ ...b, series });
  };

  return (
    <Sheet title="系列" onClose={props.onClose}>
      <div className="sheet-form">
        <label className="field grow">
          <span>系列名称</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
      </div>
      {name.trim() && name.trim() !== props.name && (
        <button
          className="row"
          onClick={async () => {
            await apply(name.trim());
            props.onRenamed(name.trim());
            props.onClose();
          }}
        >
          保存名称
        </button>
      )}
      <button
        className="row"
        onClick={async () => {
          await apply(undefined);
          props.onDeleted();
          props.onClose();
        }}
      >
        解散系列（书保留在书架上）
      </button>
      <button
        className="row danger"
        onClick={async () => {
          if (!confirm) return setConfirm(true);
          for (const b of props.books) await deleteBook(b.id);
          props.onDeleted();
          props.onClose();
        }}
      >
        {confirm ? `再点一次，确认删除这 ${props.books.length} 本书` : `删除整个系列（${props.books.length} 本，所有设备）`}
      </button>
      <div className="pad muted small">阅读进度和收藏会保留。</div>
    </Sheet>
  );
}
