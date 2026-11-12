import { useEffect, useRef, useState } from 'react';
import type { AiAction, Explanation, SelectionInfo } from '../types';
import { askAi, getCachedAi } from '../lib/ai';
import { deleteFavorite, getFavorite, putFavorite, putLookup } from '../lib/db';
import { useSettings } from '../lib/settings';
import { speak, speechSupported, stopSpeaking } from '../lib/speech';
import { hashString, normTerm } from '../lib/util';
import { Icon } from './ui';

const MAX_TEXT = 1500;

interface Props {
  sel: SelectionInfo;
  bookId: string;
  bookTitle: string;
  /** 当前章节名，随生词和收藏一起记下 */
  chapter?: string;
  onClose(): void;
  /** 用户碰过弹窗后通知阅读页：之后即使选区消失（iOS 点按钮时可能清掉选区）也不自动关闭 */
  onTouch?(): void;
  /** 显示遮罩（收藏列表里使用） */
  modal?: boolean;
  /** 打开时直接展示已有的讲解或翻译（回看生词、收藏时使用） */
  autoOpen?: boolean;
  onJump?(): void;
  onFavoriteChange?(): void;
  /** 新查了一个词句（阅读页据此更新正文里的标记） */
  onLookup?(): void;
}

type Results = { translate?: string; explain?: Explanation };

/** 讲解结果的正文，复习卡片也用它 */
export function ExplanationView({ data, showTranslation, onReveal }: { data: Explanation; showTranslation: boolean; onReveal(): void }) {
  return (
    <>
      {(data.phonetic || data.pos) && (
        <div className="study-word">
          {data.phonetic && <span lang="en">{data.phonetic}</span>}
          {data.pos && <i>{data.pos}</i>}
        </div>
      )}
      <div className="study-label">{data.phonetic || data.pos ? '词义' : '句意'}</div>
      <p className="study-para">{data.meaning}</p>
      {data.phrases.length > 0 && (
        <>
          <div className="study-label">{data.phonetic || data.pos ? '常见搭配' : '关键短语'}</div>
          <ul className="study-phrases">
            {data.phrases.map((p, i) => (
              <li key={i}>
                <b lang="en">{p.en}</b>
                <span>{p.zh}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {data.grammar && (
        <>
          <div className="study-label">语法</div>
          <p className="study-para">{data.grammar}</p>
        </>
      )}
      {data.translation &&
        (showTranslation ? (
          <>
            <div className="study-label">{data.phonetic || data.pos ? '原句译文' : '译文'}</div>
            <p className="study-para">{data.translation}</p>
          </>
        ) : (
          <button className="reveal" onClick={onReveal}>
            显示译文
          </button>
        ))}
    </>
  );
}

/** 选中文字后的底部弹窗：翻译、AI 讲解、朗读、收藏 */
export function StudySheet(props: Props) {
  const { sel, bookId, bookTitle, chapter = '', onClose, onTouch, modal, autoOpen, onJump, onFavoriteChange, onLookup } = props;
  const { speechRate } = useSettings();
  const [tab, setTab] = useState<AiAction | null>(null);
  const [results, setResults] = useState<Results>({});
  const [loading, setLoading] = useState<AiAction | null>(null);
  const [errors, setErrors] = useState<Partial<Record<AiAction, string>>>({});
  const [fav, setFav] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  const alive = useRef(true);
  const favId = hashString(`${bookId}\n${sel.text}`);
  const tooLong = sel.text.length > MAX_TEXT;

  useEffect(() => {
    alive.current = true;
    (async () => {
      const [t, e, f] = await Promise.all([
        getCachedAi('translate', sel.text, sel.context),
        getCachedAi('explain', sel.text, sel.context),
        getFavorite(favId),
      ]);
      if (!alive.current) return;
      setResults({ translate: t?.result as string | undefined, explain: e?.result as Explanation | undefined });
      setFav(Boolean(f));
      if (modal || autoOpen) setTab(e ? 'explain' : t ? 'translate' : null);
    })();
    return () => {
      alive.current = false;
      stopSpeaking();
    };
  }, []);

  const run = async (action: AiAction) => {
    setTab(action);
    if (results[action] || loading === action) return;
    setErrors((e) => ({ ...e, [action]: undefined }));
    setLoading(action);
    try {
      const result = await askAi(action, sel.text, sel.context);
      // 查过就记下来：正文里会标出这个词，章末可以回顾
      await putLookup({
        id: hashString(normTerm(sel.text)),
        bookId,
        bookTitle,
        text: sel.text,
        context: sel.context,
        loc: sel.loc,
        chapter,
        createdAt: Date.now(),
      });
      onLookup?.();
      if (alive.current) setResults((r) => ({ ...r, [action]: result }));
    } catch (e) {
      if (alive.current) setErrors((x) => ({ ...x, [action]: (e as Error).message }));
    } finally {
      if (alive.current) setLoading((l) => (l === action ? null : l));
    }
  };

  const toggleSpeak = () => {
    if (speaking) {
      stopSpeaking();
      setSpeaking(false);
    } else {
      setSpeaking(true);
      speak(sel.text, speechRate, () => alive.current && setSpeaking(false));
    }
  };

  const toggleFav = async () => {
    if (fav) await deleteFavorite(favId);
    else await putFavorite({ id: favId, bookId, bookTitle, text: sel.text, context: sel.context, loc: sel.loc, chapter, createdAt: Date.now() });
    setFav(!fav);
    onFavoriteChange?.();
  };

  const body = tab && (
    <div className="study-body selectable">
      {loading === tab && <div className="study-loading">正在{tab === 'translate' ? '翻译' : '讲解'}…</div>}
      {errors[tab] && loading !== tab && (
        <div className="study-error">
          {errors[tab]}
          <button className="link" onClick={() => run(tab)}>
            重试
          </button>
        </div>
      )}
      {tab === 'translate' && results.translate && <p className="study-para">{results.translate}</p>}
      {tab === 'explain' && results.explain && (
        <ExplanationView data={results.explain} showTranslation={showTranslation} onReveal={() => setShowTranslation(true)} />
      )}
    </div>
  );

  const panel = (
    <div
      className={'study' + (tab ? ' open' : '')}
      onPointerDown={onTouch}
      onClick={(e) => {
        e.stopPropagation();
        onTouch?.();
      }}
      role="dialog"
      aria-label="选中内容"
    >
      <div className="study-head">
        <div className="study-text" lang="en">
          {sel.text}
        </div>
        <button className="icon-btn" onClick={onClose} aria-label="关闭">
          <Icon name="close" size={20} />
        </button>
      </div>
      <div className="study-actions">
        <button className={tab === 'translate' ? 'on' : ''} disabled={tooLong} onClick={() => run('translate')}>
          <Icon name="translate" />
          翻译
        </button>
        <button className={tab === 'explain' ? 'on' : ''} disabled={tooLong} onClick={() => run('explain')}>
          <Icon name="spark" />
          AI 讲解
        </button>
        <button className={speaking ? 'on' : ''} disabled={!speechSupported} onClick={toggleSpeak}>
          <Icon name={speaking ? 'stop' : 'speak'} />
          {speaking ? '停止' : '朗读'}
        </button>
        <button className={fav ? 'on' : ''} onClick={toggleFav}>
          <Icon name="star" filled={fav} />
          {fav ? '已收藏' : '收藏'}
        </button>
      </div>
      {tooLong && <div className="study-error">选中内容过长，请缩短到 {MAX_TEXT} 字符以内再翻译或讲解</div>}
      {body}
      {onJump && (
        <button className="study-jump" onClick={onJump}>
          <Icon name="jump" size={18} />
          查看原文 · {bookTitle}
        </button>
      )}
    </div>
  );

  return modal ? (
    <div className="sheet-backdrop" onClick={onClose}>
      {panel}
    </div>
  ) : (
    panel
  );
}
