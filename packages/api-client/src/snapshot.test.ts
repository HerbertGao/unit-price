// Snapshot contract + view derivation.
//
// The adversarial cases here are the ones that separate a correct
// implementation from a plausible one: `café`/`CAFÉ` fails any `toLowerCase()`
// matcher, a row attached to a non-leaf node must still surface, and the two
// cohort rejections must stay distinguishable (the server distinguishes them,
// so collapsing them here breaks parity with its messages).
import { describe, expect, it } from "vitest";
import {
  RankingsSnapshotSchema,
  cohortSlugs,
  matchesQuery,
  normalizeQuery,
  pageOf,
  parseRankingsSnapshot,
  rowsInCohort,
  SEARCH_MAX_CODEPOINTS,
  type RankingsSnapshot,
  type SnapshotCategoryNode,
  type SnapshotRow,
} from "./snapshot.js";

const NODES: SnapshotCategoryNode[] = [
  {
    slug: "beverage",
    name: "饮料",
    parentSlug: null,
    comparableUnit: null,
    rankable: false,
  },
  {
    slug: "dairy",
    name: "乳品",
    parentSlug: "beverage",
    comparableUnit: "per_100ml",
    rankable: true,
  },
  {
    slug: "milk",
    name: "牛奶",
    parentSlug: "dairy",
    comparableUnit: "per_100ml",
    rankable: true,
  },
  {
    slug: "yogurt",
    name: "酸奶",
    parentSlug: "dairy",
    comparableUnit: "per_100ml",
    rankable: true,
  },
];

function row(
  id: string,
  per100ml: number,
  categorySlugs: string[],
  title = `t-${id}`,
): SnapshotRow {
  return {
    id,
    title,
    priceCents: 100,
    per100ml,
    formula: "f",
    confidence: 0.95,
    warnings: [],
    store: "sam",
    storeSku: `sku-${id}`,
    sourceUrl: null,
    categorySlugs,
  };
}

function snap(rows: SnapshotRow[], nodes = NODES): RankingsSnapshot {
  return parseRankingsSnapshot({ rows, categoryNodes: nodes, excluded: [] });
}

describe("parseRankingsSnapshot — object-level invariants", () => {
  it("accepts a well-formed snapshot and an empty one", () => {
    expect(snap([row("a", 1, ["milk"])]).rows).toHaveLength(1);
    // Un-seeded taxonomy is a legal degraded state, not corruption.
    expect(snap([], []).categoryNodes).toEqual([]);
  });

  it("rejects a row referencing an unknown category", () => {
    // Such a row would vanish from every cohort view while still being part of
    // the whole — a silent hole, which is why this fails closed.
    expect(() => snap([row("a", 1, ["ghost"])])).toThrow(/unknown category/);
  });

  it("rejects duplicate node slugs and a dangling parentSlug", () => {
    expect(() =>
      snap([], [...NODES, NODES[2] as (typeof NODES)[number]]),
    ).toThrow(/duplicate/);
    expect(() =>
      snap(
        [],
        [
          {
            slug: "x",
            name: "X",
            parentSlug: "nope",
            comparableUnit: null,
            rankable: false,
          },
        ],
      ),
    ).toThrow(/has no node/);
  });

  it("rejects a parent cycle rather than hanging on ancestor resolution", () => {
    expect(() =>
      snap(
        [],
        [
          {
            slug: "a",
            name: "A",
            parentSlug: "b",
            comparableUnit: null,
            rankable: false,
          },
          {
            slug: "b",
            name: "B",
            parentSlug: "a",
            comparableUnit: null,
            rankable: false,
          },
        ],
      ),
    ).toThrow(/cycle/);
  });
});

describe("cohort derivation", () => {
  it("includes every descendant, not just direct children", () => {
    expect([...cohortSlugs(NODES, "beverage")].sort()).toEqual([
      "beverage",
      "dairy",
      "milk",
      "yogurt",
    ]);
    expect([...cohortSlugs(NODES, "milk")]).toEqual(["milk"]);
  });

  it("surfaces a row attached to a NON-LEAF node under that node and its ancestors", () => {
    // `dairy` has children, so this attachment is non-leaf — the state taxonomy
    // growth produces. The row is a live catalogue entry and must not vanish.
    const s = snap([row("nonleaf", 1, ["dairy"]), row("leaf", 2, ["milk"])]);

    const atDairy = rowsInCohort(s, "dairy");
    expect(atDairy.ok && atDairy.rows.map((r) => r.id)).toEqual([
      "nonleaf",
      "leaf",
    ]);

    // …but it is NOT a member of its sibling leaf.
    const atYogurt = rowsInCohort(s, "yogurt");
    expect(atYogurt.ok && atYogurt.rows).toEqual([]);
  });

  it("keeps the two rejections distinguishable", () => {
    const s = snap([row("a", 1, ["milk"])]);

    const cross = rowsInCohort(s, "beverage");
    expect(cross.ok).toBe(false);
    expect(!cross.ok && cross.reason.kind).toBe("cross-cohort");

    const unknown = rowsInCohort(s, "ghost");
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.reason.kind).toBe("unknown-category");
  });

  it("preserves the server order through filtering — no client-side sort", () => {
    // Fed DELIBERATELY out of ascending order. The server is the authority on
    // order and the client inherits whatever arrives — so the fixture must be an
    // order a sorting client would change. An already-ascending fixture makes
    // "preserved" and "re-sorted ascending" the same observable, which is how a
    // banned client-side sort would ship green. (The schema does not validate row
    // order — see the contract — so a non-monotonic snapshot parses fine.)
    const s = snap([
      row("c", 9, ["milk"]),
      row("a", 1, ["milk"]),
      row("b", 5, ["milk"]),
    ]);
    const got = rowsInCohort(s, "milk");
    expect(got.ok && got.rows.map((r) => r.per100ml)).toEqual([9, 1, 5]);
    expect(got.ok && got.rows.map((r) => r.id)).toEqual(["c", "a", "b"]);
  });
});

describe("search", () => {
  it.each([
    // `_` is the one that actually bites: a matcher treating it as LIKE's
    // single-char wildcard would match `acb`, and testing only `%` cannot see it.
    ["a_b", "acb", false],
    ["a_b", "xa_by", true],
    ["50%", "50% off", true],
    ["50%", "5099 off", false],
    ["a!b", "a!b c", true],
    ["a!b", "ab c", false],
  ])("treats %s literally against %s -> %s", (q, title, hit) => {
    expect(matchesQuery(title, normalizeQuery(q) as string)).toBe(hit);
  });

  it("folds ASCII case", () => {
    const q = normalizeQuery("cola") as string;
    expect(matchesQuery("Coca Cola", q)).toBe(true);
    expect(matchesQuery("COCA COLA", q)).toBe(true);
  });

  it("does NOT fold non-ASCII — the case that breaks toLowerCase()", () => {
    const q = normalizeQuery("café") as string;
    expect(matchesQuery("Café 拿铁", q)).toBe(true);
    // `'CAFÉ'.toLowerCase() === 'café'`, so a Unicode-folding matcher matches
    // here. SQLite `LIKE` did not, and this preserves that.
    expect(matchesQuery("CAFÉ 拿铁", q)).toBe(false);
  });

  it("treats %, _ and ! as ordinary characters", () => {
    const q = normalizeQuery("100%纯") as string;
    expect(matchesQuery("果汁 100%纯", q)).toBe(true);
    expect(matchesQuery("果汁 100X纯", q)).toBe(false);
  });

  it("rejects a query shorter than two code points", () => {
    // A single CJK character matches most of the catalogue.
    expect(normalizeQuery("水")).toBeNull();
    expect(normalizeQuery("  ")).toBeNull();
    expect(normalizeQuery("可乐")).toBe("可乐");
  });

  it("truncates by code point, not UTF-16 length", () => {
    const astral = "𝔘".repeat(80); // each is 2 UTF-16 units
    const got = normalizeQuery(astral) as string;
    expect([...got]).toHaveLength(SEARCH_MAX_CODEPOINTS);
  });
});

describe("pageOf", () => {
  const rows = [
    row("a", 1, ["milk"]),
    row("b", 2, ["milk"]),
    row("c", 3, ["milk"]),
  ];

  it("assigns 1-based ranks continuing across pages", () => {
    expect(pageOf(rows, 0, 2).map((r) => r.rank)).toEqual([1, 2]);
    expect(pageOf(rows, 2, 2).map((r) => r.rank)).toEqual([3]);
    expect(pageOf(rows, 9, 2)).toEqual([]);
  });

  it("rejects an out-of-domain offset or limit", () => {
    // A negative offset would slice from the tail and emit rank 0.
    expect(() => pageOf(rows, -1, 2)).toThrow(RangeError);
    expect(() => pageOf(rows, 1.5, 2)).toThrow(RangeError);
    expect(() => pageOf(rows, 0, 0)).toThrow(RangeError);
    expect(() => pageOf(rows, 0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("parseRankingsSnapshot — jitless", () => {
  // WeChat's runtime bans `eval` / `new Function`. Zod compiles a JIT validator
  // by default, so a snapshot parse that forgets `{ jitless: true }` throws
  // inside the mini-program — and the symptom is a bogus network timeout, not a
  // syntax error. This project has already lost a session to that exact trail.
  //
  // The check is a Function-constructor spy, not a devtools run: it is the one
  // property that distinguishes the two paths and it is observable in node.
  // `superRefine` was added to this schema after that incident, which changes
  // the parse path — so the guard has to live where it re-runs on every change.
  function countFunctionConstructions(run: () => void): number {
    const real = globalThis.Function;
    let n = 0;
    const spy = new Proxy(real, {
      construct(t, a, nt) {
        n += 1;
        return Reflect.construct(t, a, nt);
      },
      apply(t, thisArg, a) {
        n += 1;
        return Reflect.apply(t, thisArg, a);
      },
    });
    globalThis.Function = spy as FunctionConstructor;
    try {
      run();
    } finally {
      globalThis.Function = real;
    }
    return n;
  }

  const valid = {
    rows: [row("a", 1, ["milk"])],
    categoryNodes: NODES,
    excluded: [],
  };

  it("builds no Function at parse time, while the JIT path does", () => {
    const jitless = countFunctionConstructions(() => {
      parseRankingsSnapshot(structuredClone(valid));
    });
    const jit = countFunctionConstructions(() => {
      RankingsSnapshotSchema.parse(structuredClone(valid));
    });

    expect(jitless).toBe(0);
    // Pins the contrast: if Zod ever stopped compiling here, `jitless === 0`
    // alone would pass while proving nothing.
    expect(jit).toBeGreaterThan(0);
  });
});

describe("excluded[].reason stays open", () => {
  // The health signal must not be able to reject the payload it describes. An
  // earlier revision validated `reason` against a closed enum; adding a reason
  // on the producer side then 500'd the whole snapshot — board, category tree,
  // search and compare-positioning at once. Without this case, re-narrowing the
  // schema passes every test and re-lands that outage.
  it("accepts a reason literal invented after this schema was written", () => {
    expect(() =>
      parseRankingsSnapshot({
        rows: [],
        categoryNodes: [],
        excluded: [{ reason: "a-reason-invented-tomorrow", count: 1 }],
      }),
    ).not.toThrow();
  });

  it("still rejects a malformed reason or count", () => {
    const bad = (excluded: unknown) =>
      parseRankingsSnapshot({ rows: [], categoryNodes: [], excluded });
    expect(() => bad([{ reason: "", count: 1 }])).toThrow();
    expect(() => bad([{ reason: "x", count: 0 }])).toThrow();
  });
});
