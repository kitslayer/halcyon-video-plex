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
 * Genre tag → the department a shop would file it under.
 *
 * A HINT TABLE, not a whitelist. Different servers and taggers use wildly
 * different vocabularies — one library's genres come from AllMusic's dozen
 * top-level buckets, another's from ID3 tags naming a hundred micro-genres —
 * so anything unrecognised is NOT forced into a catch-all. It becomes its own
 * department if enough records share it (see buildMusicLibraries), which is how
 * a library tagged entirely "Shoegaze / Post-Punk / Dream Pop" still gets a
 * sensible floor plan.
 *
 * What this table does is merge synonyms a shop would never have split: RAP and
 * HIP-HOP are one section, SOUNDTRACK and "Stage & Screen" are one bin.
 */
const DEPARTMENT_SYNONYMS: Record<string, string> = {
  // Rock / pop family
  'pop/rock': 'ROCK / POP', 'rock': 'ROCK / POP', 'pop': 'ROCK / POP',
  'alternative rock': 'ROCK / POP', 'alternative': 'ROCK / POP', 'indie': 'ROCK / POP',
  'indie rock': 'ROCK / POP', 'punk': 'ROCK / POP', 'metal': 'METAL',
  'heavy metal': 'METAL', 'hard rock': 'ROCK / POP',
  // Hip hop
  'rap': 'HIP HOP', 'hip hop': 'HIP HOP', 'hip-hop': 'HIP HOP', 'r&b': 'HIP HOP',
  'rnb': 'HIP HOP', 'soul': 'SOUL / FUNK', 'funk': 'SOUL / FUNK', 'disco': 'SOUL / FUNK',
  // Jazz & blues
  'jazz': 'JAZZ', 'vocal': 'JAZZ', 'avant-garde': 'JAZZ', 'blues': 'BLUES',
  // Electronic
  'electronic': 'ELECTRONIC', 'electronica': 'ELECTRONIC', 'house': 'ELECTRONIC',
  'techno': 'ELECTRONIC', 'ambient': 'ELECTRONIC', 'new age': 'ELECTRONIC',
  'edm': 'ELECTRONIC', 'dance': 'ELECTRONIC',
  // The rest
  'stage & screen': 'SOUNDTRACKS', 'soundtrack': 'SOUNDTRACKS', 'score': 'SOUNDTRACKS',
  'classical': 'CLASSICAL', 'opera': 'CLASSICAL',
  'country': 'COUNTRY & FOLK', 'folk': 'COUNTRY & FOLK', 'bluegrass': 'COUNTRY & FOLK',
  'reggae': 'REGGAE', 'ska': 'REGGAE',
  'international': 'WORLD', 'world': 'WORLD', 'latin': 'WORLD',
  'religious': 'GOSPEL', 'gospel': 'GOSPEL',
  "children's": 'KIDS', 'kids': 'KIDS',
  'comedy': 'COMEDY', 'spoken word': 'SPOKEN WORD',
};

const UNFILED = 'MISC';

/**
 * Smallest department worth its own section, as a FRACTION of the library.
 *
 * Proportional rather than absolute so the plan holds at any size: a fixed "6
 * records" would shatter a small collection into singleton departments and
 * would be invisible in a huge one. The floor of 3 stops a tiny library from
 * demanding an impossible share.
 */
const MIN_DEPARTMENT_FRACTION = 0.004;
const MIN_DEPARTMENT_FLOOR = 3;

/** Canonical department for one genre tag — the synonym table if it knows the
 *  tag, otherwise the tag itself, upper-cased, as its own department. */
function canonicalDepartment(tag: string): string {
  const key = tag.trim().toLowerCase();
  return DEPARTMENT_SYNONYMS[key] ?? tag.trim().toUpperCase();
}

/**
 * Every department an album could file under, most-specific first.
 *
 * An album tagged both "Jazz" and "Pop/Rock" should end up in JAZZ, because
 * that is the more particular claim. Rather than hard-code which tags are
 * general, buildMusicLibraries decides by POPULARITY: the rarer department wins,
 * since a shop's specific sections are always smaller than its main floor.
 */
function candidateDepartments(album: Movie): string[] {
  const tags = album.genres ?? [];
  if (tags.length === 0) return [];
  return [...new Set(tags.map(canonicalDepartment))];
}

/** Filing name: "The Beatles" files under B, "A-ha" under A. */
export function filingName(album: Movie): string {
  const raw = (album.artist || album.title || '').trim();
  // Leading articles are ignored when filing — a shop's Beatles divider is
  // under B. Also strips the punctuation a lot of stage names carry so
  // "…And You Will Know Us" files under A.
  return raw.replace(/^(the|a|an)\s+/i, '').replace(/^[^\p{L}\p{N}]+/u, '') || raw;
}

/**
 * Non-Latin scripts get a divider of their own rather than all landing in one
 * bucket. Filing an entire Japanese or Cyrillic collection under a single "#"
 * card makes that bin useless — and a shop stocking those records labelled the
 * divider by script, exactly like an import section.
 */
const SCRIPT_DIVIDERS: { label: string; re: RegExp }[] = [
  { label: 'あ', re: /[぀-ヿ]/ },              // kana
  { label: '漢', re: /[㐀-䶿一-鿿]/ }, // han
  { label: '한', re: /[가-힯ᄀ-ᇿ]/ }, // hangul
  { label: 'А', re: /[Ѐ-ӿ]/ },              // cyrillic
  { label: 'Α', re: /[Ͱ-Ͽ]/ },              // greek
  { label: 'א', re: /[֐-׿]/ },              // hebrew
  { label: 'ا', re: /[؀-ۿ]/ },              // arabic
  { label: 'ก', re: /[฀-๿]/ },              // thai
];

/**
 * Divider-card label for a record.
 *
 * A–Z for Latin (accents folded, so Á files under A), a script card for
 * non-Latin, and # for numerals and symbols — which is where a shop put them,
 * at the front of the bin.
 */
export function filingLetter(album: Movie): string {
  const name = filingName(album);
  const first = name.charAt(0);
  if (!first) return '#';
  // Fold accents so Ólafur files under O rather than its own card.
  const folded = first.normalize('NFD').replace(/\p{Diacritic}/gu, '').toUpperCase();
  if (/^[A-Z]$/.test(folded)) return folded;
  for (const { label, re } of SCRIPT_DIVIDERS) {
    if (re.test(first)) return label;
  }
  return '#';
}

/** Divider order: # first, then A–Z, then script cards — a Latin shop's bin
 *  with its import dividers at the back. */
function dividerRank(label: string): number {
  if (label === '#') return 0;
  if (/^[A-Z]$/.test(label)) return 1;
  return 2;
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

  // Pass 1 — how common is each candidate department? This is what decides
  // which tag wins for an album carrying several, and which departments are
  // big enough to exist at all. Deriving it from the data is what lets an
  // unfamiliar tagging vocabulary produce a sensible shop.
  const popularity = new Map<string, number>();
  for (const album of albums) {
    for (const dept of candidateDepartments(album)) {
      popularity.set(dept, (popularity.get(dept) ?? 0) + 1);
    }
  }

  // Pass 2 — file each album under its RAREST candidate department, so a
  // Jazz/Pop-Rock record lands in the smaller, more specific JAZZ rather than
  // being swallowed by the main floor.
  const byDept = new Map<string, Movie[]>();
  for (const album of albums) {
    const candidates = candidateDepartments(album);
    const dept = candidates.length === 0
      ? UNFILED
      : candidates.reduce((best, d) =>
          (popularity.get(d) ?? 0) < (popularity.get(best) ?? 0) ? d : best);
    let list = byDept.get(dept);
    if (!list) byDept.set(dept, (list = []));
    list.push(album);
  }

  // Pass 3 — fold departments too small to read as a section into the largest
  // one, which is the shop's main floor whatever it happens to be called. (In a
  // jazz collection that IS jazz; nothing here assumes rock.)
  const threshold = Math.max(MIN_DEPARTMENT_FLOOR, Math.ceil(albums.length * MIN_DEPARTMENT_FRACTION));
  const mainFloor = [...byDept.entries()]
    .filter(([name]) => name !== UNFILED)
    .sort((a, b) => b[1].length - a[1].length)[0]?.[0];
  if (mainFloor) {
    const main = byDept.get(mainFloor)!;
    for (const [name, stock] of [...byDept]) {
      if (name === mainFloor || name === UNFILED) continue;
      if (stock.length < threshold) {
        main.push(...stock);
        byDept.delete(name);
      }
    }
  }

  const libraries = [...byDept.entries()]
    // Main floor first, MISC last, the rest biggest-first — the way a shop is
    // laid out walking in.
    .sort((a, b) => {
      const rank = (n: string) => (n === mainFloor ? -1 : n === UNFILED ? 1 : 0);
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
  return [...seen].sort((a, b) => dividerRank(a) - dividerRank(b) || a.localeCompare(b));
}

/** Split a department's stock by physical format, for shops that rack CDs and
 *  bin LPs separately (which is what a 1993 shop did). */
export function byFormat(albums: Movie[]): { vinyl: Movie[]; cd: Movie[] } {
  return {
    vinyl: albums.filter((a) => a.recordMedium === 'vinyl'),
    cd: albums.filter((a) => a.recordMedium !== 'vinyl'),
  };
}
