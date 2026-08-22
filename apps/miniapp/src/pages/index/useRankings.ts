// Board data layer for the read-only list screens.
//
// Transport: Taro.request (WeChat has no fetch). The URL comes from api-client's
// buildRankingsUrl and the body is validated by parseRankingsSnapshot — the
// miniapp never hand-rolls the response type or skips validation.
//
// ONE fetch per page mount, not one per view. `GET /rankings` returns the whole
// board plus the category nodes; every view (cohort board, drill-down, search,
// paging) is cut from that object locally by api-client's derivation helpers. So
// switching cohort, turning a page and searching issue NO request. A second mount
// still revalidates — it renders from cache first, so the cost is bytes, not
// latency (there is no cross-mount freshness stamp).
//
// That collapses the old two-error-position state machine into one. Paging is a
// local slice: it cannot fail, so there is no page-level error and no per-page
// retry — a branch that can never run is not a safety net, it is dead code that
// reads like one. The remaining error position is the first screen (the snapshot
// fetch or its validation failed with nothing on screen).
import { useCallback, useMemo, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import {
  buildRankingsUrl,
  matchesQuery,
  normalizeQuery,
  pageOf,
  parseRankingsSnapshot,
  rowsInCohort,
  type CohortRejection,
  type RankingsSnapshot,
  type SnapshotViewRow,
} from '@unit-price/api-client';
import { BASE, BASE_IS_PLACEHOLDER, LANDING_COHORT, PAGE_SIZE } from './config';
import { readSnapshot, writeSnapshot, clearLegacyBoardCache } from './boardCache';

/** Coarse lifecycle phase driving the screen-level three-state render. */
export type RankingsPhase =
  | 'idle' // before first load
  | 'loading' // snapshot fetch in flight, nothing on screen yet
  | 'ready' // have a validated snapshot (the derived view may still be empty)
  | 'error'; // FIRST-SCREEN error: fetch/validation failed with nothing to show

export interface RankingsState {
  phase: RankingsPhase;
  /** The current page of the derived view, with 1-based ranks. */
  items: SnapshotViewRow[];
  /** True once every row of the derived view is on screen. */
  reachedEnd: boolean;
  /**
   * Why the requested cohort has no derivable view, if that is the case. Kept
   * distinct from `phase: 'error'`: the data arrived fine, this particular node
   * just has no single comparable board (or is not in the tree at all), and the
   * two read very differently to a user.
   */
  rejection: CohortRejection | null;
}

export interface RankingsApi extends RankingsState {
  /** Kick off the snapshot load. Callers guard via phase. */
  loadFirst: () => void;
  /** Pull-to-refresh: re-fetch the snapshot and reset to the first page. */
  refresh: () => Promise<void>;
  /** Reach-bottom: reveal the next local slice. Never fails, never requests. */
  loadNext: () => void;
  /** Whole-screen retry after a first-screen error. */
  retryFirst: () => void;
}

/** Fetch + validate the snapshot. Throws on transport or contract failure. */
async function fetchSnapshot(): Promise<RankingsSnapshot> {
  // Loud, clear failure on an unfilled BASE placeholder (the `[手动验证]` step):
  // surfaces a distinct "BASE 未配置" message rather than a generic URL-parse
  // error, so the placeholder can never be mistaken for a real config.
  if (BASE_IS_PLACEHOLDER) {
    throw new Error('BASE 未配置');
  }
  const res = await Taro.request({ url: buildRankingsUrl(BASE), method: 'GET' });
  if (res.statusCode !== 200) {
    throw new Error(`rankings ${res.statusCode}`);
  }
  return parseRankingsSnapshot(res.data);
}

/**
 * Derive the visible rows for a cohort + optional search word.
 *
 * Order is inherited, never recomputed: the server emits rows ascending by
 * (per100ml, id), and filtering a sorted list leaves it sorted. Search is
 * applied INSIDE the cohort — matching across cohorts would put rows on
 * different comparable axes next to each other.
 */
export function deriveRows(
  snapshot: RankingsSnapshot,
  category: string | undefined,
  q: string | undefined,
): { rows: SnapshotViewRow[]; rejection: CohortRejection | null } {
  // An unseeded taxonomy is a legal degenerate state (the server returns an empty
  // snapshot, not an error), so it is an empty board — NOT an unknown cohort.
  if (snapshot.categoryNodes.length === 0) return { rows: [], rejection: null };

  const inCohort = rowsInCohort(snapshot, category ?? LANDING_COHORT);
  if (!inCohort.ok) return { rows: [], rejection: inCohort.reason };

  // A `q` that normalizes away (< 2 code points) is NOT "no search". The board is
  // titled 「搜索:X」 either way, so falling through to the unfiltered cohort would
  // claim every row matched the word. The ≥2 gate exists because one CJK char
  // already matches most of the catalogue — passing it through matches all of it.
  // `SearchEntry` blocks this on the normal path; a hand-typed or deep-linked
  // `board?q=水` does not go through it.
  let filtered = inCohort.rows;
  if (q != null) {
    const word = normalizeQuery(q);
    filtered = word == null ? [] : inCohort.rows.filter((r) => matchesQuery(r.title, word));
  }

  // `rank` is assigned per view, so it is attached here rather than carried on
  // the wire — it changes every time the view changes. `|| 1` satisfies `pageOf`'s
  // `limit >= 1` domain on an empty result, where it returns [] either way.
  return { rows: pageOf(filtered, 0, filtered.length || 1), rejection: null };
}


/** The effects a load needs. Injected so the SWR rules below are assertable. */
export interface LoadEffects {
  fetch: () => Promise<RankingsSnapshot>;
  inFlight: { current: boolean };
  setSnapshot: (s: RankingsSnapshot) => void;
  setPhase: (p: RankingsPhase) => void;
  setVisible: (n: number) => void;
  write: (s: RankingsSnapshot) => void;
}

/**
 * One snapshot load. Extracted from the hook because inlining it left the whole
 * SWR state machine — the `keepOnFailure` / `resetVisible` split, the cache
 * write, the in-flight guard — reachable only through a React renderer this
 * package does not have. Deleting the `write` call then passed the entire
 * suite, so the cache-write side could have vanished silently.
 */
export async function runLoad(
  opts: { keepOnFailure: boolean; resetVisible: boolean },
  fx: LoadEffects,
): Promise<void> {
  if (fx.inFlight.current) return;
  fx.inFlight.current = true;
  try {
    const fresh = await fx.fetch();
    fx.setSnapshot(fresh);
    fx.setPhase('ready');
    if (opts.resetVisible) fx.setVisible(PAGE_SIZE);
    fx.write(fresh);
  } catch {
    // A revalidation failure with a snapshot already on screen keeps it —
    // stale data beats an empty screen, and it self-heals on the next load.
    if (!opts.keepOnFailure) fx.setPhase('error');
  } finally {
    fx.inFlight.current = false;
  }
}

/**
 * What the first load does with whatever the cache returned.
 *
 * `keepOnFailure` and `resetVisible` are NOT the same question, which is the
 * whole reason this is a table and not a boolean. The background revalidate
 * after a cache hit keeps the list on failure and must NOT reset the reveal —
 * it runs under the user's finger and would snap a scrolled list back. A cold
 * first screen has no list to keep and starts at the first slice anyway.
 *
 * A cached snapshot with zero rows is still a hit: it renders as an empty board,
 * never as a whole-screen error.
 */
export function firstLoadPlan(cached: RankingsSnapshot | null): {
  phase: RankingsPhase;
  render: RankingsSnapshot | null;
  load: { keepOnFailure: boolean; resetVisible: boolean };
} {
  return cached != null
    ? { phase: 'ready', render: cached, load: { keepOnFailure: true, resetVisible: false } }
    : { phase: 'loading', render: null, load: { keepOnFailure: false, resetVisible: true } };
}

/**
 * The reveal slice. Extracted for the same reason as `runLoad`: inlined, capping
 * `items` at a constant — the §6.25③ shape — passed the whole suite, and a
 * `reachedEnd` that lies turns a truncated board into "you have seen it all",
 * which is worse than an obvious truncation because it stops the user scrolling.
 */
export function revealOf(
  rows: SnapshotViewRow[],
  visible: number,
): { items: SnapshotViewRow[]; reachedEnd: boolean } {
  return { items: rows.slice(0, visible), reachedEnd: visible >= rows.length };
}

export function useRankings(category?: string, q?: string): RankingsApi {
  const [snapshot, setSnapshot] = useState<RankingsSnapshot | null>(null);
  const [phase, setPhase] = useState<RankingsPhase>('idle');
  const [visible, setVisible] = useState(PAGE_SIZE);
  // Guards against a second fetch racing the first (mount + pull-to-refresh).
  const inFlight = useRef(false);

  const derived = useMemo(
    () => (snapshot == null ? { rows: [], rejection: null } : deriveRows(snapshot, category, q)),
    [snapshot, category, q],
  );

  const load = useCallback(
    (opts: { keepOnFailure: boolean; resetVisible: boolean }) =>
      runLoad(opts, {
        fetch: fetchSnapshot,
        inFlight,
        setSnapshot,
        setPhase,
        setVisible,
        write: writeSnapshot,
      }),
    [],
  );

  const loadFirst = useCallback(() => {
    // Retired per-cohort keys are unreachable by the new read path; this only
    // reclaims their quota.
    clearLegacyBoardCache();
    const plan = firstLoadPlan(readSnapshot());
    if (plan.render != null) setSnapshot(plan.render);
    setPhase(plan.phase);
    void load(plan.load);
  }, [load]);

  const refresh = useCallback(async () => {
    await load({ keepOnFailure: snapshot != null, resetVisible: true });
  }, [load, snapshot]);

  const retryFirst = useCallback(() => {
    setPhase('loading');
    void load({ keepOnFailure: false, resetVisible: true });
  }, [load]);

  const loadNext = useCallback(() => {
    setVisible((n) => n + PAGE_SIZE);
  }, []);

  const { items, reachedEnd } = revealOf(derived.rows, visible);

  return {
    phase,
    items,
    reachedEnd,
    rejection: derived.rejection,
    loadFirst,
    refresh,
    loadNext,
    retryFirst,
  };
}
