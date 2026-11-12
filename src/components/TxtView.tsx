import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ViewHandle, ViewProps } from '../types';
import { buildTermRegex, findMarks, MARK, markAt, READING, setHighlight, type Mark } from '../lib/marks';
import { parseTxt } from '../lib/txt';
import { readSelection } from '../lib/util';
import { SHEET_SPACE } from './EpubView';

/**
 * TXT 阅读：连续滚动。只渲染 [first, last] 这一段章节，快到底时把下一章接在后面，
 * 回滚到顶部时把上一章接在前面。位置记为 "章:段:段内比例"。
 */
export const TxtView = forwardRef<ViewHandle, ViewProps>(function TxtView(props, ref) {
  const chapters = useMemo(() => parseTxt(props.data as string), [props.data]);
  const clamp = (n: number) => Math.min(chapters.length - 1, Math.max(0, n || 0));
  const [c0, p0, f0] = props.initialLoc.split(':').map(Number);
  const [range, setRange] = useState(() => ({ first: clamp(c0), last: clamp(c0) }));
  const pos = useRef({ c: clamp(c0), p: p0 || 0, f: f0 || 0 }); // 屏幕顶部所在的章、段、段内比例
  const pending = useRef<'jump' | 'prepend' | null>('jump');
  const heightBefore = useRef(0);
  const fontBefore = useRef(props.fontSize);
  const scroller = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const quietUntil = useRef(0);
  const lastTop = useRef(0);
  const timer = useRef(0);

  const report = () => {
    const el = scroller.current;
    if (!el) return;
    const sections = Array.from(el.querySelectorAll<HTMLElement>('section[data-c]'));
    let section = sections[0];
    for (const s of sections) if (s.offsetTop <= el.scrollTop + 8) section = s;
    if (!section) return;
    const c = Number(section.dataset.c);
    const items = section.querySelectorAll<HTMLElement>('[data-i]');
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[mid].offsetTop + items[mid].offsetHeight > el.scrollTop + 8) hi = mid;
      else lo = mid + 1;
    }
    const cur = items[lo];
    const f = cur ? Math.min(0.99, Math.max(0, (el.scrollTop - cur.offsetTop) / Math.max(1, cur.offsetHeight))) : 0;
    pos.current = { c, p: lo, f };
    const inChapter = Math.min(1, Math.max(0, (el.scrollTop - section.offsetTop) / Math.max(1, section.offsetHeight)));
    latest.current.onRelocate({
      loc: `${c}:${lo}:${f.toFixed(3)}`,
      percent: Math.min(1, (c + inChapter) / chapters.length),
      label: chapters[c].title,
      tocTarget: `${c}:0`,
      hasPrev: c > 0,
      hasNext: c < chapters.length - 1,
    });
  };

  /** 把记录的位置滚到屏幕顶部 */
  const place = () => {
    const el = scroller.current;
    if (!el) return;
    quietUntil.current = Date.now() + 900;
    const { c, p, f } = pos.current;
    const section = el.querySelector<HTMLElement>(`section[data-c="${c}"]`);
    const target = section?.querySelector<HTMLElement>(`[data-i="${p}"]`);
    if (!section) el.scrollTop = 0;
    else if (!target || (p === 0 && f === 0)) el.scrollTop = section.offsetTop;
    else el.scrollTop = target.offsetTop + f * target.offsetHeight;
    lastTop.current = el.scrollTop;
  };

  /** 按需接入相邻章节 */
  const extend = (scrollingUp = false) => {
    const el = scroller.current;
    if (!el || pending.current) return;
    if (range.last < chapters.length - 1 && el.scrollTop + el.clientHeight > el.scrollHeight - 1600) {
      setRange((r) => ({ ...r, last: Math.min(chapters.length - 1, r.last + 1) }));
    } else if (range.first > 0 && scrollingUp && el.scrollTop < 160 && Date.now() > quietUntil.current) {
      pending.current = 'prepend';
      heightBefore.current = el.scrollHeight;
      setRange((r) => ({ ...r, first: Math.max(0, r.first - 1) }));
    }
  };

  const jump = (c: number, p: number, f = 0) => {
    const next = clamp(c);
    pos.current = { c: next, p, f };
    pending.current = 'jump';
    // 目标章节已经在页面里就直接滚过去，否则从那一章重新开始渲染
    setRange((r) => (next >= r.first && next <= r.last ? { ...r } : { first: next, last: next }));
  };

  useImperativeHandle(ref, () => ({
    goTo: (t) => {
      const [c, p, f] = t.split(':').map(Number);
      jump(c, p || 0, f || 0);
    },
    next: () => pos.current.c < chapters.length - 1 && jump(pos.current.c + 1, 0),
    prev: () => pos.current.c > 0 && jump(pos.current.c - 1, 0),
    roots: () => Array.from(scroller.current?.querySelectorAll('section[data-c]') ?? []),
    scroller: () => scroller.current,
  }));

  // 生词标记：章节增减或生词表变化后重新登记
  const marks = useRef<Mark[]>([]);
  useEffect(() => {
    const roots = Array.from(scroller.current?.querySelectorAll('section[data-c]') ?? []);
    marks.current = findMarks(roots, buildTermRegex(props.terms));
    setHighlight(document, MARK, marks.current.map((m) => m.range));
  }, [range, chapters, props.terms]);
  useEffect(
    () => () => {
      setHighlight(document, MARK, []);
      setHighlight(document, READING, []);
    },
    []
  );

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const fontChanged = fontBefore.current !== props.fontSize;
    fontBefore.current = props.fontSize;
    if (pending.current === 'prepend') {
      // 上方多出一章：把滚动位置下移同样的高度，画面保持不动
      el.scrollTop += el.scrollHeight - heightBefore.current;
      lastTop.current = el.scrollTop;
    } else if (pending.current === 'jump' || fontChanged) {
      place();
    }
    pending.current = null;
    report();
    extend(); // 章节很短时继续补到够一屏
  }, [range, chapters, props.fontSize]);

  useEffect(() => {
    latest.current.onReady(chapters.map((c, i) => ({ label: c.title, target: `${i}:0`, level: 0 })));
  }, [chapters]);

  useEffect(() => {
    let t = 0;
    let had = false;
    const onChange = () => {
      clearTimeout(t);
      t = window.setTimeout(() => {
        const el = scroller.current;
        const r = readSelection(window);
        if (!r) {
          if (had) latest.current.onSelect(null);
          had = false;
          return;
        }
        if (!el || !el.contains(r.range.commonAncestorContainer)) return; // 弹窗里的选区不算
        const start = r.range.startContainer;
        const node = start.nodeType === 1 ? (start as Element) : start.parentElement;
        const holder = node?.closest<HTMLElement>('[data-i]');
        const section = node?.closest<HTMLElement>('section[data-c]');
        if (!had) {
          const bottom = r.range.getBoundingClientRect().bottom;
          const limit = window.innerHeight - SHEET_SPACE;
          if (bottom > limit) el.scrollBy({ top: bottom - limit + 16, behavior: 'smooth' });
        }
        had = true;
        latest.current.onSelect({ ...r.info, loc: `${section?.dataset.c ?? pos.current.c}:${holder?.dataset.i ?? 0}` });
      }, 350);
    };
    document.addEventListener('selectionchange', onChange);
    return () => {
      clearTimeout(t);
      document.removeEventListener('selectionchange', onChange);
    };
  }, []);

  const onScroll = () => {
    const el = scroller.current!;
    const up = el.scrollTop < lastTop.current;
    if (el.scrollTop > lastTop.current + 6 && Date.now() > quietUntil.current) latest.current.onScrollDown();
    lastTop.current = el.scrollTop;
    clearTimeout(timer.current);
    timer.current = window.setTimeout(report, 150);
    extend(up);
  };

  const onClick = (e: { clientX: number; clientY: number }) => {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const hit = markAt(document, e.clientX, e.clientY, marks.current);
    if (hit) latest.current.onRecall(hit.term);
    else latest.current.onTap();
  };

  const shown = [];
  for (let c = range.first; c <= range.last; c++) shown.push(c);

  return (
    <div className="txt-scroll" ref={scroller} onScroll={onScroll} onClick={onClick} style={{ fontSize: props.fontSize }}>
      {shown.map((c) => (
        <section key={c} data-c={c} className="txt-body selectable" lang="en">
          {chapters[c].paras.map((p, i) =>
            i === 0 && p === chapters[c].title ? (
              <h2 key={i} data-i={i}>
                {p}
              </h2>
            ) : (
              <p key={i} data-i={i}>
                {p}
              </p>
            )
          )}
        </section>
      ))}
      <div style={{ height: 64 }} aria-hidden />
    </div>
  );
});
