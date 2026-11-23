// Small things this phone remembers for the person: what they watched, what they searched,
// and the list of videos they are swiping through after tapping a search result.
const WATCHED = 'pro_watched';
const RECENT = 'pro_recent_searches';
const PLAYLIST = 'pro_playlist';

function readList(storage: Storage | undefined, key: string): string[] {
  try {
    const raw = storage?.getItem(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x: unknown): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeList(storage: Storage | undefined, key: string, list: string[]) {
  try {
    storage?.setItem(key, JSON.stringify(list));
  } catch { /* storage full or blocked: not important */ }
}

const local = () => (typeof window === 'undefined' ? undefined : window.localStorage);
const session = () => (typeof window === 'undefined' ? undefined : window.sessionStorage);

// Watched videos (powers the Watched / Unwatched filters).
export function markWatched(id: string) {
  const list = readList(local(), WATCHED);
  if (list[list.length - 1] === id) return;
  writeList(local(), WATCHED, [...list.filter((x: string) => x !== id), id].slice(-500));
}
export function getWatched(): Set<string> {
  return new Set(readList(local(), WATCHED));
}

// Recent searches.
export function getRecent(): string[] {
  return readList(local(), RECENT);
}
export function addRecent(text: string) {
  const t = text.trim();
  if (!t) return;
  writeList(local(), RECENT, [t, ...readList(local(), RECENT).filter((x: string) => x.toLowerCase() !== t.toLowerCase())].slice(0, 8));
}
export function removeRecent(text: string) {
  writeList(local(), RECENT, readList(local(), RECENT).filter((x: string) => x !== text));
}
export function clearRecent() {
  writeList(local(), RECENT, []);
}

// The videos on screen when a card was tapped: the player keeps going through them.
export function savePlaylist(ids: string[]) {
  writeList(session(), PLAYLIST, ids.slice(0, 200));
}
export function readPlaylist(): string[] {
  return readList(session(), PLAYLIST);
}
