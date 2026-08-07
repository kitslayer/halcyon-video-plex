/**
 * Plex backend tests.
 *
 * The mapping tests always run against a captured fixture. The live tests only
 * run when PLEX_URL and PLEX_TOKEN are exported, so CI (and anyone without a
 * Plex server) still gets a green suite:
 *
 *   PLEX_URL=http://192.168.1.148:32400 PLEX_TOKEN=xxxx npm run test:plex
 */

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';

// src/plex.ts reads localStorage at module load for its client identifier, and
// again for the token in the calls that only receive a session id. Node has no
// DOM, so stand one up before the dynamic import below.
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};
(globalThis as any).window = undefined;

const PLEX_URL = process.env.PLEX_URL;
const PLEX_TOKEN = process.env.PLEX_TOKEN;
const live = !!(PLEX_URL && PLEX_TOKEN);

let plex: typeof import('../src/plex.ts');

before(async () => {
  plex = await import('../src/plex.ts');
  if (live) store.set('jellyfin_token', PLEX_TOKEN!);
});

describe('plex URL builders', () => {
  test('HLS URL carries the transcode params Plex needs', () => {
    const url = plex.buildHlsStreamUrl('http://host:32400', 'tok', '3140');
    assert.match(url, /\/video\/:\/transcode\/universal\/start\.m3u8/);
    const q = new URL(url).searchParams;
    assert.equal(q.get('path'), '/library/metadata/3140');
    assert.equal(q.get('protocol'), 'hls');
    assert.equal(q.get('directPlay'), '0');
    assert.equal(q.get('X-Plex-Token'), 'tok');
    assert.ok(q.get('session'), 'a session id is required to stop the transcode later');
  });

  test('the built session id is what getLastHlsPlaySessionId reports', () => {
    const url = plex.buildHlsStreamUrl('http://host:32400', 'tok', '77');
    const session = new URL(url).searchParams.get('session');
    assert.equal(plex.getLastHlsPlaySessionId(), session);
  });

  test('a start offset converts from Jellyfin ticks to Plex seconds', () => {
    // 90 s = 90 * 1e7 ticks.
    const url = plex.buildHlsStreamUrl('http://h:32400', 't', '1', { startPositionTicks: 900_000_000 });
    assert.equal(new URL(url).searchParams.get('offset'), '90');
  });

  test('picking a subtitle track forces burn-in and disables stream copy', () => {
    const url = plex.buildHlsStreamUrl('http://h:32400', 't', '1', { subtitleStreamIndex: 4242 });
    const q = new URL(url).searchParams;
    assert.equal(q.get('subtitles'), 'burn');
    assert.equal(q.get('subtitleStreamID'), '4242');
    assert.equal(q.get('directStream'), '0', 'burn-in requires a re-encode');
    assert.equal(plex.isStreamCopyUrl(url), false);
  });

  test('a copy-eligible stream is flagged for the player buffer profile', () => {
    const url = plex.buildHlsStreamUrl('http://h:32400', 't', '1');
    assert.equal(plex.isStreamCopyUrl(url), true);
  });

  test('an explicit bitrate cap converts bits/s to the kbps Plex expects', () => {
    const url = plex.buildHlsStreamUrl('http://h:32400', 't', '1', { maxBitrate: 8_000_000 });
    assert.equal(new URL(url).searchParams.get('maxVideoBitrate'), '8000');
  });
});

describe('plex live server', { skip: live ? false : 'set PLEX_URL and PLEX_TOKEN to run' }, () => {
  test('validateToken accepts a good token and rejects a bad one', async () => {
    assert.equal(await plex.validateToken(PLEX_URL!, PLEX_TOKEN!), true);
    assert.equal(await plex.validateToken(PLEX_URL!, 'definitelynotatoken'), false);
  });

  test('the catalog syncs into well-formed Movies', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    assert.ok(libs.length > 0, 'expected at least one video library');

    const movies = libs.flatMap((l) => l.movies);
    assert.ok(movies.length > 0, 'expected at least one title');

    for (const m of movies) {
      assert.ok(m.id, 'every title needs an id');
      assert.ok(m.title, `title ${m.id} has no name`);
      assert.equal(typeof m.year, 'number');
      assert.ok(Array.isArray(m.genres));
      assert.ok(Array.isArray(m.actors));
    }

    // Music and photo sections must never reach the shelves.
    for (const l of libs) assert.ok(!/music|photo/i.test(l.name), `${l.name} should not sync`);

    const withPoster = movies.filter((m) => m.posterUrl);
    assert.ok(withPoster.length / movies.length > 0.5, 'most titles should have poster art');
  });

  test('cast portraits are joined in from the library cast index', async () => {
    // Plex's LIST view returns Role entries as bare `{tag: "Name"}`, so this
    // only passes if fetchActorIndex() ran and matched.
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const cast = libs.flatMap((l) => l.movies).flatMap((m) => m.castPeople ?? []);
    assert.ok(cast.length > 0, 'expected some cast');
    const withPortraits = cast.filter((c) => c.imageUrl);
    assert.ok(
      withPortraits.length / cast.length > 0.5,
      `only ${withPortraits.length}/${cast.length} cast members got a portrait`
    );
    // Portraits must be proxied by the server, not fetched from plex.tv.
    for (const c of withPortraits) assert.match(c.imageUrl!, /\/photo\/:\/transcode/);

    const res = await fetch(withPortraits[0].imageUrl!);
    assert.ok(res.ok, `portrait returned ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /^image\//);
    await res.body?.cancel();
  });

  test('a movie carries the codec info the direct-play decision needs', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const film = libs.flatMap((l) => l.movies).find((m) => !m.isSeries && m.localPath);
    assert.ok(film, 'expected at least one non-series title with a file');
    assert.ok(film!.mediaPlaybackInfo?.container, 'container is required in bulk');
    assert.ok(film!.mediaPlaybackInfo?.videoCodec, 'video codec is required in bulk');
  });

  test('episodes come back in season/episode order', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const series = libs.flatMap((l) => l.movies).find((m) => m.isSeries);
    if (!series) return; // no TV libraries on this server

    const eps = await plex.fetchSeriesEpisodes(PLEX_URL!, PLEX_TOKEN!, '1', series.id);
    assert.ok(eps.length > 0, `expected episodes for "${series.title}"`);
    for (let i = 1; i < eps.length; i++) {
      const a = eps[i - 1], b = eps[i];
      const ordered = a.seasonNumber < b.seasonNumber ||
        (a.seasonNumber === b.seasonNumber && a.episodeNumber <= b.episodeNumber);
      assert.ok(ordered, `out of order at ${b.seasonNumber}x${b.episodeNumber}`);
    }

    const first = await plex.fetchFirstEpisodeOfSeries(PLEX_URL!, PLEX_TOKEN!, '1', series.id);
    assert.equal(first?.id, eps[0].id);
  });

  test('probing an item fills in its audio/subtitle tracks', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const film = libs.flatMap((l) => l.movies).find((m) => !m.isSeries && m.localPath);
    assert.ok(film);

    const info = await plex.fetchItemPlaybackInfo(PLEX_URL!, PLEX_TOKEN!, '1', film!.id);
    assert.ok(info?.container);
    const streams = plex.getCachedStreams(film!.id);
    assert.ok(streams && streams.length > 0, 'the track picker needs streams after a probe');
    assert.ok(streams!.some((s) => s.type === 'Audio'), 'expected an audio track');
  });

  test('the direct-play URL resolves to a real file', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const film = libs.flatMap((l) => l.movies).find((m) => !m.isSeries && m.localPath);
    assert.ok(film);

    const url = plex.buildStaticStreamUrl(PLEX_URL!, PLEX_TOKEN!, film!.id);
    const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
    assert.ok(res.ok, `direct play returned ${res.status}`);
    await res.body?.cancel();
  });

  test('poster URLs actually return an image', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const film = libs.flatMap((l) => l.movies).find((m) => m.posterUrl);
    assert.ok(film?.posterUrl);
    const res = await fetch(film!.posterUrl!);
    assert.ok(res.ok, `poster returned ${res.status}`);
    assert.match(res.headers.get('content-type') ?? '', /^image\//);
    await res.body?.cancel();
  });

  test('an HLS stream really starts transcoding, and can be stopped', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const film = libs.flatMap((l) => l.movies).find((m) => !m.isSeries && m.localPath);
    assert.ok(film);

    const url = plex.buildHlsStreamUrl(PLEX_URL!, PLEX_TOKEN!, film!.id);
    const res = await fetch(url);
    assert.ok(res.ok, `HLS start returned ${res.status}`);
    const body = await res.text();
    assert.match(body, /#EXTM3U/, 'expected an m3u8 playlist');

    store.set('jellyfin_url', PLEX_URL!);
    await plex.stopActiveEncoding(plex.getLastHlsPlaySessionId()!);
  });

  test('playback reporting is accepted', async () => {
    const libs = await plex.fetchJellyfinLibrariesAndMovies(PLEX_URL!, PLEX_TOKEN!, '1');
    const film = libs.flatMap((l) => l.movies).find((m) => !m.isSeries);
    assert.ok(film);
    // These swallow their own errors by design, so the assertion is that they
    // resolve rather than hang or throw.
    await plex.reportPlaybackStart(PLEX_URL!, PLEX_TOKEN!, film!.id);
    await plex.reportPlaybackProgress(PLEX_URL!, PLEX_TOKEN!, film!.id, 600_000_000, false);
    await plex.reportPlaybackStopped(PLEX_URL!, PLEX_TOKEN!, film!.id, 600_000_000);
  });
});
