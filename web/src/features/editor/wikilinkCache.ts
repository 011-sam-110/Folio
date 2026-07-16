// Tiny in-memory cache for wikilink hover-preview lookups, keyed by noteId.
import type { Note } from '../../lib/types';

const cache = new Map<string, Note>();

export function getCachedNote(id: string): Note | undefined {
  return cache.get(id);
}

export function setCachedNote(id: string, note: Note) {
  cache.set(id, note);
}

export function invalidateCachedNote(id: string) {
  cache.delete(id);
}
