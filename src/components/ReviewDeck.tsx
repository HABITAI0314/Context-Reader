import { useEffect, useMemo, useRef, useState } from 'react';
import type { Explanation } from '../types';
import { askAi, getCachedAi } from '../lib/ai';
import { useSettings } from '../lib/settings';
import { speak, speechSupported, stopSpeaking } from '../lib/speech';
import { ExplanationView } from './StudySheet';
import { Icon } from './ui';

export interface ReviewItem {
  id: string;
  text: string;
  context: string;
  source: string; // 书名 · 章节
}

interface Props {
  title: string;
  items: ReviewItem[];
  /** 每张卡片的结果：认识 / 不认识 */
  onMark(item: ReviewItem, known: boolean): void;
  onClose(): void;
}

/** 把原句里的目标词句加粗 */
function Context({ text, context }: { text: string; context: string }) {
  const at = context.toLowerCase().indexOf(text.toLowerCase());
  if (!context || at < 0) return null;
  return (
    <p className="card-context" lang="en">
      {context.slice(0, at)}
      <b>{context.slice(at, at + text.length)}</b>
      {context.slice(at + text.length)}
    </p>
  );
}

/**
 * 翻卡复习：先看原文回想意思，再翻开释义，自己判断"认识 / 不认识"。
 * 不认识的会在这一轮末尾再出现一次。没有打卡，也没有记忆曲线。
 */
export function ReviewDeck({ title, items, onMark, onClose }: Props) {
  const { speechRate } = useSettings();
  const [queue, setQueue] = useState(items);
  const [turn, setTurn] = useState(0); // 每答一张加一，保证同一张卡再次出现时也回到正面
  const [flipped, setFlipped] = useState(false);
  const [back, setBack] = useState<{ explain?: Explanation; translate?: string; loaded: boolean }>({ loaded: false });
  const [showTranslation, setShowTranslation] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const stats = useRef({ known: 0, again: 0, seen: new Set<string>() });
  const total = useMemo(() => items.length, [items]);
  const card = queue[0];

  useEffect(() => {
    setFlipped(false);
    setShowTranslation(false);
    setError('');
    setBack({ loaded: false });
    if (!card) return;
    let dead = false;
    (async () => {
      const [e, t] = await Promise.all([getCachedAi('explain', card.text, card.context), getCachedAi('translate', card.text, card.context)]);
      if (!dead) setBack({ explain: e?.result as Explanation | undefined, translate: t?.result as string | undefined, loaded: true });
    })();
    return () => {
      dead = true;
    };
  }, [card?.id, turn]);

  useEffect(() => () => stopSpeaking(), []);

  const fetchMeaning = async () => {
    if (!card) return;
    setBusy(true);
    setError('');
    try {
      const result = (await askAi('explain', card.text, card.context)) as Explanation;
      setBack((b) => ({ ...b, explain: result }));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const answer = (known: boolean) => {
    if (!card) return;
    const first = !stats.current.seen.has(card.id);
    stats.current.seen.add(card.id);
    if (first) {
      onMark(card, known);
      if (known) stats.current.known++;
      else stats.current.again++;
    }
    // 第一次答"不认识"的，排到这一轮最后再看一遍
    setQueue((q) => (known || !first ? q.slice(1) : [...q.slice(1), card]));
    setTurn((t) => t + 1);
  };

  const done = Math.min(total, stats.current.seen.size);

  return (
    <div className="deck" role="dialog" aria-label={title}>
      <header className="deck-head">
        <button className="icon-btn" onClick={onClose} aria-label="结束复习">
          <Icon name="close" />
        </button>
        <div className="deck-title">{title}</div>
        <div className="deck-count">
          {done}/{total}
        </div>
      </header>

      {!card ? (
        <div className="deck-done">
          <p className="deck-big">这一轮看完了</p>
          <p className="muted">
            认识 {stats.current.known} 个，还不熟 {stats.current.again} 个
          </p>
          <button className="btn" onClick={onClose}>
            完成
          </button>
        </div>
      ) : (
        <>
          <main className="deck-body selectable" key={card.id + ':' + turn}>
            <div className="card-front">
              <h2 lang="en">{card.text}</h2>
              {speechSupported && (
                <button className="icon-btn" onClick={() => speak(card.text, speechRate, () => {})} aria-label="朗读">
                  <Icon name="speak" />
                </button>
              )}
            </div>
            <Context text={card.text} context={card.context} />
            <div className="card-source">{card.source}</div>

            {flipped && (
              <div className="card-back">
                {back.explain ? (
                  <ExplanationView data={back.explain} showTranslation={showTranslation} onReveal={() => setShowTranslation(true)} />
                ) : back.translate ? (
                  <p className="study-para">{back.translate}</p>
                ) : back.loaded ? (
                  <>
                    <p className="muted">这一条还没有保存过释义。</p>
                    <button className="reveal" disabled={busy} onClick={fetchMeaning}>
                      {busy ? '正在讲解…' : '现在讲解'}
                    </button>
                    {error && <p className="study-error">{error}</p>}
                  </>
                ) : null}
              </div>
            )}
          </main>

          <footer className="deck-foot">
            {flipped ? (
              <>
                <button className="deck-btn" onClick={() => answer(false)}>
                  不认识
                </button>
                <button className="deck-btn yes" onClick={() => answer(true)}>
                  认识
                </button>
              </>
            ) : (
              <button className="deck-btn wide" onClick={() => setFlipped(true)}>
                先回想一下，再看释义
              </button>
            )}
          </footer>
        </>
      )}
    </div>
  );
}
