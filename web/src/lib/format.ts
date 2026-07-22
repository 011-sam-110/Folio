// Owned by web-shell (may be replaced; keep exported signatures).

export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  const d = Math.round(s / 86400);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function numberFmt(n: number): string {
  return n.toLocaleString();
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** "Good morning" / "Good afternoon" / "Good evening" based on the local hour. */
export function greeting(date = new Date()): string {
  const h = date.getHours();
  if (h < 5) return 'Good night';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export function longDate(date = new Date()): string {
  return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/** Extracts a human message from anything an api.* call can throw. */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export interface SnippetSegment {
  mark: boolean;
  text: string;
}

/**
 * Splits a server-generated snippetHtml string (only ever containing plain
 * text plus <mark>…</mark> spans, per docs/API.md) into safe, renderable
 * segments - no dangerouslySetInnerHTML anywhere, any stray markup is
 * stripped defensively.
 */
export function parseSnippetHtml(html: string): SnippetSegment[] {
  if (!html) return [];
  const parts = html.split(/(<mark>[\s\S]*?<\/mark>)/g).filter(Boolean);
  return parts.map((part) => {
    const m = /^<mark>([\s\S]*?)<\/mark>$/.exec(part);
    if (m) return { mark: true, text: m[1].replace(/<[^>]*>/g, '') };
    return { mark: false, text: part.replace(/<[^>]*>/g, '') };
  });
}
