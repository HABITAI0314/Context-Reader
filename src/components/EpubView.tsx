import ePub from 'epubjs';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { ThemeName, TocItem, ViewHandle, ViewProps } from '../types';
import { buildTermRegex, findMarks, highlightCss, MARK, markAt, setHighlight, type Mark } from '../lib/marks';
import { READING_FONT, readSelection, THEME_COLORS } from '../lib/util';

/** 选词弹窗（收起状态）大致占用的底部高度，用来把被挡住的选区滚上来 */
export const SHEET_SPACE = 200;

function readerCss(theme: ThemeName, fontSize: number): string {
  const c = THEME_COLORS[theme];
  const recolor =
    theme === 'light' ? '' : `body *{color:inherit !important;background-color:transparent !important;border-color:currentColor !important;}`;
  return `
html{-webkit-text-size-adjust:100% !important;text-size-adjust:100% !important;}
body{box-sizing:border-box !important;margin:0 auto !important;max-width:720px !important;padding:56px 22px 0 !important;
  font-family:${READING_FONT};font-size:${fontSize}px !important;line-height:1.75 !important;
  color:${c.fg} !important;background:${c.bg} !important;overflow-wrap:break-word;
  -webkit-tap-highlight-color:transparent;-webkit-user-select:text;user-select:text;}
p,li,blockquote,dd{font-size:1em !important;line-height:inherit !important;}
h1,h2,h3,h4,h5,h6{line-height:1.3 !important;}
img,svg,video{max-width:100% !important;height:auto !important;}
pre{white-space:pre-wrap;}
${recolor}
a{color:${c.accent} !important;}
::selection{background:${c.selection};}
${highlightCss(c.accent, c.mark, c.read)}
`;
}

/** 用 epub.js 渲染：上下滚动，快到章末时自动把下一章接在下面 */
export const EpubView = forwardRef<ViewHandle, ViewProps>(function EpubView(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  const api = useRef<{
    goTo(t: string): void;
    step(d: number): void;
    restyle(): void;
    remark(): void;
    roots(): Element[];
    scroller(): HTMLElement | null;
  } | null>(null);

  useImperativeHandle(ref, () => ({
    goTo: (t) => api.current?.goTo(t),
    next: () => api.current?.step(1),
    prev: () => api.current?.step(-1),
    roots: () => api.current?.roots() ?? [],
    scroller: () => api.current?.scroller() ?? null,
  }));

  useEffect(() => {
    let dead = false;
    const book: any = ePub(props.data as ArrayBuffer);

    // 书内脚本一律移除：iframe 需要 allow-scripts 才能在 iOS Safari 上收到触摸/选区事件，
    // 所以在内容进入 iframe 之前先把可执行的东西清掉。
    book.spine.hooks.content.register((doc: Document) => {
      doc.querySelectorAll('script').forEach((s) => s.remove());
      doc.querySelectorAll('*').forEach((el) => {
        for (const a of Array.from(el.attributes)) {
          if (/^on/i.test(a.name) || /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
        }
      });
      // 阅读样式在排版之前就放进文档：这样章节第一次量出来的高度就是最终高度，
      // 恢复到章节后半部分时不会因为"高度还没撑开"而停在错误的位置。
      const XHTML = 'http://www.w3.org/1999/xhtml';
      const style = doc.createElementNS(XHTML, 'style');
      style.setAttribute('id', 'cr-style');
      style.textContent = readerCss(latest.current.theme, latest.current.fontSize);
      (doc.querySelector('head') || doc.documentElement).appendChild(style);
      const body = doc.querySelector('body');
      if (body) {
        const spacer = doc.createElementNS(XHTML, 'div'); // 章末留白
        spacer.setAttribute('style', 'height:64px');
        spacer.setAttribute('aria-hidden', 'true');
        body.appendChild(spacer);
      }
    });

    const rendition: any = book.renderTo(host.current!, {
      width: '100%',
      height: '100%',
      flow: 'scrolled-doc',
      allowScriptedContent: true,
    });

    let toc: (TocItem & { index: number })[] = [];
    let index = 0;
    let cfi = props.initialLoc;
    let hadSelection = false;
    let quietUntil = 0;
    let lastTop = 0;
    let reportTimer = 0;
    let locateTimer = 0;
    // 每个章节文档里的生词标记
    const marks = new Map<Document, Mark[]>();
    const markDoc = (doc: Document) => {
      if (!doc.body) return;
      const found = findMarks([doc.body], buildTermRegex(latest.current.terms));
      marks.set(doc, found);
      setHighlight(doc, MARK, found.map((m) => m.range));
    };
    let loading = false; // 正在接入相邻章节
    const container = (): HTMLElement | undefined => rendition.manager?.container;

    const findSection = (href: string) => {
      const path = href.split('#')[0];
      const direct = book.spine.get(path);
      if (direct) return direct;
      const name = path.split('/').pop();
      return (book.spine.spineItems as any[]).find((s) => s.href && s.href.split('/').pop() === name) || null;
    };

    // 程序触发的跳转不算"用户向下滚动"，跳转完成后的一小段时间内忽略滚动方向
    const settle = () => {
      quietUntil = Date.now() + 700;
      lastTop = container()?.scrollTop ?? 0;
    };
    /**
     * 连续滚动：离底部不远时把下一章接在后面（内容加在下方，不会让当前位置跳动）；
     * 回滚到已加载内容的顶部时，把上一章接在前面（epub.js 会按新增高度补偿滚动位置）。
     */
    const extend = (scrollingUp = false) => {
      const c = container();
      const views = rendition.manager?.views;
      if (dead || loading || !c || !views?.length) return;
      const next = views.last()?.section?.next?.();
      const prev = views.first()?.section?.prev?.();
      let task: Promise<unknown> | null = null;
      if (next && c.scrollTop + c.clientHeight > c.scrollHeight - 1600) task = rendition.manager.append(next);
      else if (prev && scrollingUp && c.scrollTop < 160 && Date.now() > quietUntil) task = rendition.manager.prepend(prev);
      if (!task) return;
      loading = true;
      const done = () => {
        loading = false;
        // epub.js 新建的章节默认是隐藏的，自己接入的要手动显示出来
        try {
          rendition.manager?.views?.show();
        } catch {}
        scheduleReport();
        window.setTimeout(() => extend(), 60); // 很短的章节：继续补到够一屏
      };
      task.then(done, done);
    };

    const show = (target?: string): Promise<void> => {
      quietUntil = Date.now() + 5000;
      loading = false; // 跳转会清空已加载的章节
      const after = () => {
        settle();
        extend();
      };
      return rendition.display(target || undefined).then(after, (e: unknown) => {
        after();
        throw e;
      });
    };

    const report = () => {
      if (dead) return;
      const c = container();
      const total = Math.max(1, book.spine.spineItems.length);
      // 当前章节在滚动容器里的位置，用来算章内进度
      const el: HTMLElement | undefined = rendition.manager?.views?.find({ index })?.element;
      const frac = c && el ? Math.min(1, Math.max(0, (c.scrollTop - el.offsetTop) / Math.max(1, el.offsetHeight))) : 0;
      let current: (TocItem & { index: number }) | undefined;
      for (const item of toc) if (item.index >= 0 && item.index <= index) current = item;
      latest.current.onRelocate({
        loc: cfi,
        percent: Math.min(1, (index + frac) / total),
        label: current?.label || '',
        tocTarget: current?.target || '',
        hasPrev: index > 0,
        hasNext: index < total - 1,
      });
    };
    const scheduleReport = () => {
      clearTimeout(reportTimer);
      reportTimer = window.setTimeout(report, 150);
    };

    rendition.on('relocated', (loc: any) => {
      if (!loc?.start) return;
      cfi = loc.start.cfi;
      index = loc.start.index;
      scheduleReport();
    });

    rendition.hooks.content.register((contents: any) => {
      const doc: Document = contents.document;
      const win: Window = contents.window;
      // 章节文档可能是之前缓存的：把样式刷新成当前的字号和主题
      const style = doc.getElementById('cr-style');
      const css = readerCss(latest.current.theme, latest.current.fontSize);
      if (style && style.textContent !== css) style.textContent = css;
      markDoc(doc);

      let timer = 0;
      doc.addEventListener('selectionchange', () => {
        clearTimeout(timer);
        timer = window.setTimeout(() => {
          if (dead) return;
          const r = readSelection(win);
          if (!r) {
            hadSelection = false;
            latest.current.onSelect(null);
            return;
          }
          let loc = '';
          try {
            loc = contents.cfiFromRange(r.range);
          } catch {}
          if (!hadSelection && win.frameElement) {
            // 第一次出现选区时，如果它会被底部弹窗挡住，就把正文往上滚一点
            const bottom = win.frameElement.getBoundingClientRect().top + r.range.getBoundingClientRect().bottom;
            const limit = window.innerHeight - SHEET_SPACE;
            if (bottom > limit) container()?.scrollBy({ top: bottom - limit + 16, behavior: 'smooth' });
          }
          hadSelection = true;
          latest.current.onSelect({ ...r.info, loc });
        }, 350);
      });

      doc.addEventListener('click', (e) => {
        if ((e.target as Element | null)?.closest?.('a')) return;
        const sel = win.getSelection();
        if (sel && !sel.isCollapsed) return;
        // 点在标记过的生词上：直接调出之前查过的释义
        const hit = markAt(doc, e.clientX, e.clientY, marks.get(doc) || []);
        if (hit) latest.current.onRecall(hit.term);
        else latest.current.onTap();
      });
    });

    book.loaded.navigation
      .then((nav: any) => {
        const flat: (TocItem & { index: number })[] = [];
        const walk = (items: any[], level: number) => {
          for (const it of items || []) {
            const section = findSection(it.href || '');
            flat.push({ label: (it.label || '').trim() || '（无标题）', target: it.href, level, index: section ? section.index : -1 });
            walk(it.subitems, level + 1);
          }
        };
        walk(nav?.toc, 0);
        toc = flat;
      })
      .catch(() => {})
      .then(() => {
        if (dead) return;
        latest.current.onReady(toc);
        scheduleReport();
      });

    show(props.initialLoc)
      .catch(() => show())
      .then(() => {
        if (dead) return;
        const c = container();
        c?.addEventListener(
          'scroll',
          () => {
            const top = c.scrollTop;
            const up = top < lastTop;
            if (top > lastTop + 6 && Date.now() > quietUntil) latest.current.onScrollDown();
            lastTop = top;
            scheduleReport();
            extend(up);
            // epub.js 偶尔会漏掉一次滚动事件，停下后主动让它重新计算当前位置
            clearTimeout(locateTimer);
            locateTimer = window.setTimeout(() => !dead && rendition.reportLocation(), 250);
          },
          { passive: true }
        );
        scheduleReport();
      })
      .catch(() => !dead && latest.current.onError('无法打开这本书'));

    const docs = (): Document[] =>
      ((rendition.manager?.views?.all?.() as any[]) || []).map((v) => v?.contents?.document).filter((d): d is Document => Boolean(d?.body));

    api.current = {
      remark: () => docs().forEach(markDoc),
      roots: () => docs().map((d) => d.body),
      scroller: () => container() ?? null,
      goTo(target) {
        const hash = target.includes('#') ? '#' + target.split('#')[1] : '';
        const section = target.startsWith('epubcfi(') ? null : findSection(target);
        show(section ? section.href + hash : target).catch(() => section && show(section.href));
      },
      step(d) {
        const section = book.spine.get(index + d);
        if (section) show(section.href);
      },
      restyle() {
        // 字号/主题变化：原地替换样式，等版面重排后回到原来的位置
        const at = cfi;
        const css = readerCss(latest.current.theme, latest.current.fontSize);
        for (const contents of rendition.getContents() as any[]) {
          const style = contents.document?.getElementById('cr-style');
          if (style) style.textContent = css;
        }
        for (const delay of [120, 500]) {
          window.setTimeout(() => !dead && at && show(at).catch(() => {}), delay);
        }
      },
    };

    return () => {
      dead = true;
      api.current = null;
      clearTimeout(reportTimer);
      try {
        book.destroy();
      } catch {}
    };
  }, [props.data]);

  useEffect(() => {
    api.current?.remark();
  }, [props.terms]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) first.current = false;
    else api.current?.restyle();
  }, [props.theme, props.fontSize]);

  return <div className="epub-host" ref={host} />;
});
