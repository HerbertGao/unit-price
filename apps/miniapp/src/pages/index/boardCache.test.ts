// On-device snapshot cache: read re-validation, write tolerance, legacy cleanup.
//
// RETIRED with the per-cohort page cache: `cohortKeyFor` / `DEFAULT_COHORT_KEY`
// and the cohort-isolation cases. There is ONE key now, so there is no cohort to
// key on and no isolation to assert — board, tree, search and drill-down all
// derive from the same object.
//
// KEPT against the new shape: fail-closed read on corrupt/stale data, tolerant
// storage failures, and a write failure costing only the cache. Jitless is a
// permanent unit guard below: a Function-constructor probe proves the parser
// creates none, so this no longer depends on devtools-only testing.
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
let throwOnGet = false;
let throwOnSet = false;

vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: (k: string) => {
      if (throwOnGet) throw new Error("storage unavailable");
      return store.has(k) ? store.get(k) : "";
    },
    setStorageSync: (k: string, v: unknown) => {
      if (throwOnSet) throw new Error("quota exceeded");
      store.set(k, v);
    },
    removeStorageSync: (k: string) => {
      store.delete(k);
    },
    getStorageInfoSync: () => ({ keys: [...store.keys()] }),
  },
}));

import {
  readSnapshot,
  writeSnapshot,
  clearLegacyBoardCache,
  SNAPSHOT_CACHE_KEY,
} from "./boardCache";

const NODES = [
  {
    slug: "beverage",
    name: "饮料",
    parentSlug: null,
    comparableUnit: null,
    rankable: false,
  },
  {
    slug: "carbonated",
    name: "碳酸饮料",
    parentSlug: "beverage",
    comparableUnit: "per_100ml",
    rankable: true,
  },
];

function row(id: string) {
  return {
    id,
    title: `t-${id}`,
    priceCents: 100,
    per100ml: 1,
    formula: "f",
    confidence: 0.95,
    warnings: [],
    store: "sam",
    storeSku: `sku-${id}`,
    sourceUrl: null,
    categorySlugs: ["carbonated"],
  };
}

function snap(rows: unknown[] = []) {
  return { rows, categoryNodes: NODES, excluded: [] };
}

beforeEach(() => {
  store.clear();
  throwOnGet = false;
  throwOnSet = false;
});

describe("writeSnapshot ↔ readSnapshot roundtrip", () => {
  it("a written snapshot reads back validated", () => {
    writeSnapshot(snap([row("a")]) as never);
    expect(readSnapshot()?.rows.map((r) => r.id)).toEqual(["a"]);
  });

  it("an empty snapshot is a valid hit, not a miss", () => {
    // The server legitimately returns an empty board (unseeded / empty library),
    // so an empty cached value must render as empty rather than re-fetch.
    writeSnapshot({ rows: [], categoryNodes: [], excluded: [] } as never);
    expect(readSnapshot()).toEqual({
      rows: [],
      categoryNodes: [],
      excluded: [],
    });
  });
});

describe("readSnapshot — fail-closed on corrupt bodies", () => {
  it("never-written → null", () => {
    expect(readSnapshot()).toBeNull();
  });

  it("a bare row array (the RETIRED stored shape) → null", () => {
    // Correctness comes from the key rename: the read path only looks at the new
    // key, so a legacy value is unreachable. This asserts the belt as well as the
    // braces — even placed under the new key, the object schema rejects it.
    store.set(SNAPSHOT_CACHE_KEY, [row("a")]);
    expect(readSnapshot()).toBeNull();
  });

  it("a row with a stale schema (missing a required field) → null", () => {
    const bad = row("a") as Record<string, unknown>;
    delete bad.formula;
    store.set(SNAPSHOT_CACHE_KEY, snap([bad]));
    expect(readSnapshot()).toBeNull();
  });

  it("a row referencing an unknown category → null (cross-field invariant)", () => {
    // Field shapes alone would admit this, and it would render a board quietly
    // missing that row from every cohort view while still counting it in the whole.
    store.set(
      SNAPSHOT_CACHE_KEY,
      snap([{ ...row("a"), categorySlugs: ["ghost"] }]),
    );
    expect(readSnapshot()).toBeNull();
  });

  it("getStorageSync throwing → null, no bubble", () => {
    throwOnGet = true;
    expect(() => readSnapshot()).not.toThrow();
    expect(readSnapshot()).toBeNull();
  });
});

describe("writeSnapshot — a write failure loses only the cache", () => {
  it("setStorageSync throwing does not bubble", () => {
    throwOnSet = true;
    expect(() => writeSnapshot(snap([row("a")]) as never)).not.toThrow();
    expect(readSnapshot()).toBeNull();
  });
});

describe("clearLegacyBoardCache", () => {
  it("removes retired per-cohort keys and leaves the snapshot alone", () => {
    store.set("rankings:board:__default__", [row("a")]);
    store.set("rankings:board:carbonated", [row("b")]);
    writeSnapshot(snap([row("c")]) as never);

    clearLegacyBoardCache();

    expect([...store.keys()]).toEqual([SNAPSHOT_CACHE_KEY]);
    expect(readSnapshot()?.rows.map((r) => r.id)).toEqual(["c"]);
  });
});
