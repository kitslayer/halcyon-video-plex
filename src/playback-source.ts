/**
 * Resolving what a title's playback actually needs: container/codec facts for
 * the direct-play decision, and the audio/subtitle tracks for the picker.
 *
 * Extracted from main.ts's launchVideoPlayback (file-budget pattern — see
 * CLAUDE.md) because it grew a second responsibility: with more than one media
 * server, "where does this information come from" is no longer a one-liner.
 *
 * Two sources, in priority order:
 *
 *   1. THE CATALOG. Jellyfin's library query returns MediaSources for every
 *      title, so a movie already carries both its codecs and its track list
 *      before anything is played.
 *   2. A PROBE of the single item about to play. Needed for a series episode,
 *      which is not in the catalog at all — and for any backend whose list
 *      responses can't carry per-track streams. Plex is that case: it ignores
 *      `includeStreams=1` on a listing, so its catalog supplies codecs but
 *      never tracks, and the picker would otherwise always be empty.
 */

import { fetchItemPlaybackInfo } from './backend';
import type { MediaPlaybackInfo, MediaStreamInfo, Movie, MovieVersion } from './backend';

export interface PlaybackSource {
  /** Container/codecs for isDirectPlaySafe() and the HEVC pass-through hint. */
  mediaInfo: MediaPlaybackInfo | undefined;
  /** Audio + subtitle tracks for the player's picker; empty when unavailable. */
  streams: MediaStreamInfo[];
}

/**
 * @param overrideItemId Set when playing a series episode by id rather than the
 *   catalogued container — the signal that the catalog holds nothing for it.
 * @param version The chosen quality/edition, when the user picked one.
 */
export async function resolvePlaybackSource(
  serverUrl: string,
  token: string,
  userId: string | null | undefined,
  playbackId: string,
  movie: Movie,
  version: MovieVersion | undefined,
  overrideItemId: string | undefined
): Promise<PlaybackSource> {
  const catalogInfo = overrideItemId ? undefined : (version?.mediaPlaybackInfo ?? movie.mediaPlaybackInfo);
  const catalogStreams = overrideItemId ? undefined : (version?.mediaStreams ?? movie.mediaStreams);

  // Probe when the catalog can't answer: an episode never has an entry, and a
  // missing track list means this backend doesn't ship them in bulk.
  const needsProbe = !!overrideItemId || !catalogStreams?.length;
  const probedInfo = needsProbe && userId
    ? await fetchItemPlaybackInfo(serverUrl, token, userId, playbackId)
    : undefined;

  // A probe describes only the item's DEFAULT source, so its stream ids belong
  // to that edition. Feeding them to a transcode of a *different* edition would
  // select the wrong track or fail outright — worse than offering no picker —
  // so probed tracks are dropped when an alternate version was chosen. Catalog
  // streams are already per-version and always safe.
  const probedStreams = version?.mediaSourceId ? undefined : probedInfo?.mediaStreams;

  return {
    mediaInfo: catalogInfo ?? probedInfo,
    streams: catalogStreams?.length ? catalogStreams : (probedStreams ?? []),
  };
}
