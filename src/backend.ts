/**
 * Media-server backend switch.
 *
 * The store itself is backend-agnostic — 44 of the 48 modules that reference
 * jellyfin.ts import nothing but its TYPES, and the shelves are stocked from a
 * plain `Movie[]`. Only four modules call server functions, and they all import
 * them from HERE rather than from a concrete backend, so adding Plex meant
 * writing src/plex.ts against the same surface instead of touching the store.
 *
 * Selection order (first hit wins):
 *   1. `?backend=plex` / `?backend=jellyfin` in the URL — per-session override,
 *      handy for a kiosk shortcut or for A/B-ing the two against one library.
 *   2. localStorage `media_backend` — what the settings terminal persists.
 *   3. `VITE_MEDIA_BACKEND` at build time — for a Docker image baked for one
 *      server.
 *   4. Jellyfin, the upstream default.
 *
 * Dispatch is per call rather than a module-level alias so switching backends
 * doesn't require a reload.
 */

import * as jellyfin from './jellyfin.ts';
import * as plex from './plex.ts';
import type {
  Movie, Episode, JellyfinLibrary, MediaStreamInfo, MediaPlaybackInfo,
  MovieVersion, PublicUser, HlsStreamOptions,
} from './jellyfin.ts';

export type BackendName = 'jellyfin' | 'plex';

const STORAGE_KEY = 'media_backend';

function isBackendName(v: unknown): v is BackendName {
  return v === 'jellyfin' || v === 'plex';
}

let overrideFromQuery: BackendName | undefined;
try {
  const q = new URLSearchParams(window.location.search).get('backend');
  if (isBackendName(q)) overrideFromQuery = q;
} catch {
  // Non-browser context (tests, SSR-ish tooling) — fall through to the rest.
}

/** Which media server this session talks to. */
export function getBackend(): BackendName {
  if (overrideFromQuery) return overrideFromQuery;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isBackendName(stored)) return stored;
  } catch {
    /* no storage — fall through */
  }
  // MUST be written as a literal `import.meta.env.X` access: Vite replaces that
  // exact expression at build time. Writing it defensively as
  // `(import.meta as any)?.env?.X` type-checks and looks safer, but the
  // optional chain stops the substitution — `import.meta.env` is then plain
  // `undefined` in the browser and a baked-in default silently never applies.
  // The typeof guard is the pattern the rest of the codebase uses (see
  // jellyseerr.ts) and keeps this working under plain Node in tests.
  const baked = typeof import.meta.env !== 'undefined' ? import.meta.env.VITE_MEDIA_BACKEND : undefined;
  if (isBackendName(baked)) return baked;
  return 'jellyfin';
}

/**
 * Persist the backend choice. Callers should re-run the library sync
 * afterwards: the catalog in memory belongs to the old server, and item ids
 * are not portable between the two.
 */
export function setBackend(name: BackendName): void {
  try {
    localStorage.setItem(STORAGE_KEY, name);
  } catch {
    /* best-effort */
  }
  overrideFromQuery = undefined;
}

/** Display name for the settings terminal and the login screen's hint text. */
export function backendLabel(name: BackendName = getBackend()): string {
  return name === 'plex' ? 'Plex' : 'Jellyfin';
}

/**
 * Name of the requests service that pairs with the active backend.
 *
 * There is only ONE client for both (src/jellyseerr.ts): Jellyseerr is a fork
 * of Overseerr and kept the `/api/v1` surface and `X-Api-Key` auth identical,
 * so the same code drives either and only the name on screen changes. Plex
 * users run Overseerr; Jellyfin users run Jellyseerr.
 */
export function requestsProviderLabel(name: BackendName = getBackend()): string {
  return name === 'plex' ? 'Overseerr' : 'Jellyseerr';
}

/** The active backend module. */
function api() {
  return getBackend() === 'plex' ? plex : jellyfin;
}

// ─── Dispatched surface ──────────────────────────────────────────────────────
// Explicitly typed rather than spread, so TypeScript verifies that plex.ts and
// jellyfin.ts really do agree on every signature — a drifting backend fails the
// build instead of failing at runtime in the store.

export function normalizeUrl(url: string): string {
  return api().normalizeUrl(url);
}

export function validateToken(serverUrl: string, token: string): Promise<boolean> {
  return api().validateToken(serverUrl, token);
}

export function authenticateUser(
  serverUrl: string,
  username: string,
  password?: string
): Promise<{ accessToken: string; userId: string; userName: string }> {
  return api().authenticateUser(serverUrl, username, password);
}

export function fetchPublicUsers(serverUrl: string): Promise<PublicUser[]> {
  return api().fetchPublicUsers(serverUrl);
}

export function buildUserAvatarUrl(
  serverUrl: string,
  userId: string,
  primaryImageTag?: string
): string | null {
  return api().buildUserAvatarUrl(serverUrl, userId, primaryImageTag);
}

/** Named for the Jellyfin original so the four call sites read unchanged. */
export function fetchJellyfinLibrariesAndMovies(
  serverUrl: string,
  token: string,
  userId: string,
  onProgress?: (stage: string) => void
): Promise<JellyfinLibrary[]> {
  return api().fetchJellyfinLibrariesAndMovies(serverUrl, token, userId, onProgress);
}

export function fetchSeriesEpisodes(
  serverUrl: string,
  token: string,
  userId: string,
  seriesId: string
): Promise<Episode[]> {
  return api().fetchSeriesEpisodes(serverUrl, token, userId, seriesId);
}

export function fetchFirstEpisodeOfSeries(
  serverUrl: string,
  token: string,
  userId: string,
  seriesId: string
): Promise<{ id: string; path: string } | null> {
  return api().fetchFirstEpisodeOfSeries(serverUrl, token, userId, seriesId);
}

export function fetchItemPlaybackInfo(
  serverUrl: string,
  token: string,
  userId: string,
  itemId: string
): Promise<MediaPlaybackInfo | undefined> {
  return api().fetchItemPlaybackInfo(serverUrl, token, userId, itemId);
}

export function reportPlaybackStart(serverUrl: string, token: string, itemId: string): Promise<void> {
  return api().reportPlaybackStart(serverUrl, token, itemId);
}

export function reportPlaybackProgress(
  serverUrl: string,
  token: string,
  itemId: string,
  positionTicks: number,
  isPaused: boolean
): Promise<void> {
  return api().reportPlaybackProgress(serverUrl, token, itemId, positionTicks, isPaused);
}

export function reportPlaybackStopped(
  serverUrl: string,
  token: string,
  itemId: string,
  positionTicks: number = 0
): Promise<void> {
  return api().reportPlaybackStopped(serverUrl, token, itemId, positionTicks);
}

export function stopActiveEncoding(playSessionId: string, log?: (msg: string) => void): Promise<void> {
  return api().stopActiveEncoding(playSessionId, log);
}

export function buildStaticStreamUrl(
  serverUrl: string,
  token: string,
  itemId: string,
  mediaSourceId?: string
): string {
  return api().buildStaticStreamUrl(serverUrl, token, itemId, mediaSourceId);
}

export function buildHlsStreamUrl(
  serverUrl: string,
  token: string,
  itemId: string,
  opts?: HlsStreamOptions
): string {
  return api().buildHlsStreamUrl(serverUrl, token, itemId, opts);
}

export function getLastHlsPlaySessionId(): string | undefined {
  return api().getLastHlsPlaySessionId();
}

export function isStreamCopyUrl(src: string): boolean {
  return api().isStreamCopyUrl(src);
}

// ─── Backend-independent ─────────────────────────────────────────────────────
// Pure webview-capability checks over a MediaPlaybackInfo, and the collection
// maps jellyseerr.ts shares. Both backends populate the same maps, so these are
// plain re-exports rather than dispatched calls.

export {
  isDirectPlaySafe,
  isHevcPassThroughEnabled,
  collectionArt,
  collectionTmdbIds,
  collectionSyncStats,
} from './jellyfin.ts';

// ─── Plex-only ───────────────────────────────────────────────────────────────
// The device-link flow has no Jellyfin counterpart (Jellyfin takes a username
// and password directly), so these are not dispatched — the login screen calls
// them only while the Plex backend is selected.

export {
  requestPlexPin,
  checkPlexPin,
  discoverPlexServers,
  authenticatePlexAccount,
  // Music sections are the ones the video-store sync deliberately skips; the
  // record-store mode sources its stock from these instead.
  fetchMusicAlbums,
  fetchAlbumTracks,
} from './plex.ts';
export type { PlexPin, PlexServer } from './plex.ts';

export type {
  Movie, Episode, JellyfinLibrary, MediaStreamInfo, MediaPlaybackInfo,
  MovieVersion, PublicUser, HlsStreamOptions,
};
