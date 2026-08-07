/**
 * Which shop you walk into.
 *
 * The store engine renders whatever `JellyfinLibrary[]` it is handed, so a
 * record shop is not a second application — it is the same store stocked from
 * the music sections instead of the video ones, wearing sleeves instead of
 * clamshells. This module is the switch, and the one place that decides where a
 * catalog comes from.
 *
 * Selection order (first hit wins), mirroring backend.ts:
 *   1. `?store=records` / `?store=video` in the URL — per-session, handy for a
 *      kiosk shortcut or a quick look without changing anything.
 *   2. localStorage `store_mode` — what the settings terminal persists.
 *   3. Video, the upstream behaviour.
 */

import {
  fetchJellyfinLibrariesAndMovies,
  fetchMusicAlbums,
  getBackend,
  type JellyfinLibrary,
} from './backend';
import { buildMusicLibraries } from './music-only';

export type StoreMode = 'video' | 'records';

const STORAGE_KEY = 'store_mode';

function isStoreMode(v: unknown): v is StoreMode {
  return v === 'video' || v === 'records';
}

let overrideFromQuery: StoreMode | undefined;
try {
  const q = new URLSearchParams(window.location.search).get('store');
  if (isStoreMode(q)) overrideFromQuery = q;
} catch {
  // Non-browser context (tests) — fall through.
}

export function getStoreMode(): StoreMode {
  if (overrideFromQuery) return overrideFromQuery;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isStoreMode(stored)) return stored;
  } catch {
    /* no storage */
  }
  return 'video';
}

/**
 * Persist the shop choice. Callers must re-run the catalog load afterwards: the
 * stock in memory belongs to the other shop, and item ids don't cross over.
 */
export function setStoreMode(mode: StoreMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* best-effort */
  }
  overrideFromQuery = undefined;
}

/** Name for signage, log lines and the settings terminal. */
export function storeModeLabel(mode: StoreMode = getStoreMode()): string {
  return mode === 'records' ? 'Record Store' : 'Video Store';
}

/** Whether the active shop stocks records rather than films. */
export function isRecordStore(): boolean {
  return getStoreMode() === 'records';
}

/**
 * The catalog for whichever shop is open.
 *
 * Both branches return the same shape, so everything downstream — the shelf
 * planner, the browse cursor, inspect, checkout — is identical either way.
 */
export async function loadStoreCatalog(
  serverUrl: string,
  token: string,
  userId: string,
  onProgress?: (stage: string) => void
): Promise<JellyfinLibrary[]> {
  if (!isRecordStore()) {
    return fetchJellyfinLibrariesAndMovies(serverUrl, token, userId, onProgress);
  }

  // Music lives in sections the video sync deliberately skips, and reading them
  // is backend-specific work that only the Plex client implements so far. Say
  // so plainly rather than opening an empty shop.
  if (getBackend() !== 'plex') {
    throw new Error(
      'The record store needs a Plex server — the Jellyfin backend has no music support yet. ' +
      'Switch the server to Plex, or the store back to Video.'
    );
  }

  const albums = await fetchMusicAlbums(serverUrl, token, onProgress);
  if (albums.length === 0) throw new Error('No albums found in your music libraries.');
  return buildMusicLibraries(albums);
}
