import { describe, expect, it, vi } from 'vitest';
import type { RawProduct } from '@unit-price/core';
import type {
  BoardSnapshotCategoryNode,
  BoardSnapshotRow,
  CategoryTreeNode,
  RankingRow,
  Repository,
} from '@unit-price/db';
import { createApp } from './routes.js';
import { buildApp } from './index.js';
import { createNoopGovernance, createRealGovernance } from './governance.js';
import type { Bindings } from './bindings.js';
import type { ParseOptions, ParseResult, SpecParserLLM } from './llm.js';

// A port that must never be called (clean titles must skip tier2). Calling it
// throws so any accidental invocation fails the test loudly.
const throwingPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    throw new Error('LLM must not be called for tier1-sufficient inputs');
  },
};

/** A port that always reports a transport failure. */
const transportFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'transport', message: 'simulated timeout' };
  },
};

/** A port that reports a (runtime) config error. */
const configFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'config', message: 'missing OPENROUTER_API_KEY' };
  },
};

/** A port that fills a given partial spec (used to test gap-filling). */
function fillingPort(fill: Partial<RawProduct> & Record<string, unknown>): SpecParserLLM {
  return {
    async parse(_input: RawProduct, _opts?: ParseOptions): Promise<ParseResult> {
      return {
        ok: true,
        spec: {
          unitSize: null,
          quantity: null,
          multipliers: [1],
          totalAmount: null,
          packageUnit: null,
          category: 'beverage',
          confidence: 0.7,
          ...(fill as object),
        },
      };
    },
  };
}

async function post(port: SpecParserLLM, body: unknown) {
  // makeLlm ignores env here: each test injects a fixed port. Env-keyed
  // construction is covered by the dedicated "env injection" suite below.
  const app = createApp({ makeLlm: () => port, governance: createNoopGovernance() });
  const res = await app.request('/parse', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

describe('POST /parse — clean title (tier1, no LLM)', () => {
  it('returns 200, per100ml ~= 0.505, expanded formula, confidence >= 0.9', async () => {
    const { res, json } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
    expect(json.unitPrice.formula).toBe('40 / (330 * 24 * 1) * 100');
    expect(json.confidence).toBeGreaterThanOrEqual(0.9);
    expect(json.spec.totalAmount).toEqual({ value: 7920, unit: 'ml' });
    expect(json.spec.category).toBe('beverage');
  });

  it('does not fail without a key because the LLM is never called', async () => {
    // throwingPort stands in for an unavailable LLM; a 200 proves tier2 was skipped.
    const { res } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 40 });
    expect(res.status).toBe(200);
  });
});

describe('POST /parse — orphan single-unit volume (tier1 infers qty=1)', () => {
  it('4L single bottle: 200, per100ml ~= 0.2475, confidence >= 0.9, surfaces inference warning', async () => {
    // "4L" is a bare volume with no quantity signal. tier1 infers quantity=1
    // and emits an informational warning; the case is clean/determinate so
    // tier2 (throwingPort) is never reached (no OPENROUTER_API_KEY needed).
    const { res, json } = await post(throwingPort, { title: 'MM 弱碱性饮用水 4L', price: 9.9 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).not.toBeNull();
    expect(json.unitPrice.per100ml).toBeCloseTo(0.2475, 4);
    expect(json.confidence).toBeGreaterThanOrEqual(0.9);
    // tier1's single-unit inference warning must reach the API response.
    expect(json.warnings).toContain('数量按单件推断为 1');
  });
});

describe('POST /parse — invalid request -> 4xx', () => {
  it('missing price -> 400', async () => {
    const { res, json } = await post(throwingPort, { title: '可口可乐 330ml*24听' });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
  });

  it('non-numeric price -> 400', async () => {
    const { res } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 'abc' });
    expect(res.status).toBe(400);
  });

  it('empty title -> 400', async () => {
    const { res } = await post(throwingPort, { title: '', price: 40 });
    expect(res.status).toBe(400);
  });

  it('missing title -> 400', async () => {
    const { res } = await post(throwingPort, { price: 40 });
    expect(res.status).toBe(400);
  });

  it('non-JSON body -> 400', async () => {
    const { res } = await post(throwingPort, 'not json');
    expect(res.status).toBe(400);
  });

  it('Infinity price -> 400 (non-finite rejected like NaN)', async () => {
    // JSON literal 1e999 parses to Infinity; a non-finite price is an invalid
    // request, not a 200+null result.
    const { res, json } = await post(throwingPort, '{"title":"可口可乐 330ml*24听","price":1e999}');
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
  });
});

describe('POST /parse — price <= 0 -> 200 + null + warning', () => {
  it('price 0 on a clean title returns 200, per100ml null, warning', async () => {
    const { res, json } = await post(throwingPort, { title: '可口可乐 330ml*24听', price: 0 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.formula).toBeNull();
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.confidence).toBeLessThanOrEqual(0.5);
  });

  it('price 0 with a fully-extracted tier1 spec skips tier2 even without a key', async () => {
    // tier1 extracts a full spec (330ml*24 -> 7920ml) but price<=0 is a CERTAIN
    // null the LLM cannot change. A config/transport-failing port must NOT be
    // reached: HTTP 200, per100ml null, the price warning present, and NO
    // "未经 LLM 复核" warning (tier2 was never called).
    const { res, json } = await post(configFailPort, { title: '可口可乐 330ml*24听', price: 0 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.spec.totalAmount).toEqual({ value: 7920, unit: 'ml' });
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.warnings.some((w: string) => /价格/.test(w))).toBe(true);
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('quantity 0 (derived totalMl<=0) is determinate null and skips tier2', async () => {
    // Title "可乐 330ml*0" -> tier1 unitSize 330ml + quantity 0 -> derived
    // totalMl = 0 (<=0). The LLM cannot change tier1's extracted quantity, so
    // this is a CERTAIN null -> 200; a transport-failing port must NOT be
    // reached (no "未经 LLM 复核" warning).
    const { res, json } = await post(transportFailPort, { title: '可乐 330ml*0', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('weight unitSize (2kg) computes per100g on the weight axis and skips tier2', async () => {
    // tier1 extracts a clean weight single unit (2kg, qty inferred = 1). This is
    // a DETERMINATE weight-axis verdict — per100g = 40/2000*100 = 2.0, per100ml
    // null — so tier2 (a failing port) must not be reached, and no "未经 LLM 复核"
    // warning is attached. The single-unit inference warning is surfaced.
    const { res, json } = await post(transportFailPort, { title: '鸡胸肉 2kg', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.per100g).toBeCloseTo(2.0, 6);
    expect(json.unitPrice.formula).not.toBeNull();
    expect(json.warnings.length).toBeGreaterThan(0);
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });
});

describe('POST /parse — tier2 transport failure', () => {
  it('no spec shape at all -> 5xx insufficient (price>0)', async () => {
    const { res, json } = await post(transportFailPort, { title: '农夫山泉', price: 5 });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(json.error).toBe('insufficient-information');
    expect(json.confidence).toBeUndefined();
  });

  it('bare single-unit volume (6000ml, no qty) -> qty=1 inferred, determinate, skips tier2', async () => {
    // tier1 puts "6000ml" into unitSize with NO quantity signal, so the
    // single-unit inference sets quantity=1 -> compute-required set met ->
    // a determinate (computable) verdict, hence 200. tier2 is skipped (a
    // transport-failing port must NOT be reached -> no "未经 LLM 复核"
    // warning), and the inference warning is surfaced. per100ml = 36/6000*100.
    const { res, json } = await post(transportFailPort, { title: '某饮料 6000ml', price: 36 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.6, 3);
    expect(json.spec.quantity).toBe(1);
    expect(json.warnings).toContain('数量按单件推断为 1');
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('weight unitSize (2kg) is a determinate weight-axis verdict -> 200 + per100g, not 5xx', async () => {
    // tier1 has a weight shape, so even with tier2 transport-failing the verdict
    // is determinate (per100g = 30/2000*100 = 1.5) -> 200, never 5xx.
    const { res, json } = await post(transportFailPort, { title: '大米 2kg', price: 30 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.per100g).toBeCloseTo(1.5, 6);
  });

  it('weight unitSize (2kg, price 45) -> 200, per100g = 2.25, per100ml null (spec scenario)', async () => {
    // parse-api spec scenario: tier1 extracts unitSize=2kg (single unit, qty=1,
    // totalAmount=2kg). Weight axis computes per100g = 45/2000*100 = 2.25; the
    // volume axis is null. Determinate at tier1 -> tier2 skipped.
    const { res, json } = await post(transportFailPort, { title: '水蜜黄桃 2kg', price: 45 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100g).toBeCloseTo(2.25, 6);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.formula).not.toBeNull();
    expect(json.warnings).not.toContain('未经 LLM 复核');
  });

  it('egg 1.59kg(30枚): free piece-count suppresses inference -> 200, both axes null, not 5xx', async () => {
    // parse-api spec scenario: tier1 extracts unitSize=1.59kg but the free piece
    // count "30" (枚 ∉ package-unit set) suppresses the single-unit inference, so
    // quantity stays null and no total is derivable -> a CERTAIN null on BOTH
    // axes. tier1 has a weight shape -> determinate -> 200 (not 5xx), even with
    // tier2 transport-failing.
    const { res, json } = await post(transportFailPort, {
      title: 'MM 精选鲜鸡蛋 1.59kg(30枚)',
      price: 30,
    });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
    expect(json.unitPrice.per100g).toBeNull();
    expect(json.unitPrice.formula).toBeNull();
    expect(json.warnings.length).toBeGreaterThan(0);
  });
});

describe('POST /parse — runtime config error -> distinguishable 5xx', () => {
  it('returns 500 with config-error code (distinct from insufficient)', async () => {
    const { res, json } = await post(configFailPort, { title: '农夫山泉', price: 5 });
    expect(res.status).toBe(500);
    expect(json.error).toBe('config-error');
  });
});

describe('POST /parse — tier2 gap fill + merge semantics', () => {
  it('tier1 has unitSize, LLM fills quantity; merged -> full-spec high band', async () => {
    // Title "可乐2代 330ml" -> tier1 extracts unitSize 330ml; the stray digit
    // "2" suppresses the single-unit inference (a quantity signal is present),
    // so quantity stays null and tier2 is invoked. LLM supplies quantity=24.
    // tier1 unitSize is authoritative; LLM's unitSize is ignored.
    const port = fillingPort({
      unitSize: { value: 999, unit: 'ml' }, // must be IGNORED (tier1 authoritative)
      quantity: 24,
    });
    const { res, json } = await post(port, { title: '可乐2代 330ml', price: 40 });
    expect(res.status).toBe(200);
    // tier1 unitSize 330 wins over LLM's 999 -> per100ml uses 330*24.
    expect(json.spec.unitSize).toEqual({ value: 330, unit: 'ml' });
    expect(json.spec.quantity).toBe(24);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
    expect(json.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('tier2 success but fields still empty -> 200 (determined uncomputable)', async () => {
    const port = fillingPort({}); // all-empty valid spec
    const { res, json } = await post(port, { title: '农夫山泉', price: 5 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeNull();
  });
});

describe('POST /parse — env injected per request (no isolate cross-request bleed)', () => {
  // buildApp injects REAL governance, so these env-injection cases (which probe
  // the parse-api tier behavior, not governance) must clear the auth gate: a
  // valid API_KEYS allowlist + matching Bearer key admits the request, leaving
  // OPENROUTER_API_KEY absent so the tier1/tier2 assertions stand unchanged.
  const ADMIT_KEY = 'env-suite-key';

  /** POST a body to an app, injecting `env` as the request-scoped Bindings. */
  async function postEnv(app: ReturnType<typeof buildApp>, env: Bindings, body: unknown) {
    const res = await app.request(
      '/parse',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIT_KEY}` },
        body: JSON.stringify(body),
      },
      { API_KEYS: ADMIT_KEY, ...env },
    );
    let json: any = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { res, json };
  }

  it('missing key + clean title -> 200 (tier1 only, tier2 never reached)', async () => {
    // buildApp resolves LLM config from the INJECTED env; with no key a clean
    // title must still parse via tier1 (tier2 skipped) -> 200.
    const app = buildApp();
    const { res, json } = await postEnv(app, {}, { title: '可口可乐 330ml*24听', price: 40 });
    expect(res.status).toBe(200);
    expect(json.unitPrice.per100ml).toBeCloseTo(0.505, 3);
  });

  it('missing key + dirty title needing tier2 -> 500 config-error (not 503)', async () => {
    // A bare brand name has tier1 shape but needs tier2 to fill the spec. With
    // no OPENROUTER_API_KEY injected, resolving config throws ConfigError ->
    // orchestrate returns config-error -> HTTP 500 (distinct from 503).
    const app = buildApp();
    const { res, json } = await postEnv(app, {}, { title: '农夫山泉', price: 5 });
    expect(res.status).toBe(500);
    expect(json.error).toBe('config-error');
  });

  it('two requests with different env use their own env (no first-env固化)', async () => {
    // Record the env each makeLlm call receives. The first request injects a
    // key, the second injects none; if env were固化 from the first request the
    // second would wrongly see the first key. We assert each saw its own env.
    const seen: Array<Bindings> = [];
    const app = createApp({
      makeLlm: (env) => {
        seen.push(env);
        return {
          async parse(): Promise<ParseResult> {
            return { ok: false, kind: 'transport', message: 'noop' };
          },
        };
      },
      governance: createNoopGovernance(),
    });

    const dirty = { title: '农夫山泉', price: 5 };
    await app.request(
      '/parse',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dirty) },
      { OPENROUTER_API_KEY: 'key-A' },
    );
    await app.request(
      '/parse',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(dirty) },
      {},
    );

    expect(seen).toHaveLength(2);
    expect(seen[0]?.OPENROUTER_API_KEY).toBe('key-A');
    expect(seen[1]?.OPENROUTER_API_KEY).toBeUndefined();
  });
});

describe('POST /parse — categoryHint passthrough', () => {
  it('passes categoryHint through to spec.category (never from LLM)', async () => {
    const { res, json } = await post(throwingPort, {
      title: '可口可乐 330ml*24听',
      price: 40,
      categoryHint: 'soda',
    });
    expect(res.status).toBe(200);
    expect(json.spec.category).toBe('soda');
  });
});

// ── GET /rankings — full board snapshot (rankings-api spec) ────────────────
//
// The route takes NO query parameters and returns ONE cacheable object:
// { rows, categoryNodes, excluded }. Sorting / cohort filtering / paging /
// search all happen on the client from that object, so the HTTP surface here is
// deliberately small: 200 + the projection + the cache header.
//
// RETIRED with the parameter surface (~20 cases): limit/offset clamping and
// their 400s, `category` validation and the cross-cohort 400, `?q=`
// validation/forwarding and its `no-store` verdict, out-of-range-offset → [],
// and per-node scoping. None of those inputs exist any more; the behaviours
// they protected moved to @unit-price/api-client's derivation and are covered
// by its own tests (cohort filtering, the two rejection kinds, search folding,
// paging domain). Kept below is everything still the SERVER's job: verbatim
// projection, no recompute, warnings passthrough, the read-failure path,
// cacheability and governance exemption.

/** A BoardSnapshotRow fixture (only per100ml-non-null rows ever reach the route). */
function row(
  over: Partial<BoardSnapshotRow> & Pick<BoardSnapshotRow, 'id' | 'per100ml'>,
): BoardSnapshotRow {
  return {
    formula: `cents / (${over.per100ml} * 100) * 100`,
    confidence: 0.95,
    warnings: [],
    title: `item-${over.id}`,
    priceCents: 1000,
    store: 'sam',
    storeSku: `sku-${over.id}`,
    sourceUrl: null,
    capturedAt: 1_700_000_000_000,
    lowestPriceCents: 1000,
    categorySlugs: ['carbonated'],
    ...over,
  };
}

/** Category nodes covering the slugs the fixtures attach to. */
const NODES = [
  { slug: 'beverage', name: '饮料', parentSlug: null, comparableUnit: null, rankable: false },
  {
    slug: 'soft-drink',
    name: '软饮',
    parentSlug: 'beverage',
    comparableUnit: 'per_100ml' as const,
    rankable: true,
  },
  {
    slug: 'carbonated',
    name: '碳酸饮料',
    parentSlug: 'soft-drink',
    comparableUnit: 'per_100ml' as const,
    rankable: true,
  },
  {
    slug: 'juice-plant',
    name: '果汁植物饮',
    parentSlug: 'soft-drink',
    comparableUnit: 'per_100ml' as const,
    rankable: true,
  },
];

/** Ascending by (per100ml, id) — the order the repository emits. */
const SNAPSHOT: BoardSnapshotRow[] = [
  row({ id: 'ml-1', per100ml: 0.505, formula: '40 / (330 * 24 * 1) * 100', warnings: [] }),
  row({ id: 'ml-2a', per100ml: 2.0 }),
  row({ id: 'ml-2b', per100ml: 2.0, categorySlugs: ['juice-plant'] }),
  row({ id: 'ml-3', per100ml: 5.5, warnings: ['数量按单件推断为 1'], priceCents: 990 }),
  row({ id: 'ml-4', per100ml: 889.9, warnings: ['数量按单件推断为 1'] }),
];

/** Build an app whose Repository serves `rows` from listBoardSnapshot. */
function rankingsApp(
  rows: BoardSnapshotRow[],
  opts: {
    throws?: boolean;
    nodes?: typeof NODES;
    excluded?: { reason: string; count: number }[];
  } = {},
) {
  const listBoardSnapshot = vi.fn(async () => {
    if (opts.throws) throw new Error('simulated read failure');
    return {
      rows,
      categoryNodes: opts.nodes ?? NODES,
      excluded: opts.excluded ?? [],
    };
  });
  const repo = {
    async upsertRaw() {
      throw new Error('rankings is read-only: upsertRaw must not be called');
    },
    async saveParsed() {
      throw new Error('rankings is read-only: saveParsed must not be called');
    },
    async getProduct() {
      return null;
    },
    async saveCorrection() {
      throw new Error('rankings is read-only: saveCorrection must not be called');
    },
    listBoardSnapshot,
  } as unknown as Repository;

  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { app, listBoardSnapshot };
}

/** GET /rankings on an app, returning {res, json}. */
async function getRankings(app: ReturnType<typeof createApp>, query = '') {
  const res = await app.request(`/rankings${query}`, { method: 'GET' });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

describe('GET /rankings — full snapshot, verbatim stored values', () => {
  it('returns 200 with rows in the repository order and no rank field', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res, json } = await getRankings(app);

    expect(res.status).toBe(200);
    expect(json.rows.map((r: any) => r.id)).toEqual(['ml-1', 'ml-2a', 'ml-2b', 'ml-3', 'ml-4']);
    // `rank` is a position within a view; the whole set has none. The client
    // assigns it when it slices.
    expect(json.rows[0]).not.toHaveProperty('rank');
  });

  it('projects stored per100ml/formula verbatim (no recompute from priceCents)', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { json } = await getRankings(app);

    expect(json.rows[0].per100ml).toBe(0.505);
    expect(json.rows[0].formula).toBe('40 / (330 * 24 * 1) * 100');
  });

  it('carries capturedAt + lowestPriceCents on every online row', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { json } = await getRankings(app);

    for (const r of json.rows) {
      expect(Number.isInteger(r.capturedAt)).toBe(true);
      expect(Number.isInteger(r.lowestPriceCents)).toBe(true);
    }
  });

  it('carries the single-unit-inference warning rather than dropping the row', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { json } = await getRankings(app);

    const inferred = json.rows.find((r: any) => r.id === 'ml-3');
    expect(inferred.warnings).toEqual(['数量按单件推断为 1']);
  });

  it('carries categorySlugs and the category nodes needed to resolve ancestry', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { json } = await getRankings(app);

    expect(json.rows[0].categorySlugs).toEqual(['carbonated']);
    expect(json.categoryNodes.map((n: any) => n.slug)).toContain('soft-drink');
    // No per-node count: the client holds every row and counts for itself.
    expect(json.categoryNodes[0]).not.toHaveProperty('rankableCount');
  });

  it('surfaces the exclusion counter so a dropped row is visible, not silent', async () => {
    const { app } = rankingsApp(SNAPSHOT, {
      excluded: [{ reason: 'warnings_undecodable', count: 2 }],
    });
    const { json } = await getRankings(app);

    expect(json.excluded).toEqual([{ reason: 'warnings_undecodable', count: 2 }]);
  });

  it('returns 200 with an empty snapshot on an empty library', async () => {
    const { app } = rankingsApp([], { nodes: [] });
    const { res, json } = await getRankings(app);

    expect(res.status).toBe(200);
    expect(json).toEqual({ rows: [], categoryNodes: [], excluded: [] });
  });
});

describe('GET /rankings — query parameters are ignored, not honoured', () => {
  // The endpoint exists to be ONE cache object. A parameter that changed the
  // body would fork it into another CDN key, which is what this reshape set out
  // to stop.
  it.each([
    '?category=juice-plant',
    '?limit=1',
    '?offset=3',
    '?q=可乐',
    '?category=alcohol',
    '?limit=-1&offset=abc',
  ])('%s yields the same 200 body as no query at all', async (query) => {
    const { app } = rankingsApp(SNAPSHOT);
    const bare = await getRankings(app);
    const withQuery = await getRankings(app, query);

    expect(withQuery.res.status).toBe(200);
    expect(withQuery.json).toEqual(bare.json);
  });

  it('no longer rejects a cross-cohort slug — the guard moved to view derivation', async () => {
    // `alcohol` spans several comparable axes, so no single board exists for it.
    // That is a property of DERIVING a view, not of fetching the data: the bytes
    // are identical for every cohort. api-client's rowsInCohort returns a
    // `cross-cohort` rejection for it.
    const { app } = rankingsApp(SNAPSHOT);
    const { res } = await getRankings(app, '?category=alcohol');

    expect(res.status).toBe(200);
  });
});

describe('GET /rankings — read failure -> 500 persistence-error', () => {
  it('listBoardSnapshot throwing maps to 500 persistence-error (no recompute, no retry)', async () => {
    const { app } = rankingsApp(SNAPSHOT, { throws: true });
    const { res, json } = await getRankings(app);

    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
  });

  it('a row referencing a node absent from the same response is a 500, not a silent hole', async () => {
    // Such a row would vanish from every cohort view while still counting toward
    // the whole — the contract validation catches it before send.
    const { app } = rankingsApp([row({ id: 'orphan', per100ml: 1, categorySlugs: ['ghost'] })]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { res, json } = await getRankings(app);

    expect(res.status).toBe(500);
    expect(json.error).toBe('internal');
    expect(error).toHaveBeenCalledWith(
      '[rankings] response validation failed',
      expect.any(Array),
    );
    error.mockRestore();
  });

  it('/compute rejects the SAME torn assembly rather than positioning against it', async () => {
    // The object-level invariant is checked at whole-body validation, which only
    // /rankings used to run. In that state the two endpoints would disagree about
    // reality itself: the board 500s while the compare card confidently ranks the
    // user against a row no board can show. Both must refuse the same input.
    // Built inline, not via `computeApp`: that fixture hard-codes every row into
    // `soft-drink`, so a dangling slug cannot be expressed through it at all.
    const listBoardSnapshot = vi.fn(async () => ({
      rows: [{ ...row({ id: 'orphan', per100ml: 1 }), categorySlugs: ['ghost'] }],
      categoryNodes: [
        {
          slug: 'soft-drink',
          name: '软饮',
          parentSlug: null,
          comparableUnit: 'per_100ml' as const,
          rankable: true,
        },
      ],
      excluded: [],
    }));
    const app = createApp({
      makeLlm: () => ({ async parse() { throw new Error('no llm'); } }) as unknown as SpecParserLLM,
      governance: createNoopGovernance(),
      makeRepo: () => ({ listBoardSnapshot }) as unknown as Repository,
    });

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await app.request('/compute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        totalPrice: 4,
        totalAmount: { value: 100, unit: 'ml' },
        category: 'soft-drink',
      }),
    });

    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toBe('internal');
    expect(error).toHaveBeenCalledWith(
      '[compute] snapshot validation failed',
      expect.any(Array),
    );
    error.mockRestore();
  });
});

describe('GET /rankings — governance-exempt public endpoint', () => {
  it('takes no API key, consumes no rate slot, records no usage', async () => {
    const calls: string[] = [];
    const governance = {
      async authenticate() {
        calls.push('authenticate');
        return { ok: true as const, value: { keyHash: 'k' } };
      },
      async rateLimit() {
        calls.push('rateLimit');
        return { ok: true as const };
      },
      async recordUsage() {
        calls.push('recordUsage');
      },
    } as unknown as Parameters<typeof createApp>[0]['governance'];

    const listBoardSnapshot = vi.fn(async () => ({
      rows: SNAPSHOT,
      categoryNodes: NODES,
      excluded: [],
    }));
    const app = createApp({
      makeLlm: () => throwingPort,
      governance,
      makeRepo: () => ({ listBoardSnapshot }) as unknown as Repository,
    });

    const res = await app.request('/rankings', { method: 'GET' });

    expect(res.status).toBe(200);
    expect(calls).toEqual([]);
  });
});

/** A count-free CategoryTreeNode fixture with non-rankable defaults. */
function node(
  over: Partial<CategoryTreeNode> & Pick<CategoryTreeNode, 'slug' | 'name'>,
): CategoryTreeNode {
  return {
    parentSlug: null,
    comparableUnit: null,
    rankable: false,
    ...over,
  };
}

const TREE: CategoryTreeNode[] = [
  node({ slug: 'beverage', name: '饮料' }),
  node({ slug: 'soft-drink', name: '软饮', parentSlug: 'beverage', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'carbonated', name: '碳酸饮料', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'drinking-water', name: '饮用水', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'juice-plant', name: '果汁·植物饮', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'dairy', name: '乳品', parentSlug: 'beverage', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'milk', name: '牛奶', parentSlug: 'dairy', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'yogurt', name: '酸奶', parentSlug: 'dairy', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'lactic-drink', name: '乳酸菌饮料', parentSlug: 'dairy', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'alcohol', name: '酒类', parentSlug: 'beverage' }),
  node({ slug: 'wine', name: '葡萄酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml', rankable: true }),
  node({ slug: 'baijiu', name: '白酒', parentSlug: 'alcohol', comparableUnit: 'per_100ml', rankable: true }),
];

/** App whose Repository serves `tree` from listCategoryTree (read-only). */
function categoriesApp(tree: CategoryTreeNode[], opts: { throws?: boolean } = {}) {
  const listCategoryTree = vi.fn(async (): Promise<CategoryTreeNode[]> => {
    if (opts.throws) throw new Error('simulated read failure');
    return tree;
  });
  const repo = {
    async upsertRaw() {
      throw new Error('categories is read-only: upsertRaw must not be called');
    },
    async saveParsed() {
      throw new Error('categories is read-only: saveParsed must not be called');
    },
    async getProduct() {
      return null;
    },
    async saveCorrection() {
      throw new Error('categories is read-only: saveCorrection must not be called');
    },
    listCategoryTree,
  } as unknown as Repository;
  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { app, listCategoryTree };
}

/** GET /categories on an app, returning {res, json}. */
async function getCategories(app: ReturnType<typeof createApp>) {
  const res = await app.request('/categories', { method: 'GET' });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}


describe('GET /categories — full category is-a tree, only the category axis', () => {
  it('returns 200 { nodes } with every category node, no attribute/brand/product_line axis', async () => {
    const { app } = categoriesApp(TREE);
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(200);
    expect(Array.isArray(json.nodes)).toBe(true);
    const slugs = json.nodes.map((n: any) => n.slug);
    // Every category node is present.
    expect(slugs).toEqual(TREE.map((n) => n.slug));
    // No attribute axis slug (e.g. sugar-free) leaks in — the repo only emits
    // kind=category nodes, so the response carries none.
    expect(slugs).not.toContain('sugar-free');
    expect(slugs).not.toContain('sparkling');
    // Each node carries exactly the contract fields.
    for (const n of json.nodes) {
      expect(n).toHaveProperty('slug');
      expect(n).toHaveProperty('name');
      expect(n).toHaveProperty('parentSlug');
      expect(n).toHaveProperty('comparableUnit');
      expect(n).toHaveProperty('rankable');
      expect(n).not.toHaveProperty('rankableCount');
    }
  });
});

describe('public GET endpoints are edge-cacheable on 200, never on errors', () => {
  it('/rankings 200 → public, max-age Cache-Control (edge cache enabled)', async () => {
    const { app } = rankingsApp(SNAPSHOT);
    const { res } = await getRankings(app);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=\d+/);
  });

  it('/categories 200 → public, max-age Cache-Control', async () => {
    const { app } = categoriesApp(TREE);
    const { res } = await getCategories(app);
    expect(res.status).toBe(200);
    const cc = res.headers.get('cache-control') ?? '';
    expect(cc).toMatch(/public/);
    expect(cc).toMatch(/max-age=\d+/);
  });

  it('/rankings 200 carries public, max-age Cache-Control on every request shape', async () => {
    // The former '/rankings 400 carries no Cache-Control' case is retired with
    // the parameter surface: there is no 400 on this endpoint any more. The
    // invariant it protected — an error response must never be edge-cached —
    // still holds for the 500 paths, which set no header at all.
    const { app } = rankingsApp(SNAPSHOT);
    const bare = await app.request('/rankings', { method: 'GET' });
    const noisy = await app.request('/rankings?limit=-1&category=alcohol', { method: 'GET' });

    expect(bare.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(noisy.headers.get('cache-control')).toBe('public, max-age=86400');
  });
});

describe('GET /categories — comparableUnit / rankable per node (P3.5 收敛)', () => {
  it('soft-drink/dairy/酒种叶: per_100ml + rankable=true; alcohol parent+root: null + rankable=false', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const bySlug: Record<string, any> = Object.fromEntries(json.nodes.map((n: any) => [n.slug, n]));
    // Soft-drink line, dairy line, and each 酒种 leaf are all single rankable
    // cohorts (per_100ml / rankable=true → 可点进).
    for (const slug of [
      'soft-drink', 'carbonated', 'drinking-water', 'juice-plant',
      'dairy', 'milk', 'yogurt', 'lactic-drink',
      'wine', 'baijiu',
    ]) {
      expect(bySlug[slug].comparableUnit).toBe('per_100ml');
      expect(bySlug[slug].rankable).toBe(true);
    }
    // ONLY the cross-cohort ancestors (alcohol parent, root) are null / rankable
    // false (不可点进, /rankings cohort-guards them to 400).
    for (const slug of ['alcohol', 'beverage']) {
      expect(bySlug[slug].comparableUnit).toBeNull();
      expect(bySlug[slug].rankable).toBe(false);
    }
  });
});

describe('GET /categories — count-free node contract', () => {
  it('keeps rankable and non-rankable nodes without publishing a second count', async () => {
    const { app } = categoriesApp(TREE);
    const { json } = await getCategories(app);
    const bySlug: Record<string, any> = Object.fromEntries(
      json.nodes.map((n: any) => [n.slug, n]),
    );

    expect(bySlug['soft-drink'].rankable).toBe(true);
    expect(bySlug['juice-plant'].rankable).toBe(true);
    expect(bySlug.alcohol.rankable).toBe(false);
    for (const n of json.nodes) expect(n).not.toHaveProperty('rankableCount');
  });
});

describe('GET /categories — unseeded taxonomy -> 200 { nodes: [] }', () => {
  it('no kind=category rows returns 200 and an empty tree (not an error)', async () => {
    const { app } = categoriesApp([]);
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(200);
    expect(json).toEqual({ nodes: [] });
  });
});

describe('GET /categories — read failure -> 500 persistence-error', () => {
  it('listCategoryTree throwing maps to 500 persistence-error', async () => {
    const { app } = categoriesApp(TREE, { throws: true });
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
  });
});

describe('GET /categories — response validation failure -> 500 internal', () => {
  it('a node violating CategoryTreeResponseSchema maps to 500 internal and logs', async () => {
    const { app } = categoriesApp([node({ slug: 'beverage', name: '' })]);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { res, json } = await getCategories(app);
    expect(res.status).toBe(500);
    expect(json.error).toBe('internal');
    expect(error).toHaveBeenCalledWith(
      '[categories] response validation failed',
      expect.any(Array),
    );
    error.mockRestore();
  });
});

describe('GET /categories — governance-exempt public endpoint', () => {
  it('GET /categories without a key -> 200, and NO rate-limit/usage write to GOVERNANCE_KV', async () => {
    const get = vi.fn(async () => null);
    const put = vi.fn(async () => undefined);
    const kv = { get, put } as unknown as Bindings['GOVERNANCE_KV'];
    const listCategoryTree = vi.fn(async () => TREE);
    const repo = {
      async upsertRaw() {
        throw new Error('read-only');
      },
      async saveParsed() {
        throw new Error('read-only');
      },
      async getProduct() {
        return null;
      },
      async saveCorrection() {
        throw new Error('read-only');
      },
      listCategoryTree,
    } as unknown as Repository;
    // REAL governance configured (API_KEYS present) — yet /categories must NOT
    // engage auth/rate/usage at all (governance-exempt, like /rankings).
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createRealGovernance(),
      makeRepo: () => repo,
    });
    const res = await app.request('/categories', { method: 'GET' }, { API_KEYS: 'key-alpha', GOVERNANCE_KV: kv });
    expect(res.status).toBe(200);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /compute — stateless on-demand 比价 (tier3 deterministic, no AI, no write)
//
// The route maps a STRUCTURED ComputeRequest onto core's ParsedSpec, runs core
// `calculate` (the same per100ml/formula the board stores — byte-for-byte), then
// positions the user's value in the SAME cohort/rankable/per100ml population the
// /rankings query serves. These tests inject a FAKE Repository whose ALL write
// methods THROW (persistence regression guard: a 200 compute must never touch a
// write path) and whose `listBoardSnapshot` serves a fixed ascending cohort board.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build an app for POST /compute. `cohort` is the fixed ascending-by-per100ml
 * board `listBoardSnapshot` returns for any category (the route reads the whole
 * cohort to position). EVERY write method throws — a 200 compute that触发了 any
 * write fails loudly. `listBoardSnapshot` is a spy so a test can assert it was (not)
 * called and with what input.
 */
function computeApp(
  cohort: RankingRow[],
  opts: { nodes?: BoardSnapshotCategoryNode[] } = {},
) {
  // /compute positions against the SAME board snapshot /rankings serves, cut to
  // the requested cohort with the same derivation the client uses. The fixture
  // therefore tags every row into `soft-drink` and exposes a node set that makes
  // that slug (and `wine`, for the 酒种 cases) resolvable.
  const listBoardSnapshot = vi.fn(async () => ({
    rows: cohort.map((r) => ({ ...r, categorySlugs: ['soft-drink'] })),
    categoryNodes: opts.nodes ?? [
      { slug: 'beverage', name: '饮料', parentSlug: null, comparableUnit: null, rankable: false },
      {
        slug: 'soft-drink',
        name: '软饮',
        parentSlug: 'beverage',
        comparableUnit: 'per_100ml' as const,
        rankable: true,
      },
      {
        slug: 'wine',
        name: '葡萄酒',
        parentSlug: 'beverage',
        comparableUnit: 'per_100ml' as const,
        rankable: true,
      },
    ],
    excluded: [],
  }));
  const upsertRaw = vi.fn(async () => {
    throw new Error('compute is stateless: upsertRaw must not be called');
  });
  const saveParsed = vi.fn(async () => {
    throw new Error('compute is stateless: saveParsed must not be called');
  });
  const saveCorrection = vi.fn(async () => {
    throw new Error('compute is stateless: saveCorrection must not be called');
  });
  const reconcileCategory = vi.fn(async () => {
    throw new Error('compute is stateless: reconcileCategory must not be called');
  });
  const setRankable = vi.fn(async () => {
    throw new Error('compute is stateless: setRankable must not be called');
  });
  const repo = {
    upsertRaw,
    saveParsed,
    saveCorrection,
    reconcileCategory,
    setRankable,
    async getProduct() {
      return null;
    },
    listBoardSnapshot,
  } as unknown as Repository;
  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return {
    app,
    listBoardSnapshot,
    upsertRaw,
    saveParsed,
    saveCorrection,
    reconcileCategory,
    setRankable,
  };
}

/** POST /compute on an app, returning {res, json}. */
async function postCompute(app: ReturnType<typeof createApp>, body: unknown) {
  const res = await app.request('/compute', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

// A small soft-drink cohort (per_100ml axis), ascending by per100ml — mirrors
// what listRankings returns (closure + rankable=1 + per100ml NOT NULL).
const COHORT: RankingRow[] = [
  row({ id: 'p-1', per100ml: 0.4, storeSku: 'sku-1' }),
  row({ id: 'p-2', per100ml: 0.6, storeSku: 'sku-2' }),
  row({ id: 'p-3', per100ml: 1.0, storeSku: 'sku-3' }),
  row({ id: 'p-4', per100ml: 2.0, storeSku: 'sku-4' }),
  row({ id: 'p-5', per100ml: 5.0, storeSku: 'sku-5' }),
];

describe('POST /compute — sufficient input -> 200 + price + positioning', () => {
  it('totalAmount path: 200 with byte-exact per100ml/formula + rank/percentile/neighbors', async () => {
    const { app, saveParsed, upsertRaw } = computeApp(COHORT);
    // 1500ml @ 9 元 → per100ml = 0.6 (= cohort p-2). Cheaper rows: only p-1 (0.4).
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    // Byte-exact core output (same calculate the board stores).
    expect(json.per100ml).toBe(0.6);
    expect(json.per100g).toBeNull();
    expect(json.formula).toBe('9 / 1500 * 100');
    expect(json.axis).toBe('per_100ml');
    // rank = (# strictly cheaper) + 1 = 1 (only 0.4) + 1 = 2.
    expect(json.rank).toBe(2);
    expect(json.total).toBe(5);
    // percentile = strictly-pricier (1.0,2.0,5.0 → 3) / 5 * 100 = 60.
    expect(json.percentile).toBeCloseTo(60);
    // neighbors: up to 3 cheaper (just p-1) + up to 3 pricier-or-equal at/above
    // the slot (p-2 @0.6 [tie], p-3, p-4). Each is a board projection with rank.
    expect(json.neighbors.map((n: any) => n.storeSku)).toEqual([
      'sku-1',
      'sku-2',
      'sku-3',
      'sku-4',
    ]);
    expect(json.neighbors.map((n: any) => n.rank)).toEqual([1, 2, 3, 4]);
    expect(json.neighbors[0]).not.toHaveProperty('id');
    // No write path was ever entered (stateless guard).
    expect(saveParsed).not.toHaveBeenCalled();
    expect(upsertRaw).not.toHaveBeenCalled();
  });

  it('unitSize+quantity path: 200 with the expanded formula verbatim from core', async () => {
    const { app } = computeApp(COHORT);
    // 330ml × 24 @ 40 → per100ml = 0.5050505... (cheaper than p-2 @0.6, pricier than p-1 @0.4).
    const { res, json } = await postCompute(app, {
      totalPrice: 40,
      unitSize: { value: 330, unit: 'ml' },
      quantity: 24,
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(json.per100ml).toBe(0.5050505050505051);
    expect(json.formula).toBe('40 / (330 * 24 * 1) * 100');
    expect(json.axis).toBe('per_100ml');
    // rank: strictly cheaper = p-1 (0.4) only → rank 2.
    expect(json.rank).toBe(2);
  });

  it('positioned neighbors carry capturedAt + lowestPriceCents (compute reuses RankingsItemSchema); price above the low → lowestPriceCents < priceCents', async () => {
    const CAP = 1_700_000_000_000;
    const cohort: RankingRow[] = [
      row({ id: 'n-1', per100ml: 0.4, storeSku: 'sku-1', priceCents: 1490, lowestPriceCents: 990, capturedAt: CAP }),
      row({ id: 'n-2', per100ml: 0.6, storeSku: 'sku-2', priceCents: 1490, lowestPriceCents: 990, capturedAt: CAP }),
      row({ id: 'n-3', per100ml: 1.0, storeSku: 'sku-3', priceCents: 1490, lowestPriceCents: 990, capturedAt: CAP }),
    ];
    const { app } = computeApp(cohort);
    // per100ml 0.6 → cheaper n-1, slot-side n-2 (tie) + n-3 → neighbors non-empty.
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(json.neighbors.length).toBeGreaterThan(0);
    for (const n of json.neighbors) {
      expect(n.capturedAt).toBe(CAP);
      expect(Number.isInteger(n.capturedAt)).toBe(true);
      expect(n.lowestPriceCents).toBe(990);
      expect(n.lowestPriceCents).toBeLessThan(n.priceCents);
    }
  });

  it('sets Cache-Control: no-store on the 200', async () => {
    const { app } = computeApp(COHORT);
    const { res } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('positions against the same board snapshot /rankings serves', async () => {
    // One population, one ancestry rule: the compare card's rank and the
    // board's rank are cut from the same object by the same derivation, so
    // they cannot disagree. (The retired assertion checked that a node-scoped
    // SQL read was forwarded the validated slug; that read no longer exists.)
    const { app, listBoardSnapshot } = computeApp(COHORT);
    const { res } = await postCompute(app, {
      totalPrice: 10,
      totalAmount: { value: 1000, unit: 'ml' },
      category: 'soft-drink',
    });

    expect(res.status).toBe(200);
    expect(listBoardSnapshot).toHaveBeenCalledTimes(1);
  });
});

describe('POST /compute — insufficient input -> 400 naming the missing class', () => {
  it('only totalPrice + category (no totalAmount, no unitSize+quantity) -> 400, repo not read', async () => {
    const { app, listBoardSnapshot } = computeApp(COHORT);
    const { res, json } = await postCompute(app, { totalPrice: 9, category: 'soft-drink' });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // Message names BOTH acceptable ways to complete the input set.
    expect(json.message).toContain('总量');
    expect(json.message).toContain('数量');
    // No silent per100ml=null 200, and positioning never ran.
    expect(json).not.toHaveProperty('per100ml');
    expect(listBoardSnapshot).not.toHaveBeenCalled();
  });

  it('unitSize WITHOUT quantity -> 400 (incomplete unitSize path)', async () => {
    const { app } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      unitSize: { value: 330, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
  });
});

describe('POST /compute — uncomputable (price 非正/无轴) -> 400 + core warning (never silent 200)', () => {
  it('totalPrice <= 0 -> 400 carrying core 价格无效 warning', async () => {
    const { app } = computeApp(COHORT);
    // The api-client schema rejects totalPrice<=0 at the boundary (positive()),
    // so this is a 400 invalid-request — never a silent 200 with nulls.
    const { res, json } = await postCompute(app, {
      totalPrice: 0,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(json).not.toHaveProperty('per100ml');
  });
});

describe('POST /compute — cross-axis / cross-cohort -> 400 不可比 (positioning forbidden)', () => {
  it('g input into a per_100ml cohort -> 400 naming the cohort 比价 axis, repo not read', async () => {
    const { app, listBoardSnapshot } = computeApp(COHORT);
    // 500g @ 25 → core lands per100g; soft-drink cohort is per_100ml → mismatch.
    const { res, json } = await postCompute(app, {
      totalPrice: 25,
      totalAmount: { value: 500, unit: 'g' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // Message points at the cohort's axis (per 100ml).
    expect(json.message).toContain('100ml');
    expect(listBoardSnapshot).not.toHaveBeenCalled();
  });

  it('cross-cohort node (beverage root) -> 400, positioning never happens', async () => {
    const { app, listBoardSnapshot } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'beverage',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listBoardSnapshot).not.toHaveBeenCalled();
  });

  it('cross-cohort node (alcohol parent) -> 400', async () => {
    const { app, listBoardSnapshot } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'alcohol',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listBoardSnapshot).not.toHaveBeenCalled();
  });

  it('unknown/typo category (non-empty, not in CATEGORY_SLUGS) -> 400 未知品类 (distinct from cross-cohort), repo not read', async () => {
    const { app, listBoardSnapshot } = computeApp(COHORT);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'nonexistent',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // The distinct 未知品类 message (NOT the cross-cohort "跨多个比价口径") — this is
    // the guard F8 added; without it an unknown slug would resolve null and be
    // misdiagnosed as cross-cohort. Removing the gate must fail THIS test.
    expect(json.message).toBe('未知品类');
    expect(listBoardSnapshot).not.toHaveBeenCalled();
  });
});

describe('POST /compute — empty cohort -> 200 + empty neighbors (never 404)', () => {
  it('a statically valid slug missing from an unseeded snapshot maps to an empty population', async () => {
    const { app } = computeApp([], { nodes: [] });
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'beer',
    });

    expect(res.status).toBe(200);
    expect(json).toMatchObject({ total: 0, rank: 1, percentile: 0, neighbors: [] });
  });

  it('no rankable rows -> 200, total=0, rank=1, percentile=0, neighbors=[]', async () => {
    const { app } = computeApp([]);
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 1500, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(json.total).toBe(0);
    expect(json.rank).toBe(1);
    expect(json.percentile).toBe(0);
    expect(json.neighbors).toEqual([]);
    // Still a valid computed price (positioning empty ≠ uncomputable).
    expect(json.per100ml).toBe(0.6);
    expect(json.formula).toBe('9 / 1500 * 100');
  });

  it('user value below the whole cohort -> rank 1, one-sided (only pricier) neighbors', async () => {
    const { app } = computeApp(COHORT);
    // 5000ml @ 9 → per100ml = 0.18, cheaper than every cohort row (min 0.4).
    const { res, json } = await postCompute(app, {
      totalPrice: 9,
      totalAmount: { value: 5000, unit: 'ml' },
      category: 'soft-drink',
    });
    expect(res.status).toBe(200);
    expect(json.rank).toBe(1);
    expect(json.total).toBe(5);
    expect(json.percentile).toBeCloseTo(100); // cheaper than all 5.
    // Only the pricier side (the 3 cheapest cohort rows) — no cheaper neighbors.
    expect(json.neighbors.map((n: any) => n.storeSku)).toEqual(['sku-1', 'sku-2', 'sku-3']);
  });
});

describe('POST /compute — invalid request body -> 400 invalid-request', () => {
  it.each([
    ['non-JSON body', '{not json'],
    ['missing category', { totalPrice: 9, totalAmount: { value: 1500, unit: 'ml' } }],
    ['empty category', { totalPrice: 9, totalAmount: { value: 1500, unit: 'ml' }, category: '' }],
    ['negative measurement', { totalPrice: 9, totalAmount: { value: -1, unit: 'ml' }, category: 'soft-drink' }],
    ['bad unit', { totalPrice: 9, totalAmount: { value: 1500, unit: 'oz' }, category: 'soft-drink' }],
    ['non-integer quantity', { totalPrice: 9, unitSize: { value: 330, unit: 'ml' }, quantity: 1.5, category: 'soft-drink' }],
  ])('%s -> 400, repo never read, no write', async (_name, body) => {
    const { app, listBoardSnapshot, saveParsed } = computeApp(COHORT);
    const { res, json } = await postCompute(app, body);
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(listBoardSnapshot).not.toHaveBeenCalled();
    expect(saveParsed).not.toHaveBeenCalled();
  });
});
