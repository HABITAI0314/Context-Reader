import { useEffect, useState, type ReactNode } from 'react';

const PATHS: Record<string, ReactNode> = {
  back: <path d="M15 5l-7 7 7 7" />,
  list: <path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01" />,
  gear: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-2.8 1.2V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.9 19a1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00-1.2-2.8H3a2 2 0 110-4h.1A1.7 1.7 0 005 8.9a1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9.4a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8v.1a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  more: <path d="M5 12h.01M12 12h.01M19 12h.01" />,
  star: <path d="M12 3.5l2.7 5.5 6 .9-4.4 4.2 1 6-5.3-2.8-5.3 2.8 1-6L3.3 9.900l6-.9z" />,
  speak: <path d="M4 9.5v5h3.500l4.500 4v-13l-4.500 4zM16 9a4 4 0 010 6M18.500 6.500a8 8 0 010 11" />,
  stop: <rect x="6.500" y="6.500" width="11" height="11" rx="1.500" />,
  translate: <path d="M4 6h9M8.500 4v2M11 6c-.6 3.200-2.800 6-6.500 7.800M6.500 9.500c1 2 2.800 3.500 5 4.300M12.500 20l4-9.500 4 9.500M14 17h5" />,
  spark: <path d="M12 3l1.800 5.200L19 10l-5.200 1.800L12 17l-1.800-5.200L5 10l5.200-1.800zM18.500 15.500l.8 2.200 2.200.8-2.200.8-.8 2.200-.8-2.200-2.200-.8 2.200-.8z" />,
  jump: <path d="M9 6h9v9M18 6L6 18" />,
  listen: <path d="M4 14v-2a8 8 0 0116 0v2M4 14h3v6H5a1 1 0 01-1-1zM20 14h-3v6h2a1 1 0 001-1z" />,
  cards: (
    <>
      <rect x="4" y="7" width="13" height="13" rx="2" />
      <path d="M8 4h10a2 2 0 012 2v10" />
    </>
  ),
  play: <path d="M8 5.500v13l11-6.500z" />,
  pause: <path d="M8 5.500v13M16 5.500v13" />,
  prev: <path d="M17 6l-7 6 7 6M7 6v12" />,
  next: <path d="M7 6l7 6-7 6M17 6v12" />,
};

export function Icon({ name, filled, size = 22 }: { name: keyof typeof PATHS | string; filled?: boolean; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {PATHS[name]}
    </svg>
  );
}

/** 带遮罩的底部弹层（目录、字号、书籍操作等） */
export function Sheet({ title, onClose, children }: { title?: string; onClose(): void; children: ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <div className="sheet-grip" />
        {title && <div className="sheet-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

// ---- 轻提示 ----
let push: (msg: string) => void = () => {};
export function toast(msg: string) {
  push(msg);
}
export function Toaster() {
  const [msg, setMsg] = useState('');
  useEffect(() => {
    let t = 0;
    push = (m) => {
      setMsg(m);
      clearTimeout(t);
      t = window.setTimeout(() => setMsg(''), 2600);
    };
    return () => clearTimeout(t);
  }, []);
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null;
}
