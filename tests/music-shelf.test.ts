/**
 * Record-shop filing rules.
 *
 * All pure — no Plex server needed, so these run in any checkout:
 *
 *   node --experimental-strip-types --test tests/music-shelf.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import type { Movie } from '../src/jellyfin.ts';
import {
  buildMusicLibraries,
  filingName,
  filingLetter,
  shelfOrder,
  dividerLetters,
  byFormat,
} from '../src/music-only.ts';

function album(artist: string, title: string, extra: Partial<Movie> = {}): Movie {
  return {
    id: `${artist}-${title}`,
    title,
    artist,
    album: true,
    year: 1990,
    duration: 'CD',
    rating: 'NR',
    overview: '',
    director: artist,
    actors: [],
    genres: ['Pop/Rock'],
    localPath: '',
    is4k: false,
    recordMedium: 'cd',
    ...extra,
  } as Movie;
}

describe('filing by artist', () => {
  test('leading articles are ignored, the way a real bin filed them', () => {
    assert.equal(filingLetter(album('The Beatles', 'Revolver')), 'B');
    assert.equal(filingLetter(album('A Tribe Called Quest', 'Low End Theory')), 'T');
    assert.equal(filingLetter(album('An Horse', 'Rearrange Beds')), 'H');
    // Not an article — "Theatre" must stay under T.
    assert.equal(filingLetter(album('Theatre of Tragedy', 'Aegis')), 'T');
  });

  test('leading punctuation is skipped', () => {
    assert.equal(filingLetter(album('...And You Will Know Us', 'Source Tags')), 'A');
    assert.equal(filingName(album('!!!', 'Myth Takes')), '!!!', 'an all-punctuation name keeps itself');
  });

  test('numerals and non-Latin scripts file under #, at the front', () => {
    assert.equal(filingLetter(album('10,000 Maniacs', 'In My Tribe')), '#');
    assert.equal(filingLetter(album('宝鐘マリン', 'Unison')), '#');
    const letters = dividerLetters({
      id: 'x', name: 'X', genres: [], movies: [
        album('Zebra', 'z'), album('10cc', 'y'), album('Air', 'x'),
      ],
    });
    assert.deepEqual(letters, ['#', 'A', 'Z']);
  });

  test('an artist\'s own records run earliest pressing first', () => {
    const sorted = [
      album('AC/DC', 'Back in Black', { year: 1980 }),
      album('AC/DC', 'High Voltage', { year: 1975 }),
      album('AC/DC', 'T.N.T.', { year: 1975 }),
    ].sort(shelfOrder);
    assert.deepEqual(sorted.map((a) => a.year), [1975, 1975, 1980]);
    // Same year → title order, so the bin is deterministic.
    assert.deepEqual(sorted.slice(0, 2).map((a) => a.title), ['High Voltage', 'T.N.T.']);
  });

  test('filing is case- and accent-insensitive between artists', () => {
    const sorted = [album('bôa', 'Twilight'), album('Blur', 'Parklife')].sort(shelfOrder);
    assert.deepEqual(sorted.map((a) => a.artist), ['Blur', 'bôa']);
  });
});

describe('the shop floor', () => {
  test('the specific department wins over the main floor', () => {
    // A Jazz/Pop-Rock artist belongs in JAZZ, not swallowed by ROCK / POP.
    const libs = buildMusicLibraries([
      ...Array.from({ length: 8 }, (_, i) => album(`Jazzer${i}`, `j${i}`, { genres: ['Jazz', 'Pop/Rock'] })),
      ...Array.from({ length: 8 }, (_, i) => album(`Rocker${i}`, `r${i}`, { genres: ['Pop/Rock'] })),
    ]);
    const jazz = libs.find((l) => l.name === 'JAZZ');
    assert.ok(jazz, 'expected a JAZZ department');
    assert.equal(jazz!.movies.length, 8);
    assert.equal(libs.find((l) => l.name === 'ROCK / POP')?.movies.length, 8);
  });

  test('a department too small to look like one folds into the main floor', () => {
    const libs = buildMusicLibraries([
      ...Array.from({ length: 10 }, (_, i) => album(`R${i}`, `r${i}`)),
      album('Lonely Reggae Act', 'Only One', { genres: ['Reggae'] }),
    ]);
    assert.equal(libs.find((l) => l.name === 'REGGAE'), undefined, 'one record is not a department');
    assert.equal(libs.find((l) => l.name === 'ROCK / POP')?.movies.length, 11);
  });

  test('untagged records get their own MISC bin rather than polluting Rock/Pop', () => {
    const libs = buildMusicLibraries([
      album('Tagged', 'a'),
      album('Untagged', 'b', { genres: [] }),
    ]);
    assert.equal(libs.find((l) => l.name === 'MISC')?.movies.length, 1);
    assert.equal(libs.find((l) => l.name === 'ROCK / POP')?.movies.length, 1);
  });

  test('you walk in to the main floor, and MISC is at the back', () => {
    const libs = buildMusicLibraries([
      ...Array.from({ length: 6 }, (_, i) => album(`J${i}`, `j${i}`, { genres: ['Jazz'] })),
      ...Array.from({ length: 3 }, (_, i) => album(`U${i}`, `u${i}`, { genres: [] })),
      ...Array.from({ length: 20 }, (_, i) => album(`R${i}`, `r${i}`)),
    ]);
    assert.equal(libs[0].name, 'ROCK / POP');
    assert.equal(libs[libs.length - 1].name, 'MISC');
  });

  test('departments are un-sectioned and flagged as music', () => {
    const libs = buildMusicLibraries([album('A', 'a')]);
    assert.equal(libs[0].music, true);
    assert.deepEqual(libs[0].genres, [], 'the department IS the genre — nothing left to sub-section');
  });

  test('libraryName is rewritten to the department the record ends up in', () => {
    const libs = buildMusicLibraries([album('A', 'a', { libraryName: 'My Music' })]);
    assert.equal(libs[0].movies[0].libraryName, 'ROCK / POP');
  });

  test('the result is memoised on the album array', () => {
    const albums = [album('A', 'a')];
    assert.equal(buildMusicLibraries(albums), buildMusicLibraries(albums));
  });

  test('records split cleanly by physical format', () => {
    const { vinyl, cd } = byFormat([
      album('A', 'a', { recordMedium: 'vinyl' }),
      album('B', 'b', { recordMedium: 'cd' }),
      album('C', 'c', { recordMedium: undefined }),
    ]);
    assert.equal(vinyl.length, 1);
    assert.equal(cd.length, 2, 'an unknown format racks as a CD');
  });
});
