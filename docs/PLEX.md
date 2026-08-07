# Plex backend

This fork adds a **Plex Media Server** backend alongside upstream's Jellyfin
one. The 3D store is identical either way — same shelves, same clerk, same
rentals — because the store was already written against a plain list of movies
rather than against Jellyfin.

---

## Setup

On the **HTPC Connection Center**, switch the toggle from *Jellyfin* to
**Plex**. Then pick whichever sign-in suits you — all three end the same way,
with your servers listed **LAN address first**. Choose one and press
**Connect & Sync**.

### Phone code (default)

1. Press **Link with Plex**. A four-character code appears.
2. On your phone, go to **[plex.tv/link](https://plex.tv/link)** and type it.

Best for a box you drive with a remote — no password typed on screen, and
two-factor is handled by plex.tv itself.

### Password

Enter your plex.tv **email and password** and press **Sign in to Plex**. If your
account has two-factor enabled, put the 6-digit code in the third field. Fastest
if you're setting up at a keyboard.

### Token — nothing leaves your LAN

Paste an `X-Plex-Token` and fill in the server address yourself. The token is
validated against your server directly and `plex.tv` is never contacted.

To find one: play anything in Plex's web app, open **Get Info → View XML**, and
copy the `X-Plex-Token` value out of the address bar.

Your choice of method is remembered, so a kiosk lands on the same screen every
boot.

### Choosing the backend other ways

| How | Use it for |
|---|---|
| The login-screen toggle | Normal use; persists |
| `?backend=plex` in the URL | A kiosk shortcut, or A/B-ing two servers |
| `VITE_MEDIA_BACKEND=plex` at build time | A Docker image baked for one server |

Item ids aren't portable between backends, so switching servers re-syncs the
catalog from scratch.

---

## What works

Everything the store does, with two caveats noted below.

| | |
|---|---|
| Movie and TV libraries, genres, sections | ✅ |
| Posters, backdrops, cast portraits | ✅ |
| Cast, director, studio, content rating, premiere date | ✅ |
| Audience + critic ratings | ✅ |
| Watch state → watched titles, staff picks | ✅ |
| Episodes, season ordering, up-next | ✅ |
| Multiple editions of one film (4K + 1080p) | ✅ |
| Collections → shelved together in release order | ✅ |
| Direct play, HLS remux, HLS transcode | ✅ |
| Playback reporting → Plex **Continue Watching** | ✅ |
| Audio / subtitle track picker | ✅ (loaded at play time — see below) |
| Overseerr requests wall | ✅ |
| Plex Home / managed users | ⚠️ implemented, lightly tested |

**Music and photo sections are skipped** — this is a video store.

---

## Two places Plex needed working around

Plex thins out **list** responses in ways the detail view doesn't, and both
would have cost one HTTP request per title if handled naively.

**Cast portraits.** A listing's `Role[]` entries are just `{tag: "Jim
Sturgess"}` — no id, no portrait. Rather than fetch 300 detail documents, the
backend pulls the section's own cast index
(`/library/sections/{id}/actor`), which carries ids and portraits for every
actor in the library, and joins on name. One request per library.

**Audio/subtitle tracks.** Plex ignores `includeStreams=1` on a listing, so the
track picker can't be populated during the catalog sync. It's filled in by
`fetchItemPlaybackInfo()`, which the player already calls for the exact title
it's about to open. Container and codec info for the direct-play decision *does*
arrive in bulk on `Media[]`, so nothing about playback selection is degraded.

## Three places Plex fits better than Jellyfin

- **One request per library.** Genre, Director, Role and Media all arrive in the
  section listing — no `Fields=` shopping list.
- **Multiple editions are native.** A 4K remux and a 1080p rip are two `Media[]`
  entries on one item, which is exactly the version-picker model. Upstream has
  to infer this by normalising titles and collapsing duplicates.
- **Collections and watch state ride along on the item**, so neither needs the
  second pass the Jellyfin path makes.

---

## How it's built

```
src/plex.ts             the backend — same ~20 exports as jellyfin.ts
src/backend.ts          picks one per call; re-exports the shared pieces
src/login-backend-ui.ts the picker and the plex.tv device-link flow
```

Only four modules in the whole app call a media server
(`main.ts`, `video-player.ts`, `membership-cards.ts`, `flat/flat-detail.ts`),
and they import from `backend.ts`. The other 44 modules that reference
`jellyfin.ts` import **nothing but its types** — they take a `Movie[]` and
don't care where it came from. That's why this fork is small.

Anything genuinely backend-independent is *reused* from `jellyfin.ts` rather
than copied: the type declarations, `collapseDuplicateVersions()`,
`isDirectPlaySafe()` and `isHevcPassThroughEnabled()` (both are webview codec
probes), and the collection maps the requests client reads.

### Field mapping

| `Movie` | Plex |
|---|---|
| `id` | `ratingKey` |
| `duration` | `duration` (ms → minutes) |
| `rating` | `contentRating` |
| `communityRating` | `audienceRating` (0–10) |
| `criticRating` | `rating` × 10 (0–10 → 0–100) |
| `localPath` | `Media[].Part[].file` |
| `versions` | one per `Media[]` entry |
| `played` / `playCount` / `lastPlayedDate` | `viewCount`, `lastViewedAt` |
| `collectionName` | `Collection[].tag` |
| `tmdbId` | `Guid[]` → `tmdb://…` |
| playback reporting | `/:/timeline` |
| direct play | `/library/parts/{id}/…/file` |
| HLS | `/video/:/transcode/universal/start.m3u8` |

Two fields carry Plex handles rather than the Jellyfin values their names
suggest, because `plex.ts` is both producer and consumer:
`MediaStreamInfo.index` holds Plex's stream **id** (what
`audioStreamID`/`subtitleStreamID` want), and `MovieVersion.mediaSourceId` holds
the `Media[]` **array index** (what `mediaIndex` wants).

---

## Tests

Mapping and URL-builder tests run anywhere. Live tests run only when you point
them at a real server:

```sh
npm run test:plex                                   # URL builders only
PLEX_URL=http://192.168.1.50:32400 \
PLEX_TOKEN=xxxxxxxxxxxxxxxxxxxx npm run test:plex   # + live server
```

The live suite checks the catalog shape, cast portraits, episode ordering,
direct play, HLS, poster URLs and playback reporting against your own library.

---

## Gotchas found the hard way

**Don't open transcode sessions in a tight loop.** Plex starts answering `400`
to new sessions if you create and tear them down back to back. This looks
exactly like "transcoding is broken" and it isn't — space them out.

**A stream copy and a downscale are contradictory.** Asking for
`directStream=1` together with a `maxVideoBitrate` or `videoResolution` cap
returns a bare `400`. `buildHlsStreamUrl()` drops the copy request whenever the
caller asks for something smaller.

**Seek server-side, not client-side.** Plex's transcoder encodes forward from
the session's `offset`, so setting `video.currentTime` to a point it hasn't
reached yet 404s the segment. Pass `startPositionTicks` instead. (This is
better on Jellyfin too — its own builder calls client-side seeking the slow
path.)

**The desktop build needs an `Accept` header.** Plex answers XML unless asked
for JSON, and the Tauri transport didn't forward one. `jellyfin_request` in
`src-tauri/src/lib.rs` takes an optional `accept` parameter now; rebuild the
Tauri binary if you use it. The browser and Docker paths are unaffected.
