/**
 * Turning a pile of albums into a record shop's floor plan.
 *
 * Mirrors games-only.ts: synthesise `JellyfinLibrary[]` from a `Movie[]` of a
 * different medium, so the existing shelf planner, browse cursor, inspect flow
 * and checkout all work without knowing what's in the case.
 *
 * ─── Why the sections look like this ─────────────────────────────────────────
 *
 * Plex's music genres come from AllMusic's top level, which puts **77% of a
 * typical library under a single "Pop/Rock"** tag. Sectioning naively on that
 * gives one enormous bin and nineteen nearly-empty ones — a bad shop.
 *
 * But that's only a problem if you assume records were filed by genre. They
 * weren't. A real shop split the floor into a handful of broad departments —
 * ROCK/POP, JAZZ, HIP HOP, SOUNDTRACKS, CLASSICAL, COUNTRY, BLUES… — and then
 * filed **alphabetically by artist** inside each one, with tabbed divider cards
 * standing proud of the sleeves so you could flick to the letter you wanted.
 * The big Rock/Pop room IS the main floor. That's the authentic answer, and it
 * also happens to be what this data supports.
 *
 * So: a few departments, A–Z by artist within each, and small genres become
 * genuinely small sections the way they really were.
 */

import type { JellyfinLibrary, Movie } from './backend';

/**
 * Plex/AllMusic genre tag → the department it belongs to.
 *
 * Several tags collapse into one department on purpose: a shop had a HIP HOP
 * section, not separate Rap and R&B walls, and "Stage & Screen" is what a
 * shop's SOUNDTRACKS bin held. Anything unlisted falls through to ROCK / POP,
 * which is where an unrecognised rock-adjacent tag belongs anyway.
 */
const DEPARTMENTS: { name: string; tags: string[] }[] = [
  { name: 'JAZZ', tags: ['Jazz', 'Vocal', 'Avant-Garde'] },
  { name: 'HIP HOP', tags: ['Rap', 'R&B'] },
  { name: 'SOUNDTRACKS', tags: ['Stage & Screen'] },
  { name: 'CLASSICAL', tags: ['Classical'] },
  { name: 'BLUES', tags: ['Blues'] },
  { name: 'COUNTRY & FOLK', tags: ['Country', 'Folk'] },
  { name: 'ELECTRONIC', tags: ['Electronic', 'New Age'] },
  { name: 'REGGAE', tags: ['Reggae'] },
  { name: 'WORLD', tags: ['International'] },
  { name: 'GOSPEL', tags: ['Religious'] },
  { name: "KIDS", tags: ["Children's"] },
];

const MAIN_FLOOR = 'ROCK / POP';
const UNFILED = 'MISC';

/** A department needs enough records to be worth a section of its own; below
 *  this it reads as a gap in the racks rather than a department, so its stock
 *  joins the main floor. */
const MIN_DEPARTMENT_SIZE = 6;

function departmentFor(album: Movie): string {
  const tags = album.genres ?? [];
  if (tags.length === 0) return UNFILED;
  // First match wins over the DEPARTMENTS order, so a Jazz/Pop-Rock artist
  // files under JAZZ — the more specific department — rather than the main
  // floor. The list is ordered most-specific-first for exactly this reason.
  for (const dept of DEPARTMENTS) {
    if (tags.some((t) => dept.tags.includes(t))) return dept.name;
  }
  return MAIN_FLOOR;
}

/** Filing name: "The Beatles" files under B, "A-ha" under A. */
export function filingName(album: Movie): string {
  const raw = (album.artist || album.title || '').trim();
  // Leading articles are ignored when filing — a shop's Beatles divider is
  // under B. Also strips the punctuation a lot of stage names carry so
  // "…And You Will Know Us" files under A.
  return raw.replace(/^(the|a|an)\s+/i, '').replace(/^[^\p{L}\p{N}]+/u, '') || raw;
}

/** Divider-card letter for a record: A–Z, or # for anything else (numerals and
 *  non-Latin scripts, which a real shop filed together at the front). */
export function filingLetter(album: Movie): string {
  const first = filingName(album).charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : '#';
}

/** A–Z by artist, then by release year within an artist — which is how a
 *  shop's Bowie section ran: earliest pressing at the front. */
export function shelfOrder(a: Movie, b: Movie): number {
  const byArtist = filingName(a).localeCompare(filingName(b), undefined, { sensitivity: 'base' });
  if (byArtist !== 0) return byArtist;
  return (a.year || 0) - (b.year || 0) || a.title.localeCompare(b.title);
}

/**
 * Group albums into the shop's departments.
 *
 * Memoised on the album array's identity, like games-only.ts's storeCatalog —
 * a settings rebuild or a mode swap hands back the same library objects rather
 * than re-sorting a few thousand records.
 */
let catalogCache: { albums: Movie[]; libraries: JellyfinLibrary[] } | null = null;

export function buildMusicLibraries(albums: Movie[]): JellyfinLibrary[] {
  if (catalogCache?.albums === albums) return catalogCache.libraries;

  const byDept = new Map<string, Movie[]>();
  for (const album of albums) {
    const dept = departmentFor(album);
    let list = byDept.get(dept);
    if (!list) byDept.set(dept, (list = []));
    list.push(album);
  }

  // Fold undersized departments back onto the main floor.
  const main = byDept.get(MAIN_FLOOR) ?? [];
  for (const [name, stock] of [...byDept]) {
    if (name === MAIN_FLOOR || name === UNFILED) continue;
    if (stock.length < MIN_DEPARTMENT_SIZE) {
      main.push(...stock);
      byDept.delete(name);
    }
  }
  if (main.length > 0) byDept.set(MAIN_FLOOR, main);

  const libraries = [...byDept.entries()]
    // Main floor first, MISC last, the rest biggest-first — the way a shop is
    // laid out walking in.
    .sort((a, b) => {
      const rank = (n: string) => (n === MAIN_FLOOR ? -1 : n === UNFILED ? 1 : 0);
      return rank(a[0]) - rank(b[0]) || b[1].length - a[1].length || a[0].localeCompare(b[0]);
    })
    .map(([dept, stock]) => ({
      id: `music:${dept.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      name: dept,
      movies: stock
        .slice()
        .sort(shelfOrder)
        .map((m) => (m.libraryName === dept ? m : { ...m, libraryName: dept })),
      // Genres are what the department already IS, so there is nothing left to
      // sub-section by — same reasoning as games-only.ts's platform libraries.
      genres: [],
      music: true,
    }));

  catalogCache = { albums, libraries };
  return libraries;
}

/** Every distinct filing letter present in a department, in shelf order — the
 *  divider cards a bin needs. */
export function dividerLetters(library: JellyfinLibrary): string[] {
  const seen = new Set<string>();
  for (const album of library.movies) seen.add(filingLetter(album));
  const letters = [...seen];
  // '#' files at the front, as it did in a real bin.
  return letters.sort((a, b) => (a === '#' ? -1 : b === '#' ? 1 : a.localeCompare(b)));
}

/** Split a department's stock by physical format, for shops that rack CDs and
 *  bin LPs separately (which is what a 1993 shop did). */
export function byFormat(albums: Movie[]): { vinyl: Movie[]; cd: Movie[] } {
  return {
    vinyl: albums.filter((a) => a.recordMedium === 'vinyl'),
    cd: albums.filter((a) => a.recordMedium !== 'vinyl'),
  };
}
