/**
 * Physical box shapes for media that isn't a standard movie case: the game
 * cartons and the records. What each one measures, and how the shelf machinery
 * recognises it.
 *
 * A record is dimensionally just another box shape, so it rides the SAME
 * pipeline the game cartons do — batching by shape key, per-shape geometry,
 * jewel-case dressing — rather than growing a third parallel path through
 * store-stock. The pseudo-platforms below are the join: an album reports one of
 * these where a game reports 'SNES', and everything downstream keeps working.
 *
 * Lives outside video-case.ts to keep that file inside its line budget (see
 * CLAUDE.md's extraction pattern).
 */

// ─── Game cartons ───────────────────────────────────────────────────────────

export const GAME_BOX_IN: Record<string, [number, number, number]> = {
  // Cartridge era — cardboard cartons and plastic clamshells.
  'NES': [5.0, 7.0, 1.0],
  'SNES': [7.5, 5.25, 1.1],              // NA landscape carton
  'SUPER FAMICOM': [4.2, 7.5, 1.1],      // JP carton: tall and narrow, not a wide Snes box
  'NINTENDO 64': [7.5, 5.25, 1.1],       // landscape carton
  'GAME BOY': [4.75, 5.25, 0.9],         // near-square
  'GAME BOY COLOR': [4.75, 5.25, 0.9],
  'GAME BOY ADVANCE': [4.8, 5.4, 0.9],   // portrait, like the GB carton
  'GENESIS': [5.5, 7.5, 1.2],
  'SEGA MASTER SYSTEM': [5.5, 7.0, 1.0],
  'ATARI': [5.0, 7.0, 1.0],
  'TURBOGRAFX-16': [5.5, 4.9, 0.9],
  'ARCADE': [5.0, 7.0, 1.0],             // Neo Geo AES cartons are far larger;
                                         // a rental store sleeved odd carts.
  // Optical era — jewel cases and keep cases.
  'PLAYSTATION': [5.6, 4.9, 0.4],        // CD jewel case, landscape
  'SEGA SATURN': [4.9, 5.6, 0.4],        // CD jewel case, portrait
  'SEGA CD': [5.5, 7.9, 0.75],
  'DREAMCAST': [5.5, 7.5, 0.6],
  'PLAYSTATION 2': [5.3, 7.5, 0.55],     // DVD keep case
  'GAMECUBE': [5.3, 7.4, 0.6],
  'XBOX': [5.3, 7.5, 0.55],
  'NINTENDO 3DS': [5.4, 4.75, 0.5],      // small keep case, landscape
  'NINTENDO DSI': [5.4, 4.9, 0.5],       // DS-family keep case, landscape
  'NINTENDO SWITCH': [4.2, 6.6, 0.45],   // portrait keep case
  'PSP': [4.1, 6.7, 0.6],                // UMD case, portrait
  'WII U': [5.3, 7.5, 0.6],              // DVD-footprint keep case
};

// ─── Records ────────────────────────────────────────────────────────────────

/** What an album reports where a game reports its console. */
export const RECORD_PLATFORM = { vinyl: 'VINYL LP', cd: 'COMPACT DISC' } as const;

/**
 * Real sleeve/case sizes in inches — [width, height, depth] — measured the same
 * way the game cartons are:
 *
 *   - A 12" LP **jacket** is 12.375 in square. (The disc is 12; the sleeve is
 *     what you actually see in a bin.)
 *   - A standard CD jewel case is 142 x 125 x 10.4 mm.
 */
export const RECORD_BOX_IN: Record<string, [number, number, number]> = {
  [RECORD_PLATFORM.vinyl]: [12.375, 12.375, 0.25],
  [RECORD_PLATFORM.cd]: [5.59, 4.92, 0.4],
};

/** Depth of a gatefold double LP, inches. Two jackets hinged, so a little under
 *  twice a single sleeve — not the jewel case's tray-stack figure. */
export const GATEFOLD_DEPTH_IN = 0.45;

/** Minimal shape of the fields these helpers read, so callers can pass a Movie
 *  without this module importing the whole type graph. */
interface BoxLike {
  game?: boolean;
  platform?: string;
  album?: boolean;
  recordMedium?: 'vinyl' | 'cd';
}

/** The record pseudo-platform for an album, or undefined for anything else. */
export function recordPlatform(movie: BoxLike): string | undefined {
  if (!movie.album) return undefined;
  return movie.recordMedium === 'vinyl' ? RECORD_PLATFORM.vinyl : RECORD_PLATFORM.cd;
}

/** Whether a platform key is one of the record formats. */
export function isRecordPlatform(platform?: string): boolean {
  return platform === RECORD_PLATFORM.vinyl || platform === RECORD_PLATFORM.cd;
}

/**
 * Platform key for anything carrying its own box shape — a game's carton or a
 * record's sleeve. Undefined means "a standard movie case", which the
 * store-wide CASE_MEDIUM already covers.
 */
export function customBoxPlatform(movie: BoxLike): string | undefined {
  return movie.album ? recordPlatform(movie) : (movie.game ? movie.platform : undefined);
}

/** Whether this title is shelved in a box of its own shape rather than the
 *  store's standard case. */
export function hasCustomBox(movie: BoxLike): boolean {
  return !!customBoxPlatform(movie);
}

/**
 * Depth override in inches for a record whose format changes its thickness,
 * or undefined to keep the table's figure. Only the gatefold double LP does:
 * a multi-disc CD is handled by the jewel case's own fat path.
 */
export function recordDepthOverrideIn(platform?: string, discCount?: number): number | undefined {
  return platform === RECORD_PLATFORM.vinyl && (discCount ?? 1) >= 2 ? GATEFOLD_DEPTH_IN : undefined;
}

/** Memo-key suffix distinguishing a gatefold from a single sleeve — without it
 *  every multi-disc vinyl gets the single-sleeve dims back out of the cache. */
export function recordShapeSuffix(platform?: string, discCount?: number): string {
  return recordDepthOverrideIn(platform, discCount) !== undefined ? '#gatefold' : '';
}
