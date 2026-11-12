import { useSyncExternalStore } from 'react';
import type { Settings, ThemeName } from '../types';

const KEY = 'cr.settings';
const DEFAULTS: Settings = { fontSize: 19, theme: 'auto', speechRate: 0.95, apiBase: '', token: '', voice: '' };

function load(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return DEFAULTS;
  }
}

let current = load();
const listeners = new Set<() => void>();

export function getSettings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {}
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribe, getSettings);
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
export function useTheme(): ThemeName {
  const dark = useSyncExternalStore(
    (fn) => {
      darkQuery.addEventListener('change', fn);
      return () => darkQuery.removeEventListener('change', fn);
    },
    () => darkQuery.matches
  );
  const { theme } = useSettings();
  return theme === 'auto' ? (dark ? 'dark' : 'light') : theme;
}

export const FONT_MIN = 14;
export const FONT_MAX = 30;
