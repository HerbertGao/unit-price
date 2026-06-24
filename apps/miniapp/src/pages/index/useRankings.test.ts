import { describe, it, expect, vi } from 'vitest';
import type { RankingsItem } from '@unit-price/api-client';

// useRankings.ts imports @tarojs/taro at module load (for Taro.request) and, via
// boardCache, get/setStorageSync. Stub it so the PURE helpers can be imported under
// vitest without the native runtime. There is no React/Taro hook renderer in this
// package, so — per the design's test strategy — the SWR decisions are extracted into
// PURE, exported functions (shouldUseBoardCache / boardHitState / firstScreenCatchState)
// that runFirst/refresh call, and we unit-test THOSE. The hook-level end-to-end paths
// (cache hit → instant ready → background overwrite; bottom-reach after hit) are covered
// by the devtools/real-device check (task 3.2).
vi.mock('@tarojs/taro', () => ({
  default: { request: vi.fn(), getStorageSync: vi.fn(), setStorageSync: vi.fn() },
}));
// config.ts reads a BASE constant; import the real one (no Taro dep).

import {
  buildPageUrl,
  shouldUseBoardCache,
  boardHitState,
  firstScreenCatchState,
  revalidateFailState,
  type RankingsState,
} from './useRankings';
import { PAGE_SIZE } from './config';

const BASE = 'https://api.example.com';

// A minimal valid ranking row, reused to build cached snapshots.
const row = (rank: number): RankingsItem => ({
  rank,
  title: `可乐 ${rank}`,
  priceCents: 4000,
  per100ml: 0.5,
  formula: '40 / (330 * 24) * 100',
  confidence: 0.95,
  warnings: [],
  store: 'sam',
  storeSku: `sku-${rank}`,
  sourceUrl: null,
});

const readyState = (items: RankingsItem[]): RankingsState => ({
  phase: 'ready',
  items,
  pageLoading: false,
  pageError: false,
  reachedEnd: false,
});

describe('buildPageUrl — pagination keeps the q filter (regression for runNext)', () => {
  it('page 1 (offset 0) carries q', () => {
    expect(buildPageUrl(BASE, 0, undefined, '可乐')).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=0&q=%E5%8F%AF%E4%B9%90`,
    );
  });

  it('page 2 (offset = PAGE_SIZE) STILL carries the same q (not dropped/staled)', () => {
    // The whole point of task 4.1: runNext must thread q into fetchPage too, or
    // page 2 would request /rankings WITHOUT q and mix cohort rows into the search.
    expect(buildPageUrl(BASE, PAGE_SIZE, undefined, '可乐')).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&q=%E5%8F%AF%E4%B9%90`,
    );
  });

  it('q + category coexist across pages', () => {
    expect(buildPageUrl(BASE, PAGE_SIZE, 'soft-drink', '可乐')).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}&category=soft-drink&q=%E5%8F%AF%E4%B9%90`,
    );
  });

  it('no q → URL identical to the un-scoped 榜单 behavior (no q= key)', () => {
    expect(buildPageUrl(BASE, PAGE_SIZE, undefined, undefined)).toBe(
      `${BASE}/rankings?limit=${PAGE_SIZE}&offset=${PAGE_SIZE}`,
    );
  });
});

describe('shouldUseBoardCache — cache only the cohort FIRST page, never search/pagination', () => {
  it('offset 0 + no q → true (the only cacheable case)', () => {
    expect(shouldUseBoardCache(0, undefined)).toBe(true);
  });

  it('offset>0 (runNext / pagination) → false, regardless of q', () => {
    expect(shouldUseBoardCache(PAGE_SIZE, undefined)).toBe(false);
    expect(shouldUseBoardCache(1, undefined)).toBe(false);
  });

  it('a valid q (search) → false even at offset 0 (server sends no-store)', () => {
    expect(shouldUseBoardCache(0, '可乐')).toBe(false);
    // a normalized-but-present empty/blank q is still "defined" → bypass.
    expect(shouldUseBoardCache(0, '')).toBe(false);
  });
});

describe('boardHitState — cache hit renders ready immediately (no loading), cursor = cached.length', () => {
  it('hit → phase ready (skips loading) with the cached items verbatim', () => {
    const cached = [row(1), row(2), row(3)];
    const s = boardHitState(cached);
    expect(s.phase).toBe('ready'); // NOT loading — instant回显
    expect(s.items).toBe(cached);
    expect(s.pageLoading).toBe(false);
    expect(s.pageError).toBe(false);
  });

  it('the caller pairs this with offsetRef = cached.length so 触底 runNext continues, not re-fetches page 1', () => {
    // The cursor value the caller sets is exactly items.length; combined with
    // buildPageUrl(offset=cached.length) above, page-2 is requested from there,
    // never offset 0 (no first-page duplication). This asserts the contract the
    // caller relies on: the hit state exposes the full list whose length is the cursor.
    const cached = [row(1), row(2)];
    expect(boardHitState(cached).items.length).toBe(2);
    // a full page (cached.length === PAGE_SIZE) is NOT reachedEnd (more may follow)
    const full = Array.from({ length: PAGE_SIZE }, (_, i) => row(i + 1));
    expect(boardHitState(full).reachedEnd).toBe(false);
    // a short page IS the end (mirrors happy-path runFirst)
    expect(boardHitState(cached).reachedEnd).toBe(PAGE_SIZE > 2);
  });
});

describe('firstScreenCatchState — background/refresh failure forks on the live list', () => {
  it('has a list (cache hit being revalidated) → KEEP it, stay ready (no clear, no整屏 error)', () => {
    const prev = readyState([row(1), row(2)]);
    const s = firstScreenCatchState(prev);
    expect(s.phase).toBe('ready');
    expect(s.items).toEqual([row(1), row(2)]); // 旧快照保留
    expect(s.pageError).toBe(false); // not a page error either
  });

  it('empty screen (cache miss, fresh fetch failed) → whole-screen error + empty', () => {
    const s = firstScreenCatchState(readyState([]));
    expect(s.phase).toBe('error');
    expect(s.items).toEqual([]);
  });
});

describe('revalidateFailState — runFirst background-revalidate failure forks on hadCache', () => {
  it('hadCache + EMPTY snapshot → stays ready (the bug: an empty [] hit must NOT flip to整屏 error)', () => {
    const s = revalidateFailState(readyState([]), true);
    expect(s.phase).toBe('ready'); // 旧空快照保留，禁止清屏
    expect(s.items).toEqual([]);
    expect(s.pageError).toBe(false);
  });

  it('hadCache + a list → stays ready, list preserved', () => {
    const s = revalidateFailState(readyState([row(1), row(2)]), true);
    expect(s.phase).toBe('ready');
    expect(s.items).toEqual([row(1), row(2)]);
  });

  it('no cache + empty screen → whole-screen error (first-screen fork)', () => {
    const s = revalidateFailState(readyState([]), false);
    expect(s.phase).toBe('error');
    expect(s.items).toEqual([]);
  });

  it('no cache + a list → stays ready (first-screen fork keeps the list)', () => {
    const s = revalidateFailState(readyState([row(1)]), false);
    expect(s.phase).toBe('ready');
    expect(s.items).toEqual([row(1)]);
  });
});
