// Owned by web-shell (may be replaced; keep exported signatures).
import { useEffect, useState } from 'react';

const KEY = 'folio:theme';
export type Theme = 'light' | 'dark';

export function getTheme(): Theme {
  const saved = localStorage.getItem(KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function applyTheme(t: Theme) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(KEY, t);
}

export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  return next;
}

/** React binding: current theme + a setter that also persists/applies it. */
export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const [theme, setThemeState] = useState<Theme>(() => getTheme());

  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) {
        setThemeState(e.newValue);
        document.documentElement.setAttribute('data-theme', e.newValue);
      }
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  function setTheme(t: Theme) {
    applyTheme(t);
    setThemeState(t);
  }

  function toggle() {
    setTheme(theme === 'dark' ? 'light' : 'dark');
  }

  return [theme, setTheme, toggle];
}
