import { createRoot } from 'react-dom/client';
import { App } from './App';
import { startSync } from './lib/sync';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
startSync();

// 只在正式构建中注册 service worker（需要 HTTPS 或 localhost）
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
