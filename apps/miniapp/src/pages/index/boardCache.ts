// On-device SWR cache for the rankings 首页 — a per-cohort snapshot in Taro local
// storage, fail-closed on read. Mirrors `compute/history.ts`: `getStorageSync`/
// `setStorageSync` wrapped in try/catch, an `Array.isArray` guard, and read-time
// re-validation so a corrupt / stale-schema store NEVER renders unvalidated data.
//
// Boundary: the snapshot body REUSES the rankings contract — read re-validation
// runs through `parseRankingsResponse(raw)` (the SINGLE authoritative jitless
// validator for the rankings body; `jitless` is hardcoded inside it, so we pass
// `raw` as the ONLY argument — unlike history.ts which safeParses a bare schema).
// On ANY failure (throw / non-array / stale schema / dirty field) read → `null`,
// treated as a cache miss; we never fabricate a second validation path.
import Taro from '@tarojs/taro';
import { parseRankingsResponse, type RankingsItem } from '@unit-price/api-client';

/**
 * Cohort sentinel for the default (落地) board, where `useRankings()` passes no
 * `category` (`category === undefined`) and the server self-defaults to
 * `'soft-drink'`. The client neither has nor mirrors that server slug — the cache
 * key is the client's OWN `category` input, with `undefined` normalized to this
 * literal so the key is stable per board mount.
 */
export const DEFAULT_COHORT_KEY = '__default__';

/** Map the client's own `category` input to a stable cohort cache key. */
export function cohortKeyFor(category?: string): string {
  return category ?? DEFAULT_COHORT_KEY;
}

/** Storage key for one cohort's first-page snapshot (one key per cohort, overwrite). */
function storageKey(cohortKey: string): string {
  return `rankings:board:${cohortKey}`;
}

/**
 * Read the on-device first-page snapshot for a cohort, or `null` on a miss.
 *
 * Fail-closed: ① `getStorageSync` wrapped in try/catch (storage unavailable →
 * `null`); ② `Array.isArray` guard (a corrupt / never-written value → `null`,
 * never feed a non-array to the validator); ③ re-validate through
 * `parseRankingsResponse(raw)` (single param — jitless is internal) so a stale
 * schema / dirty field throws → `null`. NEVER returns unvalidated data.
 */
export function readBoard(cohortKey: string): RankingsItem[] | null {
  let raw: unknown;
  try {
    raw = Taro.getStorageSync(storageKey(cohortKey));
  } catch {
    return null;
  }
  if (!Array.isArray(raw)) return null;
  try {
    return parseRankingsResponse(raw);
  } catch {
    return null;
  }
}

/**
 * Overwrite one cohort's first-page snapshot. `setStorageSync` wrapped in
 * try/catch — a write failure (quota full / storage unavailable) only loses this
 * cache entry; it never bubbles or blocks rendering (same as history.ts).
 */
export function writeBoard(cohortKey: string, items: RankingsItem[]): void {
  try {
    Taro.setStorageSync(storageKey(cohortKey), items);
  } catch {
    // 写失败仅丢缓存、不阻断渲染。
  }
}
