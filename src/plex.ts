/**
 * Plex backend — the same module surface as jellyfin.ts, backed by a Plex
 * Media Server.
 *
 * WHY THIS CAN EXIST AT ALL: the store renders from `Movie[]` / `JellyfinLibrary[]`,
 * not from Jellyfin JSON. 44 of the 48 modules that touch jellyfin.ts import
 * nothing but its TYPES; only main.ts, video-player.ts, membership-cards.ts and
 * flat/flat-detail.ts call its functions. Reimplement those ~20 functions
 * against Plex and the entire 3D store works unchanged. demo-mode.ts already
 * proved the point — it stocks the shelves from a synthetic catalog with no
 * server at all.
 *
 * Everything backend-agnostic is REUSED from jellyfin.ts rather than copied:
 * the type declarations, collapseDuplicateVersions() (it operates on Movie[]),
 * isDirectPlaySafe()/isHevcPassThroughEnabled() (pure webview capability
 * checks), and the collection maps jellyseerr.ts reads.
 *
 * Notable places Plex is a BETTER fit than Jellyfin:
 *   - Genre/Director/Role/Media all arrive in the section listing, so a library
 *     syncs in one paged request instead of Jellyfin's `Fields=` shopping list.
 *   - Multiple editions of a film are natively several Media[] entries on one
 *     item, which is exactly the MovieVersion model.
 *   - Watch state rides along on the item, so no UserData round-trip.
 *
 * And the two places it is worse, both because Plex thins out LIST responses:
 *   - Role[] in a listing is `{tag: "Jim Sturgess"}` — a name and nothing else.
 *     Portraits and person ids only exist on the per-item detail view, which
 *     would be one request per title. The section's own cast index
 *     (`/library/sections/{id}/actor`) carries both for every actor in the
 *     library, so fetchActorIndex() pulls that once per library and joins on
 *     name — see mapItemToMovie().
 *   - Per-track Stream[] data is refused in a listing (`includeStreams=1` is
 *     ignored there), so Movie.mediaStreams — the player's audio/subtitle track
 *     picker — is filled in lazily by fetchItemPlaybackInfo() right before
 *     playback instead of arriving with the catalog. Container/codec info for
 *     the direct-play decision DOES come in bulk off Media[], so
 *     isDirectPlaySafe() is unaffected.
 */

import { invoke } from '@tauri-apps/api/core';
import {
  type Movie,
  type Episode,
  type JellyfinLibrary,
  type MediaStreamInfo,
  type MediaPlaybackInfo,
  type MovieVersion,
  type PublicUser,
  type HlsStreamOptions,
  collapseDuplicateVersions,
  collectionTmdbIds,
  collectionSyncStats,
  normalizeUrl,
} from './jellyfin.ts';

// Re-exported unchanged: these are pure webview-capability checks over a
// MediaPlaybackInfo, with nothing Jellyfin-specific in them.
export { isDirectPlaySafe, isHevcPassThroughEnabled, normalizeUrl } from './jellyfin.ts';
export type {
  Movie, Episode, JellyfinLibrary, MediaStreamInfo, MediaPlaybackInfo,
  MovieVersion, PublicUser, HlsStreamOptions,
} from './jellyfin.ts';
// jellyseerr.ts reads these; re-exported so backend.ts can serve every symbol
// main.ts imports from a single module regardless of which backend is active.
export { collectionArt, collectionTmdbIds, collectionSyncStats } from './jellyfin.ts';

// ─── Client identity ─────────────────────────────────────────────────────────

/** Stable per-install client id. Plex keys transcode sessions and the
 *  "now playing" dashboard entry off this, so it must NOT change between
 *  requests within a session — a random id per call would spawn a new
 *  transcode session on every seek and leave the old ffmpeg running. */
const PLEX_CLIENT_ID = (() => {
  const KEY = 'plex_client_identifier';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const fresh = `halcyon-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(KEY, fresh);
    return fresh;
  } catch {
    // Private-mode / no-storage contexts: a per-load id still works, it just
    // won't survive a reload.
    return 'halcyon-htpc-device';
  }
})();

const PLEX_PRODUCT = 'Halcyon Video';
const PLEX_VERSION = '0.1.0';
const PLEX_DEVICE = 'HTPC';
const PLEX_PLATFORM = 'Chrome';

/** Identity params Plex wants on every call. Sent as QUERY PARAMS rather than
 *  headers on purpose: the Tauri transport (`jellyfin_request` in
 *  src-tauri/src/lib.rs) only forwards two fixed header names, so query params
 *  are the one encoding that works identically on both transports. */
function identityParams(token?: string): Record<string, string> {
  const p: Record<string, string> = {
    'X-Plex-Client-Identifier': PLEX_CLIENT_ID,
    'X-Plex-Product': PLEX_PRODUCT,
    'X-Plex-Version': PLEX_VERSION,
    'X-Plex-Device': PLEX_DEVICE,
    'X-Plex-Platform': PLEX_PLATFORM,
  };
  if (token) p['X-Plex-Token'] = token;
  return p;
}

/** Compose `${base}${path}?${params}` with the identity/token params folded in. */
function plexUrl(base: string, path: string, token?: string, extra?: Record<string, string | number | undefined>): string {
  const url = base.replace(/\/$/, '');
  const params = new URLSearchParams(identityParams(token));
  for (const [k, v] of Object.entries(extra ?? {})) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  return `${url}${path}${path.includes('?') ? '&' : '?'}${params.toString()}`;
}

// ─── Transport ───────────────────────────────────────────────────────────────

/**
 * One HTTP round-trip to Plex, over whichever transport this build has.
 *
 * Error strings deliberately match jellyfin.ts's `HTTP error <status>: <body>`
 * shape — validateToken() and every caller that distinguishes "token rejected"
 * from "server unreachable" pattern-matches on it.
 */
async function plexRequest(method: string, url: string, body?: string): Promise<string> {
  const hasTauri = typeof window !== 'undefined' && (window as any).__TAURI_INTERNALS__ !== undefined;
  if (hasTauri) {
    // The Rust side sets no Accept header, so Plex would answer XML. We ask for
    // JSON through the optional accept param added for this backend; an older
    // binary that ignores it still returns XML, which parsePlex() reports as a
    // clear error rather than silently mis-parsing.
    return await invoke<string>('jellyfin_request', {
      method,
      url,
      authHeader: undefined,
      token: undefined,
      body,
      accept: 'application/json',
    });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch(url, {
      method,
      headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
      body: body || undefined,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP error ${response.status}: ${text}`);
    }
    return await response.text();
  } catch (e: any) {
    clearTimeout(timeoutId);
    if (e?.name === 'AbortError') throw new Error(`Request to ${url} timed out after 60 seconds`);
    throw e;
  }
}

/** Plex wraps every response in a MediaContainer; unwrap it. */
function parsePlex(text: string): any {
  if (!text || !text.trim()) return {};
  if (text.trimStart().startsWith('<')) {
    throw new Error(
      'Plex returned XML, not JSON — the Tauri build needs the `accept` parameter ' +
      'on jellyfin_request (see src-tauri/src/lib.rs). Rebuild the desktop binary.'
    );
  }
  const data = JSON.parse(text);
  return data?.MediaContainer ?? data;
}

async function plexGet(base: string, path: string, token: string, extra?: Record<string, string | number | undefined>): Promise<any> {
  return parsePlex(await plexRequest('GET', plexUrl(base, path, token, extra)));
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/**
 * Liveness/auth check for a stored token — same contract as the Jellyfin one:
 * resolve `false` ONLY when the server definitively rejected the token
 * (401/403), and THROW on anything else so a network blip never tears down a
 * live session (issue #125).
 *
 * `/identity` is unauthenticated, so it can't test the token; `/library/sections`
 * is the cheapest endpoint that does.
 */
export async function validateToken(plexUrl_: string, token: string): Promise<boolean> {
  if (!plexUrl_ || !token) return false;
  try {
    await plexRequest('GET', plexUrl(normalizeUrl(plexUrl_), '/library/sections', token));
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/^HTTP error (401|403):/.test(msg)) return false;
    throw e;
  }
}

/** A Plex auth token is 20 URL-safe characters — used to tell "the user pasted
 *  a token into the username box" apart from "the user typed an email". */
function looksLikeToken(s: string): boolean {
  return /^[A-Za-z0-9_-]{19,24}$/.test(s.trim()) && !s.includes('@');
}

/**
 * Sign in, returning the same `{ accessToken, userId, userName }` triple the
 * Jellyfin path returns. Plex has no username+password endpoint on the SERVER
 * (it authenticates bearer tokens only), so three routes are supported:
 *
 *  1. TOKEN — paste an X-Plex-Token in the username box, leave the password
 *     blank. Validated against the server before it's accepted. This is the
 *     LAN-only route: nothing leaves the network.
 *  2. PLEX ACCOUNT — email + password, exchanged at plex.tv for a token. This
 *     is an outbound call to plex.tv (the only one this backend makes, and
 *     only on this code path).
 *  3. HOME USER SWITCH — picking a managed/Home user's membership card when an
 *     admin token is already stored; the password box carries their PIN.
 *     Attempted before (2) whenever we already hold a token, so the common
 *     "who's watching?" flow stays on the LAN.
 */
export async function authenticateUser(
  plexUrl_: string,
  username: string,
  password?: string
): Promise<{ accessToken: string; userId: string; userName: string }> {
  const base = normalizeUrl(plexUrl_);
  const user = (username || '').trim();
  const pass = password || '';

  // (1) A pasted token.
  if (!pass && looksLikeToken(user)) {
    const ok = await validateToken(base, user);
    if (!ok) throw new Error('That Plex token was rejected by the server.');
    const me = await currentAccount(base, user);
    return { accessToken: user, userId: me.id, userName: me.name };
  }

  // (3) Home-user switch, when we already hold a token for this server.
  const storedToken = safeLocalStorage('jellyfin_token');
  if (storedToken) {
    try {
      const switched = await switchHomeUser(base, storedToken, user, pass);
      if (switched) return switched;
    } catch (e) {
      console.warn('[Plex] Home-user switch failed, falling back to plex.tv sign-in:', e);
    }
  }

  // (2) plex.tv account sign-in.
  const signinBody = JSON.stringify({ login: user, password: pass });
  const signinUrl = `https://plex.tv/api/v2/users/signin?${new URLSearchParams(identityParams()).toString()}`;
  let data: any;
  try {
    data = JSON.parse(await plexRequest('POST', signinUrl, signinBody));
  } catch (error: any) {
    const msg = error?.message ?? String(error);
    if (/^HTTP error 401:/.test(msg)) throw new Error('Incorrect Plex username or password.');
    throw new Error(msg || 'Failed to authenticate with Plex.');
  }
  const accessToken = data?.authToken || data?.authentication_token;
  if (!accessToken) throw new Error('Invalid response payload from plex.tv.');

  // The plex.tv token must also be authorized ON THIS SERVER — a valid Plex
  // account that was never shared the library would otherwise "log in" and then
  // sync zero libraries, which reads as a broken app rather than a permissions
  // problem.
  if (!(await validateToken(base, accessToken))) {
    throw new Error('Signed in to Plex, but this account has no access to that server.');
  }
  return {
    accessToken,
    userId: String(data?.id ?? ''),
    userName: data?.username || data?.title || user,
  };
}

// ─── plex.tv device link (PIN) ───────────────────────────────────────────────

/**
 * The link flow every real Plex client uses, and the right one for an HTPC:
 * the app asks plex.tv for a short code, the TV shows it, and the user types it
 * at plex.tv/link on their phone. No password is ever typed with a remote, and
 * this app never handles the credentials.
 *
 * Three calls make it work:
 *   requestPlexPin()      — get a code to display
 *   checkPlexPin(id)      — poll until the user claims it
 *   discoverPlexServers() — list the servers that token can reach
 */
export interface PlexPin {
  /** Poll target for checkPlexPin(). */
  id: number;
  /** The 4-character code to put on screen. */
  code: string;
  /** Epoch ms after which the code stops working (plex.tv gives ~15 min). */
  expiresAt: number;
  /** Where the user types the code. */
  linkUrl: string;
}

const PLEX_TV = 'https://plex.tv/api/v2';

/**
 * Ask plex.tv for a link code.
 *
 * Deliberately NOT `strong=true`: a strong pin is a long opaque string meant
 * for the browser redirect flow, whereas the short code is the one a person
 * can read off a CRT and type on a phone.
 */
export async function requestPlexPin(): Promise<PlexPin> {
  const url = `${PLEX_TV}/pins?${new URLSearchParams(identityParams()).toString()}`;
  const res = JSON.parse(await plexRequest('POST', url));
  if (!res?.id || !res?.code) throw new Error('plex.tv did not return a link code.');
  const expiresInSec = typeof res.expiresIn === 'number' ? res.expiresIn : 900;
  return {
    id: Number(res.id),
    code: String(res.code),
    expiresAt: Date.now() + expiresInSec * 1000,
    linkUrl: 'https://plex.tv/link',
  };
}

/**
 * Has the user claimed the code yet? Returns their auth token once they have,
 * null while still waiting.
 *
 * Throws only on a genuine transport failure, so a caller's polling loop can
 * treat null as "keep waiting" and an exception as "stop and show an error".
 */
export async function checkPlexPin(pinId: number): Promise<string | null> {
  const url = `${PLEX_TV}/pins/${pinId}?${new URLSearchParams(identityParams()).toString()}`;
  const res = JSON.parse(await plexRequest('GET', url));
  return res?.authToken ? String(res.authToken) : null;
}

/** A Plex Media Server this account can reach. */
export interface PlexServer {
  name: string;
  /** Base URL to hand to the rest of this module. */
  url: string;
  /** True for a LAN address — preferred, and the only kind that stays off the
   *  internet. */
  local: boolean;
  owned: boolean;
}

/** Can this address actually be reached from where the app is running? */
async function isReachable(baseUrl: string, timeoutMs: number): Promise<boolean> {
  // /identity needs no token and is the cheapest thing Plex serves.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/identity`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every server the token can reach, best connection first.
 *
 * This is fussier than it looks, because plex.tv's list is not a list of
 * addresses that work from HERE:
 *
 *   - It reports EVERY address the server saw on itself. A Plex box running
 *     Docker advertises its bridge gateways (172.17.0.1, 172.20.0.1, …) and
 *     plex.tv flags them `local` exactly like the real LAN address. Picking one
 *     yields a server that never answers.
 *   - The `uri` field is a `plex.direct` HTTPS hostname that resolves to the
 *     private IP through PUBLIC DNS. It works, but it needs the internet to
 *     resolve a machine on your own switch, and adds TLS to a LAN hop. For a
 *     local connection the plain `http://ip:port` form is better on both counts.
 *   - A relay connection routes your video through plex.tv. Never preferred.
 *
 * So: build direct URLs for local connections, dedupe, then actually PROBE the
 * candidates and let the ones that answer sort first. Probing costs one
 * unauthenticated request per address, in parallel, once per login.
 */
export async function discoverPlexServers(token: string, probeTimeoutMs = 2500): Promise<PlexServer[]> {
  const url = `${PLEX_TV}/resources?${new URLSearchParams({
    ...identityParams(token),
    includeHttps: '1',
    includeRelay: '1',
  }).toString()}`;
  const res = JSON.parse(await plexRequest('GET', url));
  const list: any[] = Array.isArray(res) ? res : (res?.MediaContainer?.Device ?? []);

  const seen = new Set<string>();
  const candidates: PlexServer[] = [];
  for (const dev of list) {
    if (!String(dev?.provides ?? '').split(',').includes('server')) continue;
    for (const conn of dev?.connections ?? dev?.Connection ?? []) {
      const relay = !!conn?.relay;
      const local = !!(conn?.local ?? conn?.$?.local) && !relay;
      // Prefer the raw address for a LAN hop; keep plex.direct for anything
      // that has to cross the internet (its certificate is the point there).
      const address = conn?.address;
      const port = conn?.port ?? 32400;
      const built = local && address
        ? `http://${address}:${port}`
        : (conn?.uri ?? (address ? `http://${address}:${port}` : null));
      if (!built || seen.has(built)) continue;
      seen.add(built);
      candidates.push({ name: String(dev?.name ?? 'Plex Server'), url: String(built), local, owned: !!dev?.owned });
    }
  }

  // Probe in parallel — a dead Docker-bridge address costs the timeout, and
  // there can be half a dozen of them.
  const reachable = await Promise.all(candidates.map((c) => isReachable(c.url, probeTimeoutMs)));

  return candidates
    .map((c, i) => ({ ...c, _ok: reachable[i] }))
    .sort((a, b) =>
      Number(b._ok) - Number(a._ok) ||
      Number(b.local) - Number(a.local) ||
      Number(b.owned) - Number(a.owned))
    .map(({ _ok, ...s }) => s);
}

/**
 * Sign in with a plex.tv email and password, returning that account's token.
 *
 * Exposed separately from authenticateUser() so the login screen can treat it
 * like the device link: both end with a token, and both then list the account's
 * servers. authenticateUser() reaches the same plex.tv endpoint when handed a
 * password, but has no way to carry a 2FA code through the three-argument
 * signature it shares with the Jellyfin backend.
 *
 * `verificationCode` is the 6-digit code from the authenticator app, required
 * only for accounts with two-factor enabled.
 */
export async function authenticatePlexAccount(
  login: string,
  password: string,
  verificationCode?: string
): Promise<string> {
  const url = `${PLEX_TV}/users/signin?${new URLSearchParams(identityParams()).toString()}`;
  const body: Record<string, string> = { login, password };
  if (verificationCode) body.verificationCode = verificationCode;

  let res: any;
  try {
    res = JSON.parse(await plexRequest('POST', url, JSON.stringify(body)));
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // plex.tv answers 401 both for bad credentials and for "correct password,
    // but this account needs its 2FA code" — the body distinguishes them, and
    // guessing wrong sends people to reset a password that was fine.
    if (/verification code/i.test(msg)) {
      throw new Error('This account uses two-factor auth — add the 6-digit code.');
    }
    if (/^HTTP error 401:/.test(msg)) {
      throw new Error('Incorrect Plex email or password.');
    }
    if (/^HTTP error 429:/.test(msg)) {
      throw new Error('plex.tv is rate-limiting sign-ins. Wait a minute and try again.');
    }
    throw new Error(msg || 'Failed to sign in to plex.tv.');
  }

  const token = res?.authToken || res?.authentication_token;
  if (!token) throw new Error('plex.tv did not return a token.');
  return String(token);
}

/** Whoever the token belongs to, as reported by the server's account list. */
async function currentAccount(base: string, token: string): Promise<{ id: string; name: string }> {
  try {
    const c = await plexGet(base, '/accounts', token);
    const accounts: any[] = c?.Account ?? [];
    // id 1 is the server owner; anything else with a name is a shared/Home user.
    const owner = accounts.find((a) => String(a?.id) === '1' && a?.name);
    if (owner) return { id: String(owner.id), name: String(owner.name) };
    const named = accounts.find((a) => a?.name);
    if (named) return { id: String(named.id), name: String(named.name) };
  } catch (e) {
    console.warn('[Plex] Could not read the server account list:', e);
  }
  return { id: '1', name: 'Plex' };
}

/** Exchange an admin token + a Home user's PIN for that user's own token, so
 *  watch state and Continue Watching land on the right profile. */
async function switchHomeUser(
  base: string,
  adminToken: string,
  userName: string,
  pin: string
): Promise<{ accessToken: string; userId: string; userName: string } | null> {
  const listUrl = `https://plex.tv/api/v2/home/users?${new URLSearchParams(identityParams(adminToken)).toString()}`;
  const list = JSON.parse(await plexRequest('GET', listUrl));
  const users: any[] = list?.users ?? list ?? [];
  const match = users.find(
    (u: any) => String(u?.title ?? u?.username ?? '').toLowerCase() === userName.toLowerCase()
  );
  if (!match?.uuid && !match?.id) return null;

  const switchUrl =
    `https://plex.tv/api/v2/home/users/${encodeURIComponent(match.uuid ?? match.id)}/switch` +
    `?${new URLSearchParams({ ...identityParams(adminToken), ...(pin ? { pin } : {}) }).toString()}`;
  const res = JSON.parse(await plexRequest('POST', switchUrl));
  const accessToken = res?.authToken;
  if (!accessToken) return null;

  // A Home user exists on the ACCOUNT, which doesn't mean they were granted
  // this server. Returning an unauthorized token here would log them in and
  // then sync zero libraries, which reads as a broken app rather than a
  // permissions problem — so fail over to the caller's next auth route instead.
  if (!(await validateToken(base, accessToken))) {
    console.warn(`[Plex] Home user "${userName}" has no access to this server.`);
    return null;
  }
  return {
    accessToken,
    userId: String(match.id ?? match.uuid),
    userName: String(match.title ?? match.username ?? userName),
  };
}

function safeLocalStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The membership-card rack's user list.
 *
 * Jellyfin serves this unauthenticated at `/Users/Public`; Plex has no
 * equivalent — `/accounts` needs a token. So this reads the token main.ts
 * persists (the same localStorage keys stopActiveEncoding() already relies on)
 * and returns `[]` when there isn't one, which membership-cards.ts treats as
 * "fall back to the classic single-login form" — exactly the documented
 * contract for the Jellyfin version.
 */
export async function fetchPublicUsers(plexUrl_: string): Promise<PublicUser[]> {
  const base = normalizeUrl(plexUrl_);
  const token = safeLocalStorage('jellyfin_token');
  if (!token) return [];

  // plex.tv's Home roster is the richer source (real avatars, PIN flags), but
  // it needs the internet. Fall back to the server's own list so a LAN-only
  // box still gets a card rack.
  try {
    const listUrl = `https://plex.tv/api/v2/home/users?${new URLSearchParams(identityParams(token)).toString()}`;
    const list = JSON.parse(await plexRequest('GET', listUrl));
    const users: any[] = list?.users ?? [];
    const mapped = users
      .map((u: any) => ({
        id: String(u?.id ?? u?.uuid ?? ''),
        name: String(u?.title ?? u?.username ?? ''),
        hasPassword: !!u?.protected,
        primaryImageTag: u?.thumb || undefined,
      }))
      .filter((u) => !!u.id && !!u.name);
    if (mapped.length > 0) return mapped;
  } catch (e) {
    console.info('[Plex] plex.tv Home roster unavailable, using the server account list:', e);
  }

  try {
    const c = await plexGet(base, '/accounts', token);
    return (c?.Account ?? [])
      .map((a: any) => ({
        id: String(a?.id ?? ''),
        name: String(a?.name ?? ''),
        hasPassword: false,
        primaryImageTag: a?.thumb || undefined,
      }))
      // The server pads this list with dozens of empty-named rows (one per
      // sharing invite that never completed) — only named accounts are people.
      .filter((u: PublicUser) => !!u.id && !!u.name);
  } catch (e) {
    console.warn('[Plex] Could not list users:', e);
    return [];
  }
}

/**
 * Avatar for a membership card. `primaryImageTag` carries Plex's avatar URL
 * (absolute, on plex.tv) rather than an image tag — routed through the
 * server's photo transcoder so the picture is fetched by the SERVER and the
 * browser still only ever talks to the LAN.
 */
export function buildUserAvatarUrl(plexUrl_: string, _userId: string, primaryImageTag?: string): string | null {
  if (!primaryImageTag) return null;
  const base = normalizeUrl(plexUrl_);
  const token = safeLocalStorage('jellyfin_token') ?? '';
  if (/^https?:\/\//i.test(primaryImageTag)) {
    return plexUrl(base, '/photo/:/transcode', token, {
      width: 300, height: 300, minSize: 1, upscale: 1, url: primaryImageTag,
    });
  }
  return plexUrl(base, primaryImageTag, token);
}

// ─── Image URLs ──────────────────────────────────────────────────────────────

/**
 * Poster/backdrop/still through Plex's photo transcoder.
 *
 * Always transcoded rather than served raw: Plex stores 1000×1500 posters and
 * the store uploads every one of them as a GPU texture, so asking the server
 * for the size actually needed keeps VRAM and first-paint sane. Plex caches
 * the resized output, so this costs one resize per image per server lifetime.
 */
function imageUrl(base: string, token: string, path: string | undefined, width: number, height: number): string | undefined {
  if (!path) return undefined;
  return plexUrl(base, '/photo/:/transcode', token, {
    width, height, url: path,
    // `format`/`quality` are NOT optional tuning. Without them Plex answers a
    // full-quality PNG — one 600px sleeve came back at 761 KB, and `upscale=1`
    // made it worse by re-enlarging past the requested size. A library's worth
    // of those is hundreds of megabytes of texture upload before anything is on
    // a shelf. The same image as a quality-70 JPEG is ~56 KB: a 13x saving with
    // no visible difference at the size a case is drawn.
    format: 'jpeg',
    quality: 70,
  });
}

// ─── Metadata mapping ────────────────────────────────────────────────────────

const MS_PER_MIN = 60_000;
/** Jellyfin "ticks" are 100 ns. Plex talks milliseconds everywhere. */
const TICKS_PER_MS = 10_000;

function tagList(arr: any[] | undefined, limit?: number): string[] {
  const names = (arr ?? []).map((t: any) => String(t?.tag ?? '')).filter(Boolean);
  return limit ? names.slice(0, limit) : names;
}

/** Plex reports `videoResolution: "4k"`; fall back to raw dimensions and then
 *  to the filename, mirroring the Jellyfin checkIs4k() ladder. */
function checkIs4k(item: any): boolean {
  for (const media of item?.Media ?? []) {
    if (String(media?.videoResolution ?? '').toLowerCase() === '4k') return true;
    if ((media?.width ?? 0) >= 3840 || (media?.height ?? 0) >= 2160) return true;
  }
  const path = item?.Media?.[0]?.Part?.[0]?.file ?? '';
  return /\b(4k|2160p)\b/i.test(String(item?.title ?? '')) || /\b(4k|2160p)\b/i.test(path);
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function qualityTag(width?: number, height?: number): string | undefined {
  const w = width ?? 0;
  const h = height ?? 0;
  if (w >= 3200 || h >= 2000) return '4K';
  if (w >= 1800 || h >= 1030) return '1080p';
  if (w >= 1150 || h >= 690) return '720p';
  if (w > 0 || h > 0) return 'SD';
  return undefined;
}

/**
 * Audio/subtitle tracks of one Part, for the player's track picker.
 *
 * `index` carries Plex's stream **id**, not its ffmpeg index: the transcoder's
 * `audioStreamID`/`subtitleStreamID` params want the id, and this field is
 * documented as an opaque handle the backend hands back to itself. plex.ts is
 * both producer and consumer, so the round-trip is closed.
 */
function extractStreamsFromPart(part: any): MediaStreamInfo[] | undefined {
  const raw = part?.Stream;
  if (!Array.isArray(raw)) return undefined;
  const streams: MediaStreamInfo[] = raw
    .filter((s: any) => (s?.streamType === 2 || s?.streamType === 3) && s?.id !== undefined)
    .map((s: any) => ({
      index: Number(s.id),
      type: s.streamType === 2 ? ('Audio' as const) : ('Subtitle' as const),
      language: s.language || s.languageTag || undefined,
      displayTitle: s.displayTitle || s.extendedDisplayTitle || undefined,
      codec: s.codec || undefined,
      isDefault: !!s.default,
      channels: s.streamType === 2 && typeof s.channels === 'number' ? s.channels : undefined,
    }));
  return streams.length > 0 ? streams : undefined;
}

/** Container/codec info for the direct-play decision. Comes off Media[], which
 *  Plex DOES include in list responses — so this is populated in bulk even
 *  though per-track Stream[] data is not. */
function extractPlaybackInfoFromMedia(media: any): MediaPlaybackInfo | undefined {
  if (!media) return undefined;
  const partStreams: any[] = media?.Part?.[0]?.Stream ?? [];
  const audioFromStreams = partStreams
    .filter((s: any) => s?.streamType === 2 && s?.codec)
    .map((s: any) => String(s.codec).toLowerCase());
  const video = partStreams.find((s: any) => s?.streamType === 1);
  return {
    container: media.container ? String(media.container).toLowerCase() : undefined,
    videoCodec: media.videoCodec ? String(media.videoCodec).toLowerCase() : undefined,
    // The list view gives one summary audioCodec; the detail view gives every
    // track. Prefer the full list when it's there — isDirectPlaySafe() requires
    // EVERY audio codec to be safe, and a file whose second track is AC3 must
    // not pass on the strength of a first-track AAC.
    audioCodecs: audioFromStreams.length > 0
      ? audioFromStreams
      : (media.audioCodec ? [String(media.audioCodec).toLowerCase()] : []),
    width: typeof media.width === 'number' ? media.width : undefined,
    height: typeof media.height === 'number' ? media.height : undefined,
    aspectRatio: media.aspectRatio !== undefined ? String(media.aspectRatio) : undefined,
    videoRange: video?.DOVIPresent ? 'DOVI' : (video?.colorTrc === 'smpte2084' ? 'HDR10' : undefined),
  };
}

/**
 * One MovieVersion per Media[] entry — Plex's native model for "the 4K remux
 * and the 1080p rip of the same film", which is exactly what the version
 * picker wants.
 *
 * `mediaSourceId` holds the Media's ARRAY INDEX as a string, because that is
 * what the transcoder's `mediaIndex` param takes. Like MediaStreamInfo.index
 * above, it is an opaque handle plex.ts hands back to itself.
 */
function buildItemVersions(item: any): MovieVersion[] {
  const medias: any[] = Array.isArray(item?.Media) && item.Media.length > 0 ? item.Media : [null];
  return medias.map((media, mediaIndex): MovieVersion => {
    const part = media?.Part?.[0];
    const width: number | undefined = typeof media?.width === 'number' ? media.width : undefined;
    const height: number | undefined = typeof media?.height === 'number' ? media.height : undefined;
    const path: string = part?.file ?? '';
    const is4k =
      String(media?.videoResolution ?? '').toLowerCase() === '4k' ||
      (width ?? 0) >= 3840 || (height ?? 0) >= 2160 || /\b(4k|2160p)\b/i.test(path);
    const tag = is4k ? '4K' : qualityTag(width, height);
    const info = extractPlaybackInfoFromMedia(media);
    const range = info?.videoRange && /hdr|dovi/i.test(info.videoRange) ? 'HDR' : undefined;
    const codec = media?.videoCodec ? String(media.videoCodec).toUpperCase() : undefined;
    const size = typeof part?.size === 'number' && part.size > 0 ? formatBytes(part.size) : undefined;
    const label = [tag, range, codec, size].filter(Boolean).join(' · ') || 'Original';
    return {
      itemId: String(item?.ratingKey ?? ''),
      mediaSourceId: medias.length > 1 ? String(mediaIndex) : undefined,
      label,
      is4k,
      width,
      height,
      localPath: path || undefined,
      mediaStreams: extractStreamsFromPart(part),
      mediaPlaybackInfo: info,
    };
  });
}

/** tmdb id out of Plex's Guid[] (`tmdb://8065`), for the Jellyseerr/TMDB paths. */
function extractTmdbId(item: any): number | undefined {
  for (const g of item?.Guid ?? []) {
    const m = /^tmdb:\/\/(\d+)$/.exec(String(g?.id ?? ''));
    if (m) {
      const id = Number(m[1]);
      if (Number.isFinite(id) && id > 0) return id;
    }
  }
  return undefined;
}

/** Watch state. Plex puts it straight on the item for the token's own user. */
function extractWatchState(item: any): Pick<Movie, 'played' | 'playCount' | 'lastPlayedDate'> {
  const count = typeof item?.viewCount === 'number' ? item.viewCount : 0;
  return {
    played: count > 0 || undefined,
    playCount: count > 0 ? count : undefined,
    lastPlayedDate: typeof item?.lastViewedAt === 'number'
      ? new Date(item.lastViewedAt * 1000).toISOString()
      : undefined,
  };
}

/**
 * Part keys for direct play, remembered from whatever response last described
 * this item.
 *
 * Plex's direct-file URL is `/library/parts/{partId}/{n}/file.ext` — it cannot
 * be derived from a ratingKey alone, and buildStaticStreamUrl() is synchronous
 * so it cannot go fetch one. Every response that carries Media[] therefore
 * records its parts here. For episodes (whose list responses are deliberately
 * slim) the cache is filled by fetchItemPlaybackInfo(), which
 * launchVideoPlayback already calls right before opening the player.
 *
 * Keyed `${ratingKey}:${mediaIndex}`.
 */
const partKeyCache = new Map<string, string>();

/**
 * Runtime in milliseconds per item, recorded from the same responses.
 *
 * Needed because Plex's /:/timeline SILENTLY DISCARDS an update whose
 * `duration` is 0 — no viewOffset, no lastViewedAt, no error — and the
 * reporting functions only receive an item id (they share the Jellyfin
 * backend's signature, which needs no duration).
 */
const durationCache = new Map<string, number>();

/**
 * Ids known to be music. Plex serves audio from a DIFFERENT transcoder than
 * video — /music/:/transcode/... — and answers 400 to a video transcode request
 * for a track. buildStaticStreamUrl/buildHlsStreamUrl are synchronous and get
 * only an id, so the type has to be remembered when it passes through.
 */
const musicItems = new Set<string>();

/** Record whatever a response tells us about an item, for the synchronous and
 *  id-only callers that can't go fetch it themselves. */
function rememberItem(item: any): void {
  const ratingKey = String(item?.ratingKey ?? '');
  if (!ratingKey) return;
  const t = String(item?.type ?? '');
  if (t === 'track' || t === 'album') musicItems.add(ratingKey);
  if (typeof item?.duration === 'number' && item.duration > 0) {
    durationCache.set(ratingKey, item.duration);
  }
  (item?.Media ?? []).forEach((media: any, i: number) => {
    const key = media?.Part?.[0]?.key;
    if (key) {
      partKeyCache.set(`${ratingKey}:${i}`, String(key));
      if (i === 0) partKeyCache.set(ratingKey, String(key));
    }
  });
}

/** name (lower-cased) → the person's Plex id and portrait. */
type ActorIndex = Map<string, { id: string; thumb?: string }>;

/**
 * Every actor in one library, with ids and portraits.
 *
 * A listing's Role[] entries are bare names, and the wall décor wants real
 * portraits for the library's most-featured faces (wall-decor.ts). Rather than
 * fetch the detail view of all N titles, this pulls the section's own cast
 * index once — a single request covering the whole library — and the mapper
 * joins on name. Failure is non-fatal: `actors` (names) is populated either
 * way, and the décor falls back to its generated faces.
 */
async function fetchActorIndex(base: string, token: string, sectionId: string): Promise<ActorIndex> {
  const index: ActorIndex = new Map();
  try {
    const c = await plexGet(base, `/library/sections/${sectionId}/actor`, token);
    for (const a of c?.Directory ?? []) {
      const name = String(a?.title ?? '');
      if (name) index.set(name.toLowerCase(), { id: String(a?.key ?? name), thumb: a?.thumb || undefined });
    }
  } catch (e) {
    console.warn(`[Plex] Cast index unavailable for section ${sectionId} — portraits will be generated:`, e);
  }
  return index;
}

/** Plex item (movie or show) → the store's Movie. */
function mapItemToMovie(
  item: any,
  base: string,
  token: string,
  libraryName: string,
  actorIndex?: ActorIndex
): Movie {
  rememberItem(item);
  const isSeries = item?.type === 'show';
  const durationMin = Math.round((item?.duration ?? 0) / MS_PER_MIN);

  return {
    id: String(item?.ratingKey ?? ''),
    title: String(item?.title ?? 'Untitled'),
    year: item?.year || 2000,
    premiereDate: item?.originallyAvailableAt || undefined,
    duration: isSeries ? 'Series' : (durationMin > 0 ? `${durationMin}m` : 'N/A'),
    rating: item?.contentRating || 'NR',
    overview: item?.summary || 'No description available.',
    director: tagList(item?.Director, 1)[0] || 'Unknown Director',
    actors: tagList(item?.Role, 5),
    castPeople: (item?.Role ?? [])
      .filter((r: any) => r?.tag)
      .slice(0, 5)
      .map((r: any) => {
        // A listing's Role is name-only; the id and portrait come from the
        // library's cast index (see fetchActorIndex). Detail-view responses do
        // carry them inline, so prefer those when present.
        const known = actorIndex?.get(String(r.tag).toLowerCase());
        const thumb = r.thumb ?? known?.thumb;
        return {
          id: String(r.id ?? r.tagKey ?? known?.id ?? r.tag),
          name: String(r.tag),
          // Plex serves portraits from metadata-static.plex.tv. Routed through
          // the server's photo transcoder so the browser keeps talking only to
          // the LAN (and so the store doesn't add an outbound call per face on
          // the wall décor).
          imageUrl: thumb ? imageUrl(base, token, thumb, 300, 300) : undefined,
        };
      }),
    genres: tagList(item?.Genre),
    localPath: item?.Media?.[0]?.Part?.[0]?.file ?? '',
    posterUrl: imageUrl(base, token, item?.thumb, 600, 900),
    backdropUrl: imageUrl(base, token, item?.art, 1920, 1080),
    dateCreated: typeof item?.addedAt === 'number' ? new Date(item.addedAt * 1000).toISOString() : '',
    isSeries,
    is4k: checkIs4k(item),
    // Plex's audienceRating is already the 0–10 the store expects…
    communityRating: typeof item?.audienceRating === 'number' ? item.audienceRating : undefined,
    // …while `rating` is the 0–10 critic score and criticRating wants 0–100
    // (a Rotten Tomatoes percentage), so it scales by 10.
    criticRating: typeof item?.rating === 'number' ? Math.round(item.rating * 10) : undefined,
    libraryName,
    studios: item?.studio ? [String(item.studio)] : [],
    // Absent in list responses — Plex ignores includeStreams there. Filled in
    // on demand by fetchItemPlaybackInfo() before playback.
    mediaStreams: extractStreamsFromPart(item?.Media?.[0]?.Part?.[0]),
    mediaPlaybackInfo: extractPlaybackInfoFromMedia(item?.Media?.[0]),
    // Plex reports no poster aspect ratio; flat mode falls back to its default
    // 2:3 until the image loads.
    primaryImageAspectRatio: undefined,
    versions: isSeries ? undefined : buildItemVersions(item),
    tmdbId: extractTmdbId(item),
    ...extractWatchState(item),
  };
}

// ─── Catalog sync ────────────────────────────────────────────────────────────

/** Plex caps a response at 'X-Plex-Container-Size'; walk the whole section. */
const PAGE_SIZE = 200;

async function fetchSectionPaged(
  base: string,
  token: string,
  sectionId: string,
  onPage?: () => void
): Promise<any[]> {
  const out: any[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const c = await plexGet(base, `/library/sections/${sectionId}/all`, token, {
      // Guid[] carries the tmdb id used by the Jellyseerr/TMDB features. It is
      // opt-in on list responses and free to ask for.
      includeGuids: 1,
      'X-Plex-Container-Start': start,
      'X-Plex-Container-Size': PAGE_SIZE,
    });
    const items: any[] = c?.Metadata ?? [];
    out.push(...items);
    onPage?.();
    const total = typeof c?.totalSize === 'number' ? c.totalSize : out.length;
    if (items.length === 0 || out.length >= total) break;
  }
  return out;
}

/**
 * Sync every video library on the server.
 *
 * Named for the Jellyfin function it stands in for so backend.ts can swap the
 * two without main.ts noticing.
 */
export async function fetchJellyfinLibrariesAndMovies(
  plexUrl_: string,
  token: string,
  _userId: string,
  onProgress?: (stage: string) => void
): Promise<JellyfinLibrary[]> {
  if (!token || !plexUrl_) throw new Error('Missing connection credentials.');
  const base = normalizeUrl(plexUrl_);
  console.log('[Plex] Querying library sections...');

  try {
    const sectionsContainer = await plexGet(base, '/library/sections', token);
    const sections: any[] = sectionsContainer?.Directory ?? [];

    // Allowlist, unlike the Jellyfin path's blocklist: Plex's section `type` is
    // a small closed vocabulary that servers report consistently, so there is
    // no "mixed"/"unknown" ambiguity to defend against. Only movie and show
    // sections hold shelf-able video; artist/photo sections are skipped.
    const videoSections = sections.filter((s: any) => {
      const keep = s?.type === 'movie' || s?.type === 'show';
      console.info(
        `[Plex] Section "${s?.title}" (type=${s?.type}): ${keep ? 'syncing' : 'skipped (non-video)'}`
      );
      return keep;
    });

    const libraryResults = await Promise.all(
      videoSections.map(async (section: any): Promise<JellyfinLibrary | null> => {
        const name = String(section?.title ?? 'Library');
        const id = String(section?.key ?? '');
        console.log(`[Plex] Syncing catalog for library "${name}" (${id})...`);
        onProgress?.(`library "${name}"`);
        try {
          const [items, actorIndex] = await Promise.all([
            fetchSectionPaged(base, token, id, () => onProgress?.('page')),
            fetchActorIndex(base, token, id),
          ]);
          if (items.length === 0) return null;

          const movies = items.map((item) => mapItemToMovie(item, base, token, name, actorIndex));
          const collapsed = collapseDuplicateVersions(movies, `library "${name}"`);

          const genresSet = new Set<string>();
          collapsed.forEach((m) => m.genres.forEach((g) => genresSet.add(g)));

          return { id, name, movies: collapsed, genres: Array.from(genresSet).sort() };
        } catch (err) {
          console.error(`[Plex] Failed to sync library "${name}":`, err);
          return null;
        }
      })
    );

    const libraries = libraryResults.filter((l): l is JellyfinLibrary => l !== null);
    if (libraries.length === 0) throw new Error('No movies found in your Plex libraries.');

    onProgress?.('collection membership');
    await applyCollectionMembership(libraries, base, token);

    onProgress?.('done');
    console.log(`[Plex] Successfully mapped ${libraries.length} libraries.`);
    return libraries;
  } catch (error: any) {
    console.error('[Plex] Failed to sync libraries and metadata:', error);
    const msg = error?.message ?? String(error);
    throw new Error(msg || 'Failed to sync libraries from Plex server.');
  }
}

/**
 * Tag synced movies with their collection name so a series of films shelves
 * together in release order. Non-fatal by design — without it the shelves are
 * simply alphabetical.
 */
async function applyCollectionMembership(
  libraries: JellyfinLibrary[],
  base: string,
  token: string
): Promise<void> {
  try {
    const byId = new Map<string, Movie>();
    for (const lib of libraries) for (const m of lib.movies) byId.set(m.id, m);

    let tagged = 0;
    let collections = 0;
    for (const lib of libraries) {
      const c = await plexGet(base, `/library/sections/${lib.id}/collections`, token);
      for (const coll of c?.Metadata ?? []) {
        collections++;
        const children = await plexGet(base, `/library/collections/${coll.ratingKey}/children`, token);
        for (const child of children?.Metadata ?? []) {
          const movie = byId.get(String(child?.ratingKey));
          if (movie) {
            movie.collectionName = String(coll?.title ?? '');
            tagged++;
          }
        }
        // Feeds jellyseerr.ts's collection-gap lookup, exactly as the Jellyfin
        // BoxSet sync does.
        const tmdb = extractTmdbId(coll);
        if (tmdb) collectionTmdbIds.set(String(coll?.title ?? ''), tmdb);
      }
    }
    collectionSyncStats.boxSets = collections;
    console.log(`[Plex] Tagged ${tagged} titles from ${collections} collections.`);
  } catch (err) {
    console.warn('[Plex] Collection sync failed — shelves stay alphabetical:', err);
  }
}

// ─── Episodes ────────────────────────────────────────────────────────────────

/** `/allLeaves` is every episode of a show, already in season/episode order —
 *  no explicit sort needed (contrast the Jellyfin path, which had to ask for
 *  ParentIndexNumber,IndexNumber to stop getting a title-sorted list). */
export async function fetchSeriesEpisodes(
  plexUrl_: string,
  token: string,
  _userId: string,
  seriesId: string
): Promise<Episode[]> {
  const base = normalizeUrl(plexUrl_);
  try {
    let c = await plexGet(base, `/library/metadata/${seriesId}/allLeaves`, token, {
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': 500,
    });
    // /allLeaves walks a show's season->episode tree and returns NOTHING for an
    // album, whose tracks are direct children. Fall back so a record's tracklist
    // works through the same picker a series uses.
    if (!(c?.Metadata ?? []).length) {
      c = await plexGet(base, `/library/metadata/${seriesId}/children`, token, {
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': 500,
      });
    }
    return (c?.Metadata ?? []).map((item: any): Episode => {
      rememberItem(item);
      return {
        id: String(item?.ratingKey ?? ''),
        seriesId,
        seriesName: String(item?.grandparentTitle ?? ''),
        seasonNumber: item?.parentIndex ?? 0,
        episodeNumber: item?.index ?? 0,
        name: String(item?.title ?? ''),
        overview: String(item?.summary ?? ''),
        path: item?.Media?.[0]?.Part?.[0]?.file ?? '',
        runTimeTicks: (item?.duration ?? 0) * TICKS_PER_MS,
        thumbUrl: imageUrl(base, token, item?.thumb, 400, 225),
        seasonId: item?.parentRatingKey !== undefined ? String(item.parentRatingKey) : undefined,
        // parentThumb is the SEASON poster (2:3), which is what the season chip
        // wants — item.thumb on an episode is the 16:9 still.
        seasonPrimaryUrl: imageUrl(base, token, item?.parentThumb, 400, 600),
      };
    });
  } catch (e) {
    console.error(`[Plex] Failed to fetch episodes for series ${seriesId}:`, e);
    return [];
  }
}

export async function fetchFirstEpisodeOfSeries(
  plexUrl_: string,
  token: string,
  _userId: string,
  seriesId: string
): Promise<{ id: string; path: string } | null> {
  const base = normalizeUrl(plexUrl_);
  try {
    let c = await plexGet(base, `/library/metadata/${seriesId}/allLeaves`, token, {
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': 1,
    });
    if (!(c?.Metadata ?? []).length) {
      c = await plexGet(base, `/library/metadata/${seriesId}/children`, token, {
        'X-Plex-Container-Start': 0,
        'X-Plex-Container-Size': 1,
      });
    }
    const item = c?.Metadata?.[0];
    if (!item) return null;
    rememberItem(item);
    return { id: String(item.ratingKey), path: item?.Media?.[0]?.Part?.[0]?.file ?? '' };
  } catch (e) {
    console.error(`[Plex] Failed to fetch first episode for series ${seriesId}:`, e);
    return null;
  }
}

// ─── Music: albums as shelf stock ────────────────────────────────────────────

/**
 * Year at or before which a release is stocked on vinyl rather than CD.
 *
 * 1991 is when CD sales overtook vinyl in the US, so a shop set just after that
 * shelves racks of CDs beside a shrinking LP section — which is what a real
 * 1993 record store looked like. On a typical modern library this lands ~10% of
 * albums on vinyl: enough to fill a browser bin, not enough to pretend the CD
 * never happened. Slide it forward for an all-vinyl shop.
 */
const DEFAULT_VINYL_CUTOFF_YEAR = 1991;

function vinylCutoffYear(): number {
  try {
    const raw = Number(localStorage.getItem('bb_vinyl_cutoff'));
    if (Number.isFinite(raw) && raw >= 1900 && raw <= 2100) return raw;
  } catch {
    /* no storage */
  }
  return DEFAULT_VINYL_CUTOFF_YEAR;
}

/** Which format the shop stocks a release on. Unknown year → CD (the safer
 *  default: a jewel case reads fine for anything, an LP sleeve on a 2024
 *  digital-only release does not). */
function mediumForYear(year: number | undefined): 'vinyl' | 'cd' {
  return year && year <= vinylCutoffYear() ? 'vinyl' : 'cd';
}

/** Genre + country per artist, keyed by artist ratingKey. */
type ArtistIndex = Map<string, { genres: string[]; country?: string; thumb?: string }>;

/**
 * Genres and countries for every artist in a music section.
 *
 * Plex puts NO genre on an album — it lives on the artist — so a shop that
 * wants genre sections has to join the two. Fetching artists in bulk (type=8,
 * one paged request per section) beats a detail call per album by three orders
 * of magnitude, and it picks up `Country` on the way, which is what makes an
 * IMPORT bin possible.
 */
async function fetchArtistIndex(base: string, token: string, sectionId: string): Promise<ArtistIndex> {
  const index: ArtistIndex = new Map();
  try {
    for (let start = 0; ; start += PAGE_SIZE) {
      const c = await plexGet(base, `/library/sections/${sectionId}/all`, token, {
        type: 8,
        'X-Plex-Container-Start': start,
        'X-Plex-Container-Size': PAGE_SIZE,
      });
      const items: any[] = c?.Metadata ?? [];
      for (const a of items) {
        const key = String(a?.ratingKey ?? '');
        if (!key) continue;
        index.set(key, {
          genres: tagList(a?.Genre),
          country: tagList(a?.Country, 1)[0],
          thumb: a?.thumb || undefined,
        });
      }
      const total = typeof c?.totalSize === 'number' ? c.totalSize : index.size;
      if (items.length === 0 || index.size >= total) break;
    }
  } catch (e) {
    console.warn(`[Plex] Artist index unavailable for section ${sectionId} — albums lose genres:`, e);
  }
  return index;
}

/** One Plex album → the store's Movie shape. */
function mapAlbumToMovie(
  item: any,
  base: string,
  token: string,
  libraryName: string,
  artists: ArtistIndex
): Movie {
  rememberItem(item);
  const artistKey = String(item?.parentRatingKey ?? '');
  const artist = artists.get(artistKey);
  const year = item?.year || undefined;
  const trackCount = typeof item?.leafCount === 'number' ? item.leafCount : undefined;
  const plays = typeof item?.viewCount === 'number' ? item.viewCount : 0;

  return {
    id: String(item?.ratingKey ?? ''),
    title: String(item?.title ?? 'Untitled'),
    year: year || 2000,
    premiereDate: item?.originallyAvailableAt || undefined,
    // Where a film prints its runtime, a record prints its FORMAT. Neither
    // runtime nor track count is available in bulk: Plex withholds `leafCount`
    // from album list responses (no parameter coaxes it out — checked), and
    // fetching it would be one detail call per album. The tracklist supplies the
    // real count when the sleeve is turned over, which is the only time it
    // matters. See fetchAlbumTracks.
    duration: mediumForYear(year) === 'vinyl' ? 'LP' : 'CD',
    rating: 'NR',
    overview: item?.summary || 'No description available.',
    // A record's "author" is its performer. Kept in BOTH places on purpose:
    // `artist` is what record-store code prints, `director` is what the
    // existing video-store back-of-box template already reads.
    director: artist ? String(item?.parentTitle ?? '') : String(item?.parentTitle ?? ''),
    artist: String(item?.parentTitle ?? ''),
    actors: [],
    genres: artist?.genres ?? [],
    localPath: '',
    posterUrl: imageUrl(base, token, item?.thumb, 500, 500),
    // No per-album backdrop. The artist portrait is only ever wanted when a
    // record is INSPECTED, and requesting a large one for every album in the
    // shop cost a second full-size image per title for something almost never
    // drawn. artistId is kept so the inspect view can fetch one on demand.
    backdropUrl: undefined,
    dateCreated: typeof item?.addedAt === 'number' ? new Date(item.addedAt * 1000).toISOString() : '',
    // An album is a CONTAINER of playable children, exactly like a series — and
    // flagging it as one is what makes the existing picker open a tracklist
    // instead of trying to play the album id, which Plex cannot stream.
    isSeries: true,
    is4k: false,
    libraryName,
    studios: item?.studio ? [String(item.studio)] : [],
    label: item?.studio ? String(item.studio) : undefined,
    album: true,
    trackCount,
    recordMedium: mediumForYear(year),
    country: artist?.country,
    artistId: artistKey || undefined,
    played: plays > 0 || undefined,
    playCount: plays > 0 ? plays : undefined,
    lastPlayedDate: typeof item?.lastViewedAt === 'number'
      ? new Date(item.lastViewedAt * 1000).toISOString()
      : undefined,
    primaryImageAspectRatio: 1, // sleeves are square, unlike a 2:3 poster
  };
}

/**
 * Every album on the server, ready to shelve.
 *
 * Music sections are the ones fetchJellyfinLibrariesAndMovies() deliberately
 * skips — a video store has no business shelving them. The record-store mode
 * calls this instead.
 */
export async function fetchMusicAlbums(
  plexUrl_: string,
  token: string,
  onProgress?: (stage: string) => void
): Promise<Movie[]> {
  if (!token || !plexUrl_) throw new Error('Missing connection credentials.');
  const base = normalizeUrl(plexUrl_);
  console.log('[Plex] Querying music sections...');

  const sectionsContainer = await plexGet(base, '/library/sections', token);
  const musicSections: any[] = (sectionsContainer?.Directory ?? []).filter((s: any) => s?.type === 'artist');
  if (musicSections.length === 0) throw new Error('No music libraries found on this Plex server.');

  const perSection = await Promise.all(
    musicSections.map(async (section: any): Promise<Movie[]> => {
      const name = String(section?.title ?? 'Music');
      const id = String(section?.key ?? '');
      onProgress?.(`music library "${name}"`);
      try {
        // Albums and the artist index in parallel — neither needs the other
        // until the mapping step.
        const [albums, artists] = await Promise.all([
          (async () => {
            const out: any[] = [];
            for (let start = 0; ; start += PAGE_SIZE) {
              const c = await plexGet(base, `/library/sections/${id}/all`, token, {
                type: 9, // album
                'X-Plex-Container-Start': start,
                'X-Plex-Container-Size': PAGE_SIZE,
              });
              const items: any[] = c?.Metadata ?? [];
              out.push(...items);
              onProgress?.('page');
              const total = typeof c?.totalSize === 'number' ? c.totalSize : out.length;
              if (items.length === 0 || out.length >= total) break;
            }
            return out;
          })(),
          fetchArtistIndex(base, token, id),
        ]);
        console.info(`[Plex] Music section "${name}": ${albums.length} albums, ${artists.size} artists.`);
        return albums.map((a) => mapAlbumToMovie(a, base, token, name, artists));
      } catch (err) {
        console.error(`[Plex] Failed to sync music library "${name}":`, err);
        return [];
      }
    })
  );

  const albums = perSection.flat();
  const vinyl = albums.filter((a) => a.recordMedium === 'vinyl').length;
  console.log(`[Plex] ${albums.length} albums (${vinyl} on vinyl, ${albums.length - vinyl} on CD).`);
  onProgress?.('done');
  return albums;
}

/**
 * An album's tracks, shaped as Episodes.
 *
 * Not a hack: album:track and series:episode are the same structure, and the
 * store already has the machinery — an ordered picker, index-based navigation
 * and up-next stepping. A tracklist is what a sleeve back prints, so reusing
 * the episode path gets the whole flow for free.
 */
export async function fetchAlbumTracks(
  plexUrl_: string,
  token: string,
  albumId: string
): Promise<Episode[]> {
  const base = normalizeUrl(plexUrl_);
  try {
    const c = await plexGet(base, `/library/metadata/${albumId}/children`, token, {
      'X-Plex-Container-Start': 0,
      'X-Plex-Container-Size': 500,
    });
    return (c?.Metadata ?? []).map((t: any): Episode => {
      rememberItem(t);
      return {
        id: String(t?.ratingKey ?? ''),
        seriesId: albumId,
        seriesName: String(t?.parentTitle ?? ''),
        // Discs are "seasons": a 2-disc set groups exactly the way a 2-season
        // show does, and the picker already renders that.
        seasonNumber: t?.parentIndex ?? 1,
        episodeNumber: t?.index ?? 0,
        name: String(t?.title ?? ''),
        overview: String(t?.summary ?? ''),
        path: t?.Media?.[0]?.Part?.[0]?.file ?? '',
        runTimeTicks: (t?.duration ?? 0) * TICKS_PER_MS,
        // A track has no still of its own; the sleeve stands in.
        thumbUrl: imageUrl(base, token, t?.parentThumb ?? t?.thumb, 400, 400),
        seasonId: t?.parentRatingKey !== undefined ? String(t.parentRatingKey) : undefined,
        seasonPrimaryUrl: imageUrl(base, token, t?.parentThumb, 400, 400),
      };
    });
  } catch (e) {
    console.error(`[Plex] Failed to fetch tracks for album ${albumId}:`, e);
    return [];
  }
}

// ─── Playback reporting ──────────────────────────────────────────────────────

/**
 * Runtime of an item, from the sync cache or straight from the server.
 *
 * Cache misses are real: an episode played from the picker was recorded by
 * fetchSeriesEpisodes(), but a title reached by some path that never touched
 * the catalog would not be. One metadata GET, cached after.
 */
async function itemDurationMs(base: string, token: string, itemId: string): Promise<number> {
  const cached = durationCache.get(String(itemId));
  if (cached) return cached;
  try {
    const c = await plexGet(base, `/library/metadata/${itemId}`, token);
    const item = c?.Metadata?.[0];
    if (item) {
      rememberItem(item);
      return durationCache.get(String(itemId)) ?? 0;
    }
  } catch (e) {
    console.warn(`[Plex] Could not read duration for item ${itemId}:`, e);
  }
  return 0;
}

/**
 * Plex has one timeline endpoint for start/progress/stop; `state` is the verb.
 *
 * `duration` is NOT optional even though it looks like metadata Plex already
 * has: an update carrying `duration=0` is accepted with a 200 and then thrown
 * away — no viewOffset stored, no lastViewedAt, nothing in Continue Watching,
 * and no error to notice. Verified against 1.43.3. So the runtime is looked up
 * (and cached) rather than defaulted.
 */
async function reportTimeline(
  base: string,
  token: string,
  itemId: string,
  state: 'playing' | 'paused' | 'stopped',
  timeMs: number
): Promise<void> {
  const duration = await itemDurationMs(base, token, itemId);
  if (!duration) {
    // Better to say so than to fire a request Plex will silently discard.
    console.warn(`[Plex] No duration known for item ${itemId} — Plex will ignore this timeline update.`);
  }
  await plexRequest('GET', plexUrl(base, '/:/timeline', token, {
    ratingKey: itemId,
    key: `/library/metadata/${itemId}`,
    state,
    time: Math.max(0, Math.round(timeMs)),
    duration,
  }));
}

export async function reportPlaybackStart(plexUrl_: string, token: string, itemId: string): Promise<void> {
  try {
    await reportTimeline(normalizeUrl(plexUrl_), token, itemId, 'playing', 0);
    console.log(`[Plex] Playback start reported for item ${itemId}`);
  } catch (e) {
    console.warn('[Plex] Failed to report playback start:', e);
  }
}

export async function reportPlaybackStopped(
  plexUrl_: string,
  token: string,
  itemId: string,
  positionTicks?: number
): Promise<void> {
  try {
    await reportTimeline(
      normalizeUrl(plexUrl_), token, itemId, 'stopped', (positionTicks ?? 0) / TICKS_PER_MS
    );
    console.log(`[Plex] Playback stopped reported for item ${itemId}`);
  } catch (e) {
    console.warn('[Plex] Failed to report playback stop:', e);
  }
}

export async function reportPlaybackProgress(
  plexUrl_: string,
  token: string,
  itemId: string,
  positionTicks: number,
  isPaused: boolean
): Promise<void> {
  try {
    await reportTimeline(
      normalizeUrl(plexUrl_), token, itemId, isPaused ? 'paused' : 'playing', positionTicks / TICKS_PER_MS
    );
  } catch (e) {
    console.warn('[Plex] Failed to report playback progress:', e);
  }
}

/**
 * Kill a transcode session immediately instead of waiting for Plex's idle
 * timeout — called before abandoning an HLS stream for a rebuilt one (seek,
 * track change) so the old ffmpeg isn't left encoding for nobody.
 *
 * Like the Jellyfin version this takes only the session id and reads the
 * server/token from the same localStorage keys main.ts persists, because
 * VideoPlayer only ever sees stream URLs.
 */
export async function stopActiveEncoding(playSessionId: string, log?: (msg: string) => void): Promise<void> {
  const base = safeLocalStorage('jellyfin_url');
  const token = safeLocalStorage('jellyfin_token');
  if (!base || !token) return;
  try {
    await plexRequest('GET', plexUrl(normalizeUrl(base), '/video/:/transcode/universal/stop', token, {
      session: playSessionId,
    }));
  } catch (e: any) {
    console.warn('[Plex] Failed to stop active encoding:', e);
    log?.(`[Player] stopActiveEncoding failed: ${e?.message ?? e}`);
  }
}

// ─── Direct-play probe ───────────────────────────────────────────────────────

/**
 * On-demand codec probe for an item whose playback info isn't already in
 * memory — TV episodes in practice, since the episode list is deliberately
 * slim.
 *
 * Doing double duty on Plex: this is also where an episode's Part key and its
 * audio/subtitle tracks enter the caches, because Plex won't put Stream[] in a
 * list response. launchVideoPlayback() already calls this for the exact item
 * it's about to play, so the track picker is populated by the time it matters.
 */
export async function fetchItemPlaybackInfo(
  plexUrl_: string,
  token: string,
  _userId: string,
  itemId: string
): Promise<MediaPlaybackInfo | undefined> {
  const base = normalizeUrl(plexUrl_);
  try {
    const c = await plexGet(base, `/library/metadata/${itemId}`, token, { includeStreams: 1 });
    const item = c?.Metadata?.[0];
    if (!item) return undefined;
    rememberItem(item);
    const streams = extractStreamsFromPart(item?.Media?.[0]?.Part?.[0]);
    if (streams) streamCache.set(String(itemId), streams);
    const info = extractPlaybackInfoFromMedia(item?.Media?.[0]);
    // Hand the tracks back to the caller: this probe is the ONLY point at which
    // Plex will part with them, and launchVideoPlayback runs it immediately
    // before it builds the player's track picker.
    if (info && streams) info.mediaStreams = streams;
    return info;
  } catch (e) {
    console.error(`[Plex] Failed to probe media info for item ${itemId}:`, e);
    return undefined;
  }
}

/** Tracks learned by fetchItemPlaybackInfo(), for callers that then want a
 *  picker for the item they just probed. */
const streamCache = new Map<string, MediaStreamInfo[]>();

/** Audio/subtitle tracks for an item probed earlier this session, if any. */
export function getCachedStreams(itemId: string): MediaStreamInfo[] | undefined {
  return streamCache.get(String(itemId));
}

// ─── Streaming URLs ──────────────────────────────────────────────────────────

/**
 * Direct stream of the original file.
 *
 * Needs the Part key, which can't be derived from a ratingKey — see
 * partKeyCache. A miss returns the transcode-free `/library/metadata/.../file`
 * shortcut, which Plex resolves server-side for the default part; the caller
 * falls back to HLS if that 404s.
 */
export function buildStaticStreamUrl(plexUrl_: string, token: string, itemId: string, mediaSourceId?: string): string {
  const base = normalizeUrl(plexUrl_);
  if (musicItems.has(String(itemId))) return buildMusicStreamUrl(base, token, itemId);
  const cacheKey = mediaSourceId !== undefined ? `${itemId}:${mediaSourceId}` : String(itemId);
  const partKey = partKeyCache.get(cacheKey) ?? partKeyCache.get(String(itemId));
  if (partKey) return plexUrl(base, partKey, token, { download: 0 });
  return plexUrl(base, `/library/metadata/${itemId}/file`, token);
}

/**
 * Audio stream for a track. Plex's music transcoder hands back a plain MP3 over
 * HTTP rather than a segmented playlist — simpler than the video path and what
 * every Plex client uses for audio. FLAC and anything else the browser cannot
 * decode natively is transcoded on the way out.
 */
function buildMusicStreamUrl(base: string, token: string, itemId: string): string {
  return plexUrl(base, '/music/:/transcode/universal/start.mp3', token, {
    path: `/library/metadata/${itemId}`,
    protocol: 'http',
    directPlay: 0,
    directStream: 1,
    maxAudioBitrate: 320,
    session: `${itemId}-${Date.now()}`,
  });
}

// PlaySessionId of the most recently built HLS URL, so a caller holding only
// the URL string can still tear the right session down.
let lastHlsPlaySessionId: string | undefined;

export function getLastHlsPlaySessionId(): string | undefined {
  return lastHlsPlaySessionId;
}

// Same reasoning as the Jellyfin backend's DEFAULT_VIDEO_BITRATE: this is a
// MEMORY ceiling for the client's MSE SourceBuffer, not a bandwidth one. hls.js
// buffers 60–80s ahead regardless of its buffer knobs and Chromium caps a
// single video SourceBuffer near 250 MB, so an uncapped remux overflows it
// ~40s in and playback freezes. 20 Mbps keeps ~80s of buffer near 200 MB.
const DEFAULT_VIDEO_BITRATE_KBPS = 20_000;
// Ceiling used when the source is being stream-copied rather than re-encoded
// (see isStreamCopyUrl, and HLS_COPY_BUFFER in video-player.ts, which shrinks
// hls.js's buffer to match). Keep the two in sync.
const COPY_VIDEO_BITRATE_KBPS = 200_000;

/**
 * HLS master playlist from Plex's universal transcoder.
 *
 * `directStream=1` lets Plex remux rather than re-encode whenever the source
 * codecs are already deliverable — the equivalent of the Jellyfin path's
 * stream-copy, and the reason a 4K HDR remux arrives with its HDR metadata
 * intact instead of tonemapped. `directPlay=0` keeps it in HLS regardless, so
 * the player always gets a segmented stream it can seek quickly.
 */
export function buildHlsStreamUrl(plexUrl_: string, token: string, itemId: string, opts?: HlsStreamOptions): string {
  const base = normalizeUrl(plexUrl_);
  // Audio never goes down the video path: Plex answers 400 to a video transcode
  // request for a track, which is why records would not play at all.
  if (musicItems.has(String(itemId))) return buildMusicStreamUrl(base, token, itemId);
  const playSessionId = `${itemId}-${Date.now()}`;
  lastHlsPlaySessionId = playSessionId;

  // A stream copy hands the source bitstream over untouched, so it is only
  // possible when nothing asked the server to CHANGE the video:
  //   - burning subtitles in bakes pixels, which forces a re-encode;
  //   - an explicit bitrate or width cap is the caller saying "make it
  //     smaller" (the quality picker, and the ceiling TVs' 640px/600kbps
  //     thumbnail stream).
  // Asking for both at once is a contradiction Plex answers with a bare
  // 400 — which is exactly how the ambient TVs died silently.
  const wantsSmaller = opts?.maxBitrate !== undefined || opts?.maxWidth !== undefined;
  const canCopy = opts?.subtitleStreamIndex === undefined && !wantsSmaller;
  const bitrateKbps = opts?.maxBitrate
    ? Math.round(opts.maxBitrate / 1000)
    : (canCopy ? COPY_VIDEO_BITRATE_KBPS : DEFAULT_VIDEO_BITRATE_KBPS);

  return plexUrl(base, '/video/:/transcode/universal/start.m3u8', token, {
    path: `/library/metadata/${itemId}`,
    mediaIndex: opts?.mediaSourceId ?? 0,
    partIndex: 0,
    protocol: 'hls',
    fastSeek: 1,
    directPlay: 0,
    directStream: canCopy ? 1 : 0,
    directStreamAudio: 1,
    subtitleSize: 100,
    audioBoost: 100,
    maxVideoBitrate: bitrateKbps,
    videoQuality: 100,
    videoResolution: opts?.maxWidth ? `${opts.maxWidth}x${Math.round((opts.maxWidth * 9) / 16)}` : undefined,
    // Plex counts the start offset in SECONDS; the caller speaks Jellyfin ticks.
    offset: opts?.startPositionTicks
      ? Math.round(opts.startPositionTicks / TICKS_PER_MS / 1000)
      : undefined,
    // These are Plex stream IDs — see extractStreamsFromPart().
    audioStreamID: opts?.audioStreamIndex,
    subtitleStreamID: opts?.subtitleStreamIndex,
    subtitles: opts?.subtitleStreamIndex !== undefined ? 'burn' : 'none',
    session: playSessionId,
    'X-Plex-Session-Identifier': playSessionId,
  });
}

/**
 * Whether an HLS URL was built to let the server stream-COPY the video, i.e. it
 * may carry a full-bitrate remux rather than one capped at the default. The
 * player uses this to pick a buffer profile that keeps such a stream inside the
 * webview's SourceBuffer budget.
 */
export function isStreamCopyUrl(src: string): boolean {
  try {
    const v = new URL(src, 'http://x').searchParams.get('maxVideoBitrate');
    return v !== null && Number(v) >= COPY_VIDEO_BITRATE_KBPS;
  } catch {
    return false;
  }
}
