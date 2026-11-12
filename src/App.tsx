import { useEffect, useRef, useState } from 'react';
import { Toaster } from './components/ui';
import { useTheme } from './lib/settings';
import { THEME_COLORS } from './lib/util';
import { Reader } from './pages/Reader';
import { Settings } from './pages/Settings';
import { Shelf } from './pages/Shelf';

type Route = { page: 'shelf' } | { page: 'settings' } | { page: 'read'; id: string };
const LAST_BOOK = 'cr.lastBook';

function parse(hash: string): Route {
  const m = hash.match(/^#\/read\/(.+)$/);
  if (m) return { page: 'read', id: decodeURIComponent(m[1]) };
  if (hash === '#/settings') return { page: 'settings' };
  return { page: 'shelf' };
}

// 从主屏幕重新启动时总是回到起始地址：如果上次是在读书时被系统关掉的，直接回到那本书
if (!location.hash || location.hash === '#/') {
  const last = localStorage.getItem(LAST_BOOK);
  if (last) history.replaceState(null, '', `#/read/${encodeURIComponent(last)}`);
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  const jump = useRef<string | undefined>(undefined);
  const theme = useTheme();

  useEffect(() => {
    const onHash = () => setRoute(parse(location.hash));
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    if (route.page === 'read') localStorage.setItem(LAST_BOOK, route.id);
    else localStorage.removeItem(LAST_BOOK);
  }, [route]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLORS[theme].bg);
  }, [theme]);

  const go = (hash: string) => {
    location.hash = hash;
  };

  return (
    <>
      {route.page === 'shelf' && (
        <Shelf
          onOpen={(id, loc) => {
            jump.current = loc;
            go(`#/read/${encodeURIComponent(id)}`);
          }}
          onSettings={() => go('#/settings')}
        />
      )}
      {route.page === 'settings' && <Settings onBack={() => go('#/')} />}
      {route.page === 'read' && (
        <Reader
          key={route.id}
          bookId={route.id}
          jump={jump.current}
          onExit={() => {
            jump.current = undefined;
            go('#/');
          }}
        />
      )}
      <Toaster />
    </>
  );
}
