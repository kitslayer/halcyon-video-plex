/**
 * Backend picker + Plex device-link flow for the HTPC Connection Center.
 *
 * Lives in its own module rather than inside main.ts so the fork's diff against
 * upstream stays small: main.ts gains one init call and one credential lookup,
 * everything else about choosing and linking a server is here.
 *
 * Two jobs:
 *   1. Flip the connection form between Jellyfin (username + password) and Plex
 *      (device link), and relabel everything that says a server's name.
 *   2. Run the plex.tv link flow — show a 4-character code, poll until the user
 *      claims it on their phone, then list the servers that account can reach.
 */

import {
  getBackend,
  setBackend,
  backendLabel,
  requestPlexPin,
  checkPlexPin,
  discoverPlexServers,
  authenticatePlexAccount,
  type BackendName,
  type PlexPin,
  type PlexServer,
} from './backend.ts';
import { getStoreMode, setStoreMode, type StoreMode } from './store-mode.ts';

/** How often to ask plex.tv whether the code has been claimed. plex.tv rate
 *  limits this endpoint, and a person needs a few seconds to type the code
 *  anyway, so polling faster only risks a 429. */
const PIN_POLL_MS = 2000;

let pollTimer: ReturnType<typeof setInterval> | null = null;
let activePin: PlexPin | null = null;
/** Token obtained from the link flow, handed to main.ts at submit time. */
let linkedToken: string | null = null;
let logFn: (msg: string) => void = () => {};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null;

function stopPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function setStatus(text: string, kind: 'idle' | 'ok' | 'error' = 'idle'): void {
  const el = $<HTMLParagraphElement>('login-plex-status');
  if (!el) return;
  el.innerText = text;
  el.classList.toggle('is-error', kind === 'error');
  el.classList.toggle('is-ok', kind === 'ok');
}

// ─── Labels ──────────────────────────────────────────────────────────────────

/**
 * Copy for each backend. Kept as data rather than scattered ternaries so adding
 * a third backend is a matter of adding an entry.
 */
const COPY: Record<BackendName, {
  title: string;
  desc: string;
  urlPlaceholder: string;
  requests: string;
  requestsDesc: string;
}> = {
  jellyfin: {
    title: 'Jellyfin Server',
    desc: 'Primary library provider for cataloging movies and retrieving poster artwork.',
    urlPlaceholder: 'http://192.168.1.50:8096',
    requests: 'Jellyseerr',
    requestsDesc:
      'Connect Jellyseerr to enable a "Coming Soon" requests wall inside the store. Cover art for ' +
      "titles you don't own is fetched from TMDB's image CDN — Jellyseerr returns the artwork's " +
      'address, not the artwork. Everything you already own is served by Jellyfin.',
  },
  plex: {
    title: 'Plex Server',
    desc: 'Primary library provider for cataloging movies and retrieving poster artwork.',
    urlPlaceholder: 'http://192.168.1.50:32400',
    requests: 'Overseerr',
    requestsDesc:
      'Connect Overseerr to enable a "Coming Soon" requests wall inside the store. Cover art for ' +
      "titles you don't own is fetched from TMDB's image CDN — Overseerr returns the artwork's " +
      'address, not the artwork. Everything you already own is served by Plex.',
  },
};

/** Point every user-visible label at the selected backend. */
function applyLabels(backend: BackendName): void {
  const copy = COPY[backend];

  const title = $<HTMLHeadingElement>('login-backend-title');
  if (title) title.innerText = copy.title;

  const desc = $<HTMLParagraphElement>('login-backend-desc');
  if (desc) desc.innerText = copy.desc;

  const url = $<HTMLInputElement>('login-url');
  if (url) {
    url.placeholder = copy.urlPlaceholder;
    // Only rewrite a value the user hasn't touched — clobbering a typed
    // address on a backend flip would be infuriating.
    if (!url.value || /^https?:\/\/localhost:(8096|32400)$/.test(url.value)) {
      url.value = backend === 'plex' ? 'http://localhost:32400' : 'http://localhost:8096';
    }
  }

  const reqTitle = $<HTMLHeadingElement>('login-requests-title');
  if (reqTitle) reqTitle.innerText = copy.requests;

  const reqDesc = $<HTMLParagraphElement>('login-requests-desc');
  if (reqDesc) reqDesc.innerText = copy.requestsDesc;

  const reqUrlLabel = $<HTMLLabelElement>('login-requests-url-label');
  if (reqUrlLabel) reqUrlLabel.innerText = `${copy.requests} Server (optional)`;

  const reqKeyLabel = $<HTMLLabelElement>('login-requests-key-label');
  if (reqKeyLabel) reqKeyLabel.innerText = `${copy.requests} API Key (optional)`;
}

/** Show the credential fields the selected backend actually uses. */
function applyFieldVisibility(backend: BackendName): void {
  const jf = $<HTMLDivElement>('login-jellyfin-fields');
  const px = $<HTMLDivElement>('login-plex-fields');
  if (jf) jf.hidden = backend !== 'jellyfin';
  if (px) px.hidden = backend !== 'plex';

  // `required` has to track visibility or the browser refuses to submit the
  // form over a hidden empty field it won't even scroll to.
  const user = $<HTMLInputElement>('login-user');
  if (user) user.required = backend === 'jellyfin';

  for (const id of ['login-backend-jellyfin', 'login-backend-plex'] as const) {
    const btn = $<HTMLButtonElement>(id);
    if (btn) btn.setAttribute('aria-checked', String(id.endsWith(backend)));
  }
}

/** Flip between the video shop and the record shop. Records are Plex-only, so
 *  choosing them also nudges the server picker across — an empty record store
 *  because the server can't read music is a confusing first run. */
function selectStore(mode: StoreMode): void {
  setStoreMode(mode);
  for (const m of ['video', 'records'] as const) {
    const btn = $<HTMLButtonElement>(`login-store-${m}`);
    if (btn) btn.setAttribute('aria-checked', String(m === mode));
  }
  if (mode === 'records' && getBackend() !== 'plex') selectBackend('plex');
  const desc = $<HTMLParagraphElement>('login-backend-desc');
  if (desc && mode === 'records') {
    desc.innerText = 'Stocks the shop from your music libraries — albums as records, filed by artist. Needs Plex.';
  }
}

function selectBackend(backend: BackendName): void {
  stopPolling();
  setBackend(backend);
  applyLabels(backend);
  applyFieldVisibility(backend);
}

// ─── Plex device link ────────────────────────────────────────────────────────

/** Fill the server dropdown from the linked account, preferring LAN addresses. */
async function populateServers(token: string): Promise<void> {
  const select = $<HTMLSelectElement>('login-plex-server');
  const urlInput = $<HTMLInputElement>('login-url');
  if (!select) return;

  setStatus('Linked. Looking for your servers…', 'ok');
  let servers: PlexServer[] = [];
  try {
    servers = await discoverPlexServers(token);
  } catch (e: any) {
    setStatus(`Linked, but server discovery failed: ${e?.message ?? e}`, 'error');
    return;
  }

  if (servers.length === 0) {
    setStatus('Linked, but this account has no Plex servers. Enter an address manually.', 'error');
    return;
  }

  select.innerHTML = '';
  for (const s of servers) {
    const opt = document.createElement('option');
    opt.value = s.url;
    opt.text = `${s.name} — ${s.local ? 'LAN' : 'remote'}${s.owned ? '' : ' (shared)'}`;
    select.appendChild(opt);
  }
  select.disabled = false;

  // discoverPlexServers() sorts LAN-first, so the default selection is the one
  // that keeps traffic off the internet.
  if (urlInput) urlInput.value = servers[0].url;
  select.value = servers[0].url;
  select.onchange = () => {
    if (urlInput) urlInput.value = select.value;
  };

  const lan = servers.filter((s) => s.local).length;
  setStatus(`Linked. Found ${servers.length} server${servers.length === 1 ? '' : 's'} (${lan} on your LAN).`, 'ok');
  logFn(`[System] Plex account linked — ${servers.length} server(s) available.`);
}

async function beginLink(): Promise<void> {
  const btn = $<HTMLButtonElement>('login-plex-link-btn');
  const box = $<HTMLDivElement>('login-plex-linkbox');
  const codeEl = $<HTMLDivElement>('login-plex-code');

  stopPolling();
  linkedToken = null;
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Requesting code…';
  }

  try {
    activePin = await requestPlexPin();
  } catch (e: any) {
    setStatus(`Could not reach plex.tv: ${e?.message ?? e}`, 'error');
    if (box) box.hidden = false;
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Try again';
    }
    return;
  }

  if (box) box.hidden = false;
  if (codeEl) codeEl.innerText = activePin.code;
  setStatus('Waiting for you to enter the code…');
  if (btn) btn.innerText = 'Waiting…';
  logFn(`[System] Plex link code: ${activePin.code} — enter it at plex.tv/link`);

  pollTimer = setInterval(async () => {
    if (!activePin) return stopPolling();

    if (Date.now() > activePin.expiresAt) {
      stopPolling();
      setStatus('That code expired. Request a new one.', 'error');
      if (btn) {
        btn.disabled = false;
        btn.innerText = 'Get a new code';
      }
      return;
    }

    let token: string | null = null;
    try {
      token = await checkPlexPin(activePin.id);
    } catch {
      // A dropped poll is not fatal — the next tick retries, and the expiry
      // check above is what eventually gives up.
      return;
    }
    if (!token) return;

    stopPolling();
    linkedToken = token;
    if (btn) btn.innerText = 'Linked ✓';
    if (codeEl) codeEl.innerText = '✓';
    await populateServers(token);
  }, PIN_POLL_MS);
}

// ─── Email + password sign-in ────────────────────────────────────────────────

/** Sign in at plex.tv with a password, then take the same path the device link
 *  takes — a token, then the account's server list. */
async function beginPasswordSignIn(): Promise<void> {
  const btn = $<HTMLButtonElement>('login-plex-signin-btn');
  const status = $<HTMLParagraphElement>('login-plex-signin-status');
  const email = $<HTMLInputElement>('login-plex-email')?.value.trim() ?? '';
  const password = $<HTMLInputElement>('login-plex-password')?.value ?? '';
  const code = $<HTMLInputElement>('login-plex-2fa')?.value.trim() ?? '';

  const say = (text: string, kind: 'idle' | 'ok' | 'error' = 'idle') => {
    if (!status) return;
    status.innerText = text;
    status.classList.toggle('is-error', kind === 'error');
    status.classList.toggle('is-ok', kind === 'ok');
  };

  if (!email || !password) {
    say('Enter your Plex email and password.', 'error');
    return;
  }

  stopPolling();
  linkedToken = null;
  if (btn) {
    btn.disabled = true;
    btn.innerText = 'Signing in…';
  }
  say('Contacting plex.tv…');

  try {
    linkedToken = await authenticatePlexAccount(email, password, code || undefined);
  } catch (e: any) {
    say(e?.message ?? String(e), 'error');
    if (btn) {
      btn.disabled = false;
      btn.innerText = 'Sign in to Plex';
    }
    return;
  }

  if (btn) btn.innerText = 'Signed in ✓';
  say('Signed in. Looking for your servers…', 'ok');
  logFn('[System] Signed in to Plex.');

  // populateServers() writes to the device-link status line; mirror its outcome
  // here so the user reading THIS pane sees what happened.
  await populateServers(linkedToken);
  const mirrored = $<HTMLParagraphElement>('login-plex-status')?.innerText;
  if (mirrored) say(mirrored, mirrored.startsWith('Linked') || mirrored.startsWith('Signed') ? 'ok' : 'idle');
}

// ─── Sign-in method tabs ─────────────────────────────────────────────────────

type PlexMethod = 'link' | 'password' | 'token';

const METHOD_KEY = 'plex_login_method';

function selectMethod(method: PlexMethod): void {
  for (const m of ['link', 'password', 'token'] as const) {
    const tab = $<HTMLButtonElement>(`login-plex-method-${m}`);
    const pane = $<HTMLDivElement>(`login-plex-pane-${m}`);
    if (tab) tab.setAttribute('aria-selected', String(m === method));
    if (pane) pane.hidden = m !== method;
  }
  try {
    localStorage.setItem(METHOD_KEY, method);
  } catch {
    /* best-effort */
  }
  // Switching method abandons an in-flight code — otherwise a poll could
  // "succeed" and overwrite a token the user just pasted somewhere else.
  if (method !== 'link') stopPolling();
}

function storedMethod(): PlexMethod {
  try {
    const m = localStorage.getItem(METHOD_KEY);
    if (m === 'link' || m === 'password' || m === 'token') return m;
  } catch {
    /* no storage */
  }
  return 'link';
}

// ─── Public API ──────────────────────────────────────────────────────────────

/** Wire up the picker, the sign-in tabs and both auth buttons. Call once at boot. */
export function initBackendLoginUi(opts?: { log?: (msg: string) => void }): void {
  if (opts?.log) logFn = opts.log;

  $<HTMLButtonElement>('login-store-video')?.addEventListener('click', () => selectStore('video'));
  $<HTMLButtonElement>('login-store-records')?.addEventListener('click', () => selectStore('records'));

  $<HTMLButtonElement>('login-backend-jellyfin')?.addEventListener('click', () => selectBackend('jellyfin'));
  $<HTMLButtonElement>('login-backend-plex')?.addEventListener('click', () => selectBackend('plex'));

  $<HTMLButtonElement>('login-plex-method-link')?.addEventListener('click', () => selectMethod('link'));
  $<HTMLButtonElement>('login-plex-method-password')?.addEventListener('click', () => selectMethod('password'));
  $<HTMLButtonElement>('login-plex-method-token')?.addEventListener('click', () => selectMethod('token'));

  $<HTMLButtonElement>('login-plex-link-btn')?.addEventListener('click', () => void beginLink());
  $<HTMLButtonElement>('login-plex-signin-btn')?.addEventListener('click', () => void beginPasswordSignIn());

  // Reflect whatever the last session chose (or ?backend=).
  selectMethod(storedMethod());
  selectBackend(getBackend());
  selectStore(getStoreMode());
}

/**
 * Credentials for the active backend, in the shape authenticateUser() takes.
 *
 * Plex has no username/password against the server — the token IS the
 * credential — so the linked (or pasted) token rides in the username slot,
 * which plex.ts's authenticateUser() detects and validates.
 */
export function getLoginCredentials(): { username: string; password: string } {
  if (getBackend() !== 'plex') {
    return {
      username: $<HTMLInputElement>('login-user')?.value.trim() ?? '',
      password: $<HTMLInputElement>('login-pass')?.value ?? '',
    };
  }
  // A token from the link or password flow wins; otherwise take a pasted one.
  // Either way it rides in the username slot, which plex.ts's authenticateUser()
  // detects and validates against the server before accepting.
  const pasted = $<HTMLInputElement>('login-plex-token')?.value.trim() ?? '';
  return { username: linkedToken ?? pasted, password: '' };
}

/** Human-readable name of the active backend, for log lines and error copy. */
export function activeBackendLabel(): string {
  return backendLabel();
}

/** Tear down the poll timer when the overlay closes. */
export function disposeBackendLoginUi(): void {
  stopPolling();
  activePin = null;
}
