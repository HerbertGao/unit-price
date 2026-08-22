// Board data layer — the pure derivation the hook calls.
//
// RETIRED with the server-pagination state machine (~15 cases): `buildPageUrl`
// (there is one URL and it takes no params), `shouldUseBoardCache` (one cache
// object, always cacheable), `boardHitState` / `firstScreenCatchState` /
// `revalidateFailState` (the two-error-position fork is gone — a local slice
// cannot fail, so there is no page error to fork on).
//
// KEPT as the thing worth testing: `deriveRows`, which is where cohort
// membership, search scope and order actually get decided — plus `runLoad` and
// `firstLoadPlan`, the SWR decisions the rewrite had inlined into the hook.
// "No hook renderer in this package" was true and was still the wrong
// conclusion: it left deleting the cache write, or swapping the two
// keep/reset booleans, passing the whole suite. The decisions take their
// effects as arguments, so they need no renderer; only the `useCallback`
// plumbing does, and that stays on the devtools/real-device check.
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tarojs/taro', () => ({
  default: {
    request: vi.fn(),
    getStorageSync: vi.fn(),
    setStorageSync: vi.fn(),
    removeStorageSync: vi.fn(),
    getStorageInfoSync: () => ({ keys: [] }),
  },
}));

import { parseRankingsSnapshot, type RankingsSnapshot } from '@unit-price/api-client';
import { PAGE_SIZE } from './config';
import { deriveRows, firstLoadPlan, revealOf, runLoad, type LoadEffects, type RankingsPhase } from './useRankings';

const NODES = [
  { slug: 'beverage', name: '饮料', parentSlug: null, comparableUnit: null, rankable: false },
  {
    slug: 'soft-drink',
    name: '软饮',
    parentSlug: 'beverage',
    comparableUnit: 'per_100ml',
    rankable: true,
  },
  {
    slug: 'carbonated',
    name: '碳酸饮料',
    parentSlug: 'soft-drink',
    comparableUnit: 'per_100ml',
    rankable: true,
  },
  {
    slug: 'dairy',
    name: '乳品',
    parentSlug: 'beverage',
    comparableUnit: 'per_100ml',
    rankable: true,
  },
];

function row(id: string, per100ml: number, categorySlugs: string[], title = `t-${id}`) {
  return {
    id,
    title,
    priceCents: 100,
    per100ml,
    formula: 'f',
    confidence: 0.95,
    warnings: [],
    store: 'sam',
    storeSku: `sku-${id}`,
    sourceUrl: null,
    categorySlugs,
  };
}

function snap(rows: ReturnType<typeof row>[]): RankingsSnapshot {
  return parseRankingsSnapshot({ rows, categoryNodes: NODES, excluded: [] });
}

describe('deriveRows — cohort scope', () => {
  it('includes descendants of the requested node', () => {
    const s = snap([row('c', 1, ['carbonated']), row('d', 2, ['dairy'])]);

    const got = deriveRows(s, 'soft-drink', undefined);

    expect(got.rows.map((r) => r.id)).toEqual(['c']);
    expect(got.rejection).toBeNull();
  });

  it('surfaces a row attached to a NON-LEAF node under that node', () => {
    // `soft-drink` has a child, so this attachment is non-leaf — the state
    // taxonomy growth produces. Dropping it would lose a live catalogue row.
    const s = snap([row('legacy', 1, ['soft-drink']), row('c', 2, ['carbonated'])]);

    const got = deriveRows(s, 'soft-drink', undefined);

    expect(got.rows.map((r) => r.id)).toEqual(['legacy', 'c']);
  });

  it('refuses a cross-cohort node instead of mixing axes', () => {
    const s = snap([row('c', 1, ['carbonated'])]);

    const got = deriveRows(s, 'beverage', undefined);

    expect(got.rows).toEqual([]);
    expect(got.rejection?.kind).toBe('cross-cohort');
  });

  it('reports an unknown slug distinctly from a cross-cohort one', () => {
    const s = snap([row('c', 1, ['carbonated'])]);

    const got = deriveRows(s, 'ghost', undefined);

    expect(got.rejection?.kind).toBe('unknown-category');
  });

  it('lands on LANDING_COHORT by name when none is given', () => {
    // The fixture contains the tie that broke the derived version: `soft-drink`
    // and `dairy` are both depth-1 `per_100ml` children of `beverage`. Assert the
    // cohort by IDENTITY — a cardinality assertion (`rows.length > 0`) passes
    // under either winner, which is exactly how the landing board shipped as 乳品.
    const s = snap([row('c', 1, ['carbonated']), row('d', 2, ['dairy'])]);

    const got = deriveRows(s, undefined, undefined);

    expect(got.rejection).toBeNull();
    expect(got.rows.map((r) => r.id)).toEqual(['c']);
  });

  it('an unseeded taxonomy is an empty board, not an unknown cohort', () => {
    // The server returns `{rows: [], categoryNodes: [], excluded: []}` as a legal
    // 200. LANDING_COHORT is absent from that tree, so a naive lookup would report
    // `unknown-category` and the screen would accuse the user's own catalogue.
    const s = parseRankingsSnapshot({ rows: [], categoryNodes: [], excluded: [] });

    const got = deriveRows(s, undefined, undefined);

    expect(got).toEqual({ rows: [], rejection: null });
  });
});

describe('deriveRows — order and search', () => {
  it('preserves the server order — the client never sorts', () => {
    // Deliberately NOT ascending: an already-sorted fixture cannot tell
    // "inherited the server's order" from "re-sorted it ascending", and the
    // second is exactly what the contract forbids.
    const s = snap([
      row('a', 9, ['carbonated']),
      row('b', 1, ['carbonated']),
      row('c', 5, ['carbonated']),
    ]);

    const got = deriveRows(s, 'carbonated', undefined);

    expect(got.rows.map((r) => r.per100ml)).toEqual([9, 1, 5]);
    // `rank` is the position in THIS view, so it counts 1..n over the inherited
    // order — it is not a claim that the values ascend.
    expect(got.rows.map((r) => r.rank)).toEqual([1, 2, 3]);
  });

  it('searches INSIDE the cohort, never across axes', () => {
    const s = snap([
      row('in', 1, ['carbonated'], '可乐 330ml'),
      row('out', 2, ['dairy'], '可乐味牛奶'),
    ]);

    const got = deriveRows(s, 'carbonated', '可乐');

    expect(got.rows.map((r) => r.id)).toEqual(['in']);
  });

  it('folds ASCII case but not Unicode', () => {
    const s = snap([
      row('a', 1, ['carbonated'], 'Coca Cola'),
      row('b', 2, ['carbonated'], 'COCA COLA'),
      row('c', 3, ['carbonated'], 'CAFÉ latte'),
      row('d', 4, ['carbonated'], 'Café latte'),
    ]);

    expect(deriveRows(s, 'carbonated', 'cola').rows.map((r) => r.id)).toEqual(['a', 'b']);
    // `'CAFÉ'.toLowerCase() === 'café'` — a Unicode-folding matcher would return
    // both. The retired server matcher (SQLite LIKE) folded ASCII only.
    expect(deriveRows(s, 'carbonated', 'café').rows.map((r) => r.id)).toEqual(['d']);
  });

  it('a query shorter than two code points matches nothing, not everything', () => {
    const s = snap([
      row('a', 1, ['carbonated'], '水'),
      row('b', 2, ['carbonated'], '茶'),
      row('c', 3, ['carbonated'], '气泡水水润装'),
    ]);

    // A single CJK character matches most of the catalogue; the retired server
    // rejected it with a 400 for that reason. The board is titled 「搜索:水」
    // regardless, so returning the whole cohort would claim every row matched —
    // asserting the cohort size here is what let that ship (it is also the
    // unfiltered length, so the assertion could not tell the two apart).
    expect(deriveRows(s, 'carbonated', '水').rows).toEqual([]);
    // …while a word that CLEARS the gate still matches. Row `c` exists purely so
    // this line has a positive result to assert: with only non-matching fixtures
    // an empty array is what a correct filter AND a blanket "reject every
    // 2-codepoint query" both return, so it would discriminate nothing.
    expect(deriveRows(s, 'carbonated', '水水').rows.map((r) => r.id)).toEqual(['c']);
    expect(deriveRows(s, 'carbonated', undefined).rows).toHaveLength(3);
  });

  it('returns the WHOLE cohort, not one page — paging is a separate reveal step', () => {
    // Every other fixture here is 2-4 rows while PAGE_SIZE is 20, so swapping
    // `filtered.length` for `PAGE_SIZE` in the pageOf call left the suite green
    // — and would cap the board at 20 of ~350 rows permanently, with
    // `reachedEnd` lying at row 20. `deriveRows` returns the full view; the
    // hook's `visible` counter is what slices it.
    const many = Array.from({ length: 25 }, (_, i) => row(`r${i}`, i + 1, ['carbonated']));
    const s = snap(many);

    // The fixture only discriminates while it outgrows the limit it is aimed
    // at. Raising PAGE_SIZE past 25 would silently return this case to the
    // green-on-mutation state it was written to end.
    expect(many.length).toBeGreaterThan(PAGE_SIZE);

    const got = deriveRows(s, 'carbonated', undefined);

    expect(got.rows).toHaveLength(25);
    expect(got.rows[24]?.rank).toBe(25);
  });

  it('renumbers ranks per view, so they always start at 1', () => {
    const s = snap([
      row('a', 1, ['carbonated'], 'x'),
      row('b', 2, ['carbonated'], '可乐'),
      row('c', 3, ['carbonated'], '可乐 大瓶'),
    ]);

    const got = deriveRows(s, 'carbonated', '可乐');

    expect(got.rows.map((r) => r.rank)).toEqual([1, 2]);
  });
});

// The SWR half. Every case here names the mutation it kills, because the
// reason this block was missing is that each of these could be deleted
// outright with the suite still green.
function effects(fetch: () => Promise<RankingsSnapshot>) {
  const seen = {
    snapshot: [] as RankingsSnapshot[],
    phase: [] as RankingsPhase[],
    visible: [] as number[],
    written: [] as RankingsSnapshot[],
    fetches: 0,
  };
  const fx: LoadEffects = {
    fetch: () => {
      seen.fetches += 1;
      return fetch();
    },
    inFlight: { current: false },
    setSnapshot: (s) => seen.snapshot.push(s),
    setPhase: (p) => seen.phase.push(p),
    setVisible: (n) => seen.visible.push(n),
    write: (s) => seen.written.push(s),
  };
  return { fx, seen };
}

const OK = snap([row('a', 1, ['carbonated'])]);
const OPTS = { keepOnFailure: false, resetVisible: true };

describe('runLoad — the SWR rules', () => {
  it('writes the fetched snapshot to the cache', async () => {
    // Kills: deleting the `write` call. That mutation passed 97/97 — the whole
    // cache-write side of SWR could vanish and only a cold second launch,
    // on a real device, would show it.
    const { fx, seen } = effects(async () => OK);

    await runLoad(OPTS, fx);

    expect(seen.written).toEqual([OK]);
    expect(seen.phase).toEqual(['ready']);
  });

  it('never caches a load that failed', async () => {
    // Kills: hoisting `write` above the await, or into `finally`.
    const { fx, seen } = effects(async () => {
      throw new Error('offline');
    });

    await runLoad(OPTS, fx);

    expect(seen.written).toEqual([]);
    expect(seen.snapshot).toEqual([]);
  });

  it('keeps the screen on failure only when asked to', async () => {
    // Kills: swapping `keepOnFailure`. Inverted, a background revalidate
    // failure blanks a list the user is reading.
    const fail = async (): Promise<RankingsSnapshot> => {
      throw new Error('offline');
    };
    const cold = effects(fail);
    const background = effects(fail);

    await runLoad({ keepOnFailure: false, resetVisible: true }, cold.fx);
    await runLoad({ keepOnFailure: true, resetVisible: false }, background.fx);

    expect(cold.seen.phase).toEqual(['error']);
    expect(background.seen.phase).toEqual([]);
  });

  it('resets the reveal only when asked to', async () => {
    // Kills: swapping `resetVisible`. Inverted, the background revalidate
    // snaps a scrolled list back to the first slice under the user's finger.
    const resetting = effects(async () => OK);
    const keeping = effects(async () => OK);

    await runLoad({ keepOnFailure: false, resetVisible: true }, resetting.fx);
    await runLoad({ keepOnFailure: true, resetVisible: false }, keeping.fx);

    expect(resetting.seen.visible).toEqual([PAGE_SIZE]);
    expect(keeping.seen.visible).toEqual([]);
  });

  it('does not start a second load while one is in flight', async () => {
    // Kills: deleting the in-flight guard — mount and pull-to-refresh race.
    const { fx, seen } = effects(async () => OK);
    fx.inFlight.current = true;

    await runLoad(OPTS, fx);

    expect(seen.fetches).toBe(0);
  });

  it('clears the in-flight guard even when the load throws', async () => {
    // Kills: dropping the `finally`. A single offline load would otherwise
    // wedge the screen — retry and pull-to-refresh both return immediately,
    // forever.
    const { fx } = effects(async () => {
      throw new Error('offline');
    });

    await runLoad(OPTS, fx);

    expect(fx.inFlight.current).toBe(false);
  });
});

describe('revealOf — how much of the board is on screen', () => {
  const rows = deriveRows(
    snap(Array.from({ length: 25 }, (_, i) => row(`r${i}`, i + 1, ['carbonated']))),
    'carbonated',
    undefined,
  ).rows;

  it('shows exactly the revealed prefix, not a constant slice', () => {
    // Kills: `rows.slice(0, PAGE_SIZE)`. That is §6.25③ moved one layer up —
    // the board caps at 20 of ~350 rows and nothing says so.
    expect(rows.length).toBeGreaterThan(PAGE_SIZE);

    expect(revealOf(rows, PAGE_SIZE).items).toHaveLength(PAGE_SIZE);
    expect(revealOf(rows, PAGE_SIZE * 2).items).toHaveLength(25);
  });

  it('only claims the end once every row is revealed', () => {
    // Kills: `visible > rows.length`, which never reports the end on an exact
    // fit, and `visible < rows.length`, which reports it immediately.
    expect(revealOf(rows, PAGE_SIZE).reachedEnd).toBe(false);
    expect(revealOf(rows, 25).reachedEnd).toBe(true);
    expect(revealOf([], PAGE_SIZE).reachedEnd).toBe(true);
  });
});

describe('firstLoadPlan — cache hit vs cold screen', () => {
  it('renders a cache hit immediately and revalidates without resetting', () => {
    expect(firstLoadPlan(OK)).toEqual({
      phase: 'ready',
      render: OK,
      load: { keepOnFailure: true, resetVisible: false },
    });
  });

  it('treats an EMPTY cached snapshot as a hit, not a whole-screen error', () => {
    // Kills: gating the hit on row count. An empty board is a legal state
    // (unseeded taxonomy) and must read as an empty list, not as a failure.
    const empty = snap([]);

    expect(firstLoadPlan(empty).phase).toBe('ready');
    expect(firstLoadPlan(empty).render).toEqual(empty);
  });

  it('shows the loading screen on a cache miss and resets the reveal', () => {
    expect(firstLoadPlan(null)).toEqual({
      phase: 'loading',
      render: null,
      load: { keepOnFailure: false, resetVisible: true },
    });
  });
});
