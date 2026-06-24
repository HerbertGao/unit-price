// Rankings data layer + paginated state machine for the read-only list screen.
//
// Transport: Taro.request (WeChat has no fetch). URL is built by api-client's
// buildRankingsUrl and the response body is validated by parseRankingsResponse
// (a throw → ZodError or network error → the relevant error state). The miniapp
// NEVER hand-rolls the response type or skips validation.
//
// State machine distinguishes the two error positions the spec mandates:
//   - FIRST-SCREEN error (initial load fails OR parse throws, list still empty)
//     → whole-screen error + retry. Modeled as phase==='error' with items===[].
//   - PAGE error (a next page fails while a list is already loaded) → KEEP the
//     loaded list, expose a per-page local retry. Modeled as pageError===true
//     with items preserved; NEVER clears items back to a whole-screen error.
import { useCallback, useRef, useState } from 'react';
import Taro from '@tarojs/taro';
import {
  buildRankingsUrl,
  parseRankingsResponse,
  type RankingsItem,
} from '@unit-price/api-client';
import { BASE, BASE_IS_PLACEHOLDER, PAGE_SIZE } from './config';
import { readBoard, writeBoard, cohortKeyFor } from './boardCache';

/** Coarse lifecycle phase driving the screen-level three-state render. */
export type RankingsPhase =
  | 'idle' // before first load
  | 'loading' // first-screen load in flight, no list yet
  | 'ready' // have a (possibly empty) validated list
  | 'error'; // FIRST-SCREEN error: initial load/parse failed, list empty

export interface RankingsState {
  phase: RankingsPhase;
  items: RankingsItem[];
  /** True while a NEXT page (offset>0) request is in flight (footer spinner). */
  pageLoading: boolean;
  /** True when a next-page load failed but the existing list is preserved. */
  pageError: boolean;
  /** True once a page returned [] — no more pages, stop requesting. */
  reachedEnd: boolean;
}

export interface RankingsApi extends RankingsState {
  /** Kick off the very first page load (offset=0). Idempotent-ish: callers
   *  guard via phase. */
  loadFirst: () => void;
  /** Pull-to-refresh: reset offset=0, REPLACE the list with the fresh first
   *  page. Resolves after the request settles (so the page can stop the native
   *  pull-down spinner). */
  refresh: () => Promise<void>;
  /** Reach-bottom: load the next page (offset += limit) and APPEND. No-op while
   *  a page is loading, after reaching the end, or in a first-screen error. */
  loadNext: () => void;
  /** Whole-screen retry after a first-screen error. */
  retryFirst: () => void;
  /** Local retry for the failed next page (keeps the loaded list). */
  retryNext: () => void;
}

/** PURE: build one /rankings page URL from the page cursor + scope params.
 *  Extracted so the "pagination keeps q (and category)" invariant — every page,
 *  including page 2 (offset > 0), carries the same filter — is unit-testable
 *  without the Taro runtime. category/q undefined → buildRankingsUrl omits them
 *  (identical to the un-scoped 榜单 Tab URL). */
export function buildPageUrl(
  base: string,
  offset: number,
  category?: string,
  q?: string,
): string {
  return buildRankingsUrl(base, { limit: PAGE_SIZE, offset, category, q });
}

/** PURE: SWR cache is only read/written for the cohort FIRST page with no active
 *  search — i.e. offset 0 and a normalized q of undefined (useRankings already
 *  resolves an empty/whitespace q to undefined upstream). offset>0 (runNext) and
 *  a valid q (search) bypass the cache entirely, same as the server's no-store on
 *  a valid q. Extracted so the predicate is unit-testable without the Taro/React
 *  runtime. */
export function shouldUseBoardCache(offset: number, q?: string): boolean {
  return offset === 0 && q === undefined;
}

/** PURE: the single setState shape for a cache HIT — render the cached snapshot
 *  immediately as `ready`, SKIPPING the whole-screen loading phase. The paired
 *  offset cursor MUST be set to cached.length by the caller (so a bottom-reach
 *  runNext continues from cached.length, not 0 — otherwise it re-fetches and
 *  duplicates the first page). reachedEnd mirrors the happy-path runFirst rule. */
export function boardHitState(cached: RankingsItem[]): RankingsState {
  return {
    phase: 'ready',
    items: cached,
    pageLoading: false,
    pageError: false,
    reachedEnd: cached.length < PAGE_SIZE,
  };
}

/** PURE: first-screen catch decision, mirroring refresh's catch — if a list is
 *  already on screen (cache hit being revalidated, or any prior list), a failed
 *  first-page fetch MUST keep it (`ready`) rather than wipe to a whole-screen
 *  error; only an empty screen falls back to the first-screen error state. Caller
 *  resets offsetRef to 0 only on the error branch. */
export function firstScreenCatchState(prev: RankingsState): RankingsState {
  if (prev.items.length) {
    return { ...prev, phase: 'ready', pageLoading: false, pageError: false };
  }
  return {
    phase: 'error',
    items: [],
    pageLoading: false,
    pageError: false,
    reachedEnd: false,
  };
}

/** PURE: state after a runFirst background-revalidate FAILURE. A cache HIT (incl. an
 *  empty []) means a snapshot is already on screen → SWR keeps it (`ready`), even empty
 *  (spec「重验失败保留旧数据」). Without a hit, fall to the first-screen fork:
 *  a present list stays ready, an empty screen → whole-screen error. */
export function revalidateFailState(prev: RankingsState, hadCache: boolean): RankingsState {
  if (hadCache) return { ...prev, phase: 'ready', pageLoading: false, pageError: false };
  return firstScreenCatchState(prev);
}

/** One validated /rankings page fetch. Throws on network failure OR validation
 *  failure (parseRankingsResponse bubbles ZodError) — callers map to error
 *  state. */
async function fetchPage(offset: number, category?: string, q?: string): Promise<RankingsItem[]> {
  // Loud, clear failure on an unfilled BASE placeholder (the `[手动验证]` step):
  // surfaces a distinct "BASE 未配置" message via the error state instead of a
  // generic URL-parse error, so the placeholder can never be mistaken for a real
  // config or silently ship. (buildRankingsUrl would also throw on the
  // placeholder, but with a less actionable message.)
  if (BASE_IS_PLACEHOLDER) {
    throw new Error('BASE 未配置：请在 src/pages/index/config.ts 填入 prod worker 域名（[手动验证]，见任务 5.2）');
  }
  const url = buildPageUrl(BASE, offset, category, q);
  const res = await Taro.request({ url, method: 'GET' });
  // parseRankingsResponse is fail-closed: a bad body throws ZodError here.
  return parseRankingsResponse(res.data);
}

// `category` (optional) scopes every page fetch to one cohort via
// /rankings?category=<slug>; `q` (optional) filters by product title via
// /rankings?q=<term>. Both are stable per mount (route params) — passing them
// undefined yields the original un-scoped 榜单 Tab behavior unchanged. q MUST flow
// into ALL THREE fetchPage calls + ALL THREE useCallback deps (same as category):
// dropping it from runNext would let page 2 use a stale q and mix cohort rows into
// the search results (latent because board remounts per navigateTo, but guarded
// here against regression).
export function useRankings(category?: string, q?: string): RankingsApi {
  const [state, setState] = useState<RankingsState>({
    phase: 'idle',
    items: [],
    pageLoading: false,
    pageError: false,
    reachedEnd: false,
  });

  // Next offset to request. Kept in a ref so concurrent callbacks read the live
  // value without stale closures; mirrors items.length on the happy path but is
  // the authoritative cursor.
  const offsetRef = useRef(0);
  // Guards against overlapping in-flight requests (double pull / rapid scroll).
  const inFlightRef = useRef(false);
  // Fires the first load exactly once (idempotent across lifecycle re-invocations).
  const loadedRef = useRef(false);

  const runFirst = useCallback(async () => {
    // Order is load-bearing: claim inFlightRef FIRST, then read the SWR cache,
    // then the synchronous hit-render + offset, then the background fetch — the
    // whole "show cache + revalidate" lives in ONE inFlightRef occupancy, sharing
    // the same mutex as refresh/loadNext (so a mount-time pull-to-refresh can't
    // interleave with the background revalidation).
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const canCache = shouldUseBoardCache(0, q);
    const cohortKey = cohortKeyFor(category);
    const cached = canCache ? readBoard(cohortKey) : null;
    if (cached) {
      // HIT (cached may be []: a valid empty-cohort snapshot — instant empty render,
      // skips loading; do NOT "fix" to cached?.length). Render the snapshot as `ready`
      // and sync the cursor to cached.length so a subsequent bottom-reach continues
      // from there, not 0.
      offsetRef.current = cached.length;
      setState(boardHitState(cached));
    } else {
      // MISS: existing behavior — loading (only if we have no list to keep).
      setState((s) => ({ ...s, phase: s.items.length ? s.phase : 'loading' }));
    }
    try {
      const page = await fetchPage(0, category, q);
      offsetRef.current = page.length;
      setState({
        phase: 'ready',
        items: page,
        pageLoading: false,
        pageError: false,
        reachedEnd: page.length < PAGE_SIZE,
      });
      if (canCache) writeBoard(cohortKey, page);
    } catch {
      // A revalidate failure keeps a HIT snapshot (incl. empty []) as `ready`; with
      // no hit it forks on the live list — only a no-hit empty screen falls to the
      // first-screen error (and only that branch resets the cursor; a hit keeps it at
      // cached.length).
      const hadCache = cached !== null;
      setState((s) => {
        if (!hadCache && !s.items.length) offsetRef.current = 0;
        return revalidateFailState(s, hadCache);
      });
    } finally {
      inFlightRef.current = false;
    }
  }, [category, q]);

  const loadFirst = useCallback(() => {
    // Guard via a ref (not the setState updater) so runFirst — a side effect — never
    // runs inside a pure updater (React dev double-invokes those). Fires once.
    if (loadedRef.current) return;
    loadedRef.current = true;
    void runFirst();
  }, [runFirst]);

  const retryFirst = useCallback(() => {
    void runFirst();
  }, [runFirst]);

  const refresh = useCallback(async () => {
    // Pull-to-refresh always resets to offset=0 and replaces the list, even if
    // the screen was previously in a first-screen error state.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    const canCache = shouldUseBoardCache(0, q);
    const cohortKey = cohortKeyFor(category);
    try {
      const page = await fetchPage(0, category, q);
      offsetRef.current = page.length;
      setState({
        phase: 'ready',
        items: page,
        pageLoading: false,
        pageError: false,
        reachedEnd: page.length < PAGE_SIZE,
      });
      if (canCache) writeBoard(cohortKey, page);
    } catch {
      // If we already had a list, refresh failure must NOT wipe it. Keep the
      // list as-is WITHOUT raising pageError: that footer's retry maps to
      // next-page loading (retryNext → runNext → append), which is wrong for a
      // failed refresh. The pull-to-refresh gesture is itself the retry
      // affordance. If we had nothing, fall back to the whole-screen error.
      // (Same fork as runFirst, so share firstScreenCatchState.)
      setState((s) => firstScreenCatchState(s));
    } finally {
      inFlightRef.current = false;
    }
  }, [category, q]);

  const runNext = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setState((s) => ({ ...s, pageLoading: true, pageError: false }));
    try {
      const page = await fetchPage(offsetRef.current, category, q);
      if (page.length === 0) {
        // Empty page → reached the end, stop requesting.
        setState((s) => ({ ...s, pageLoading: false, reachedEnd: true }));
      } else {
        offsetRef.current += page.length;
        setState((s) => ({
          ...s,
          items: [...s.items, ...page],
          pageLoading: false,
          reachedEnd: page.length < PAGE_SIZE,
        }));
      }
    } catch {
      // Page error: KEEP the existing list, expose a local retry. Never clears
      // items / never reverts to the whole-screen error state.
      setState((s) => ({ ...s, pageLoading: false, pageError: true }));
    } finally {
      inFlightRef.current = false;
    }
  }, [category, q]);

  const loadNext = useCallback(() => {
    setState((s) => {
      // Only paginate from a healthy list with more pages and nothing in flight.
      if (
        s.phase === 'ready' &&
        !s.pageLoading &&
        !s.pageError &&
        !s.reachedEnd &&
        s.items.length > 0
      ) {
        void runNext();
      }
      return s;
    });
  }, [runNext]);

  const retryNext = useCallback(() => {
    setState((s) => {
      if (s.phase === 'ready' && !s.pageLoading) {
        void runNext();
      }
      return s;
    });
  }, [runNext]);

  return {
    ...state,
    loadFirst,
    refresh,
    loadNext,
    retryFirst,
    retryNext,
  };
}
