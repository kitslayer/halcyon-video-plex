# Changes in this fork

This fork adds a **Plex Media Server backend** to Halcyon Video. Upstream is
[halcyon-video/halcyon-video](https://github.com/halcyon-video/halcyon-video)
and is Jellyfin-only.

Required by GPL-3.0 §5(a): the changes below are this fork's, not upstream's.

Fork point: `1be31d6` (Merge pull request #35 from halcyon-video/dev).

---

## New files

| File | What |
|---|---|
| `src/plex.ts` | Plex backend. Same export surface as `jellyfin.ts`. |
| `src/backend.ts` | Dispatches each call to the selected backend; re-exports the backend-independent pieces. |
| `src/login-backend-ui.ts` | Server picker and the plex.tv device-link flow. |
| `src/playback-source.ts` | Resolves an item's codecs and track list from the catalog or a probe. Extracted from `main.ts` to stay inside the project's file budget. |
| `tools/check-env-inlining.mjs` | Build guard: fails if a `VITE_*` read is written so that Vite can't inline it. |
| `tests/plex.test.ts` | URL-builder tests, plus a live suite that runs only when `PLEX_URL`/`PLEX_TOKEN` are set. |
| `docs/PLEX.md` | Setup, field mapping, design notes. |

## Modified files

| File | Change |
|---|---|
| `src/main.ts` | Imports the media server from `backend.ts`; reads credentials per backend; backend-aware log lines and error copy; pins the backend to the saved session; delegates playback-source resolution to `playback-source.ts`. |
| `src/jellyfin.ts` | `MediaPlaybackInfo` gains an optional `mediaStreams`, so a backend that can't ship track lists in bulk can carry them out on the pre-playback probe. Additive — the Jellyfin path never sets it. |
| `.github/workflows/deploy-demo.yml` | Deploys from `plex-backend`, not `master` (which is the untouched upstream baseline). |
| `src/video-player.ts` | Imports from `backend.ts`. |
| `src/membership-cards.ts` | Imports from `backend.ts`. |
| `src/flat/flat-detail.ts` | Imports from `backend.ts`. |
| `src/ambient-tvs.ts` | Ceiling-TV stream now goes through the shared HLS builder and seeks server-side (see below). |
| `src/settings.ts` | Connection-group labels follow the selected backend. |
| `src/clerk-interaction.ts` | Suggestion log names the active requests provider. |
| `index.html` | Backend toggle, Plex link panel, backend-aware labels. |
| `src/styles.css` | Styles for the picker and the link code. |
| `src-tauri/src/lib.rs` | `jellyfin_request` takes an optional `accept` header (Plex answers XML without it). Additive; existing callers unchanged. |
| `Dockerfile` | `VITE_MEDIA_BACKEND` build arg, so an image can default to Plex. |
| `package.json` | Adds `test:plex`. |
| `README.md` | Fork notice, Plex in the integration tables, plex.tv in the outbound-calls table. |

## Fixed in this fork after first publish

**Playback reporting was a silent no-op.** `/:/timeline` answers `200` to an
update carrying `duration=0` and then discards it — no resume position, nothing
in Continue Watching, no error. Each item's runtime is now cached during the
catalog sync and sent with every update. The live test asserts the server
actually *recorded* the offset; asserting only that the call resolved is what let
this ship.

**The audio/subtitle track picker was always empty on Plex.** Streams were
documented as lazily probed, and the probe existed, but nothing carried them to
the picker. `MediaPlaybackInfo.mediaStreams` now does. Series episodes benefit
too: they previously got a quality-only picker on either backend.

## Two upstream bugs fixed along the way

Both were pre-existing and are not Plex-specific.

**`ambient-tvs.ts` bypassed the shared stream builder.** It assembled a
Jellyfin `/Videos/{id}/master.m3u8` URL inline — the only place in the app that
hand-rolled one. It now calls `buildHlsStreamUrl()`.

**The ceiling TVs seeked client-side into a transcode.** They set
`video.currentTime` to a random point ~40 minutes in. The stream now starts at
that offset server-side via `startPositionTicks`, which upstream's own builder
already documents as the correct path ("what makes seeking a transcode slow").

## Compatibility

- **Jellyfin behaves exactly as upstream.** The backend defaults to Jellyfin,
  and every Jellyfin code path is unchanged.
- **Storage keys are unchanged** (`jellyfin_url`, `jellyfin_token`, …), so an
  existing install keeps its session.
- **Type-only importers are untouched.** 44 of the 48 modules that reference
  `jellyfin.ts` import nothing but its types and were not modified.
- The Tauri desktop binary needs a rebuild to pick up the `accept` parameter.
  Browser and Docker builds are unaffected.
