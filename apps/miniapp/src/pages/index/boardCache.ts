// On-device snapshot cache (stale-while-revalidate).
//
// ONE key, ONE object. The board, the category tree, search and drill-down are
// all derived from the same snapshot, so the retired per-cohort page cache
// stored the same rows several times over and let the copies expire to
// different revisions.
//
// The key carries `v1` because the stored SHAPE changed — a bare row array
// became a snapshot object. Bumping the name is what makes that safe: the new
// read path only ever looks at this key, so a legacy value is unreachable
// whether or not it is deleted. Deleting them (below) is about reclaiming
// quota, NOT about correctness.
//
// Fail-closed on read, mirroring `compute/history.ts`: a stored value is
// re-validated through the same schema the network response goes through, so a
// value written by an older build or a truncated write is a miss, never
// rendered.
import Taro from '@tarojs/taro';
import { parseRankingsSnapshot, type RankingsSnapshot } from '@unit-price/api-client';

/** Storage key for the whole board snapshot. `v1` = this stored shape. */
export const SNAPSHOT_CACHE_KEY = 'rankings:snapshot:v1';

/** Prefix of the retired per-cohort page cache. */
const LEGACY_KEY_PREFIX = 'rankings:board:';

/**
 * Read + re-validate the cached snapshot, or `null` on any miss/defect.
 *
 * Never throws: a corrupt cache must not stop the app from fetching a fresh
 * one. `parseRankingsSnapshot` also runs the cross-field invariants, so a
 * partially-written object is a miss rather than a board quietly missing rows.
 */
export function readSnapshot(): RankingsSnapshot | null {
  let raw: unknown;
  try {
    raw = Taro.getStorageSync(SNAPSHOT_CACHE_KEY);
  } catch {
    return null;
  }
  if (raw === '' || raw == null) return null;
  try {
    return parseRankingsSnapshot(raw);
  } catch {
    return null;
  }
}

/**
 * Cache a validated snapshot. A write failure (quota full, storage unavailable)
 * is swallowed on purpose: losing the cache costs one network round-trip on the
 * next cold start, while throwing here would take down a board that has already
 * rendered.
 */
export function writeSnapshot(snapshot: RankingsSnapshot): void {
  try {
    Taro.setStorageSync(SNAPSHOT_CACHE_KEY, snapshot);
  } catch {
    // 写失败仅丢缓存、不阻断渲染。
  }
}

/**
 * Drop the retired per-cohort keys. Best-effort quota reclamation; correctness
 * comes from the key rename, so a failure here is harmless.
 */
export function clearLegacyBoardCache(): void {
  try {
    const { keys } = Taro.getStorageInfoSync();
    for (const key of keys) {
      if (key.startsWith(LEGACY_KEY_PREFIX)) Taro.removeStorageSync(key);
    }
  } catch {
    // Never block startup on cleanup.
  }
}
