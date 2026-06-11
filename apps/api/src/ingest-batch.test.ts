// POST /ingest/batch — batch async crowd-sourced capture tests (group C). Lands
// each item's raw SYNCHRONOUSLY (shared upsertRawOrNull map), schedules a SINGLE
// bounded-concurrency background unit (BG_POOL) draining all landed items, and
// returns 202 immediately. The request-path error code set mirrors /ingest:
// {invalid-request(400), persistence-error(500), internal(500), accepted(202)}
// plus governance codes — accepted=0 (every upsertRaw failed) → 500 (NO 2xx
// masking a whole-batch write failure as accepted).
//
// Functional cases inject a SYNCHRONOUS background port `(_, run) => run()`
// (createApp awaits it, so the background drains BEFORE the 202 returns) so
// post-background effects (saveParsed calls) are deterministically assertable.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';
import type { KVNamespace } from '@cloudflare/workers-types';
import type { Repository } from '@unit-price/db';
import { createApp, MAX_BATCH, BG_POOL } from './routes.js';
import {
  createNoopGovernance,
  createRealGovernance,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SECONDS,
  type Governance,
} from './governance.js';
import type { AppEnv, Bindings } from './bindings.js';
import type { ParseResult, SpecParserLLM } from './llm.js';

// ── LLM ports (drive orchestrate branches) ─────────────────────────────────
/** A port that must never be called (tier1-sufficient inputs skip tier2). */
const throwingPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    throw new Error('LLM must not be called for tier1-sufficient inputs');
  },
};

/** Synchronous background port: run() is awaited, so the background drain
 *  completes before the 202 returns — lets functional tests assert post-drain
 *  effects (saveParsed). */
const syncBackground = (_c: Context<AppEnv>, run: () => Promise<void>): Promise<void> => run();

// A clean, tier1-sufficient title: 330ml*24 -> 7920ml. tier2 (throwingPort) is
// never reached, so the ok branch reaches saveParsed in the background.
const CLEAN = { title: '可口可乐 330ml*24听', price: 40 };

/** Build N distinct clean batch items (unique storeSku so dedupe never merges). */
function cleanItems(n: number): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_v, i) => ({
    ...CLEAN,
    store: 'sam',
    storeSku: `coke-${i}`,
  }));
}

/** A spy-wrapped in-memory-ish repo: upsertRaw returns a unique id by default;
 *  saveParsed is a no-op success. `upsertRaw` behavior is overridable per test. */
function makeSpyRepo(opts: { upsertRaw?: (req: any) => Promise<string> } = {}) {
  let n = 0;
  const upsertRaw = vi.fn(opts.upsertRaw ?? (async () => `raw-${n++}`));
  const saveParsed = vi.fn(async () => ({ productId: 'p', unitPriceId: 'u' }));
  const repo = {
    upsertRaw,
    saveParsed,
    async getProduct() {
      return null;
    },
    async saveCorrection() {
      return 'c';
    },
  } as unknown as Repository;
  return { repo, upsertRaw, saveParsed };
}

/**
 * POST /ingest/batch against an app with the given repo + LLM port, a no-op
 * governance (auth exercised separately), and (by default) the SYNCHRONOUS
 * background port. `makeRepo` may be omitted to drive the persistence-error
 * branch; `governance`/`scheduleBackground`/`port` may be overridden.
 */
async function batch(opts: {
  port?: SpecParserLLM;
  makeRepo?: (env: Bindings) => Repository | null;
  body: unknown;
  governance?: Governance;
  scheduleBackground?: (c: Context<AppEnv>, run: () => Promise<void>) => void | Promise<void>;
  env?: Bindings;
}) {
  const app = createApp({
    makeLlm: () => opts.port ?? throwingPort,
    governance: opts.governance ?? createNoopGovernance(),
    makeRepo: opts.makeRepo,
    scheduleBackground: opts.scheduleBackground ?? syncBackground,
  });
  const res = await app.request(
    '/ingest/batch',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    },
    opts.env,
  );
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

// Silence the background's structured warn/error logs so test output stays clean.
let warnSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  warnSpy.mockRestore();
  errorSpy.mockRestore();
});

// ── 4.1 happy path ─────────────────────────────────────────────────────────
describe('POST /ingest/batch — happy path (4.1)', () => {
  it('3 valid items -> 202 {accepted:3,failed:[]}; upsertRaw x3, ONE background unit, saveParsed x3', async () => {
    const { repo, upsertRaw, saveParsed } = makeSpyRepo();
    const scheduleBackground = vi.fn(syncBackground);
    const { res, json } = await batch({
      makeRepo: () => repo,
      body: { items: cleanItems(3) },
      scheduleBackground,
    });

    expect(res.status).toBe(202);
    expect(json).toEqual({ accepted: 3, failed: [] });
    // No parse results leak into the 202 body (background not yet reported).
    expect(json.spec).toBeUndefined();
    expect(json.unitPrice).toBeUndefined();

    // One upsertRaw per item.
    expect(upsertRaw).toHaveBeenCalledTimes(3);
    // SINGLE background unit (one waitUntil), NOT one per item (would be 3).
    expect(scheduleBackground).toHaveBeenCalledTimes(1);
    // The single sync background drain ran orchestrate->ok->saveParsed for all 3.
    expect(saveParsed).toHaveBeenCalledTimes(3);
  });
});

// ── 4.2 envelope rejection ─────────────────────────────────────────────────
describe('POST /ingest/batch — invalid envelope rejects the whole batch (4.2)', () => {
  it('non-JSON body -> 400 invalid-request, upsertRaw never called', async () => {
    const { repo, upsertRaw } = makeSpyRepo();
    const { res, json } = await batch({
      makeRepo: () => repo,
      body: 'not json{',
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(upsertRaw).not.toHaveBeenCalled();
  });

  it('empty items array -> 400 invalid-request, upsertRaw never called', async () => {
    const { repo, upsertRaw } = makeSpyRepo();
    const { res, json } = await batch({ makeRepo: () => repo, body: { items: [] } });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(upsertRaw).not.toHaveBeenCalled();
  });

  it(`items over MAX_BATCH (${MAX_BATCH + 1}) -> 400 invalid-request, upsertRaw never called`, async () => {
    const { repo, upsertRaw } = makeSpyRepo();
    const { res, json } = await batch({
      makeRepo: () => repo,
      body: { items: cleanItems(MAX_BATCH + 1) },
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    expect(upsertRaw).not.toHaveBeenCalled();
  });

  it('one item missing storeSku -> 400 invalid-request (whole batch), upsertRaw never called', async () => {
    const { repo, upsertRaw } = makeSpyRepo();
    const items: Array<Record<string, unknown>> = cleanItems(3);
    delete items[1].storeSku; // second item missing the dedupe key
    const { res, json } = await batch({ makeRepo: () => repo, body: { items } });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // Whole batch rejected: NO item landed (not even the two valid ones).
    expect(upsertRaw).not.toHaveBeenCalled();
  });
});

// ── 4.3 partial failure still 202 ──────────────────────────────────────────
describe('POST /ingest/batch — partial failure still 202 (4.3)', () => {
  it('item index 1 (of 3) throws on upsertRaw -> 202 {accepted:2, failed:[{index:1,...}]}', async () => {
    let call = 0;
    const upsertRawImpl = async (req: any): Promise<string> => {
      const i = call++;
      if (i === 1) throw new Error('transient write failure on the 2nd item');
      return `raw-${i}`;
    };
    const { repo, upsertRaw, saveParsed } = makeSpyRepo({ upsertRaw: upsertRawImpl });
    const items = cleanItems(3); // storeSku: coke-0, coke-1, coke-2
    const scheduleBackground = vi.fn(syncBackground);
    const { res, json } = await batch({
      makeRepo: () => repo,
      body: { items },
      scheduleBackground,
    });

    expect(res.status).toBe(202);
    expect(json.accepted).toBe(2);
    expect(json.failed).toEqual([{ index: 1, store: 'sam', storeSku: 'coke-1' }]);
    // Invariant: accepted + failed.length === items.length.
    expect(json.accepted + json.failed.length).toBe(3);

    expect(upsertRaw).toHaveBeenCalledTimes(3);
    // The two landed items are drained in the single background unit.
    expect(scheduleBackground).toHaveBeenCalledTimes(1);
    expect(saveParsed).toHaveBeenCalledTimes(2);
  });
});

// ── 4.4 all-fail -> 500 ────────────────────────────────────────────────────
describe('POST /ingest/batch — all items fail -> 500 persistence-error (4.4)', () => {
  it('every upsertRaw throws -> 500 persistence-error, NO {accepted, failed} body, no background', async () => {
    const { repo, upsertRaw } = makeSpyRepo({
      upsertRaw: async () => {
        throw new Error('DB write failed');
      },
    });
    const scheduleBackground = vi.fn(syncBackground);
    const { res, json } = await batch({
      makeRepo: () => repo,
      body: { items: cleanItems(3) },
      scheduleBackground,
    });

    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
    // accepted=0 must NOT be dressed up as a 2xx result body.
    expect(json.accepted).toBeUndefined();
    expect(json.failed).toBeUndefined();
    // Every item attempted, but no background scheduled (nothing landed).
    expect(upsertRaw).toHaveBeenCalledTimes(3);
    expect(scheduleBackground).not.toHaveBeenCalled();
  });
});

// ── 4.5 DB unbound -> 500 (resolveRepo stage) ──────────────────────────────
describe('POST /ingest/batch — DB unbound -> 500 persistence-error (4.5)', () => {
  it('makeRepo returns null -> 500 persistence-error (whole batch, resolveRepo stage)', async () => {
    const scheduleBackground = vi.fn(syncBackground);
    const { res, json } = await batch({
      makeRepo: () => null,
      body: { items: cleanItems(3) },
      scheduleBackground,
    });
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
    expect(json.accepted).toBeUndefined();
    expect(json.failed).toBeUndefined();
    expect(scheduleBackground).not.toHaveBeenCalled();
  });
});

// ── Governance regression on /ingest/batch (4.6 / 4.7 / 4.8) ────────────────
const VALID_KEY = 'key-alpha';

/** Map-backed fake KVNamespace (get/put with TTL semantics). */
function makeFakeKV(opts: { now?: () => number } = {}) {
  const store = new Map<string, { value: string; expiresAt: number | null }>();
  const nowMs = () => (opts.now ? opts.now() * 1000 : Date.now());
  const put = vi.fn(
    async (key: string, value: string, options?: { expirationTtl?: number }) => {
      const expiresAt =
        options?.expirationTtl !== undefined ? nowMs() + options.expirationTtl * 1000 : null;
      store.set(key, { value, expiresAt });
    },
  );
  const get = vi.fn(async (key: string) => {
    const entry = store.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt !== null && nowMs() >= entry.expiresAt) {
      store.delete(key);
      return null;
    }
    return entry.value;
  });
  const del = vi.fn(async (key: string) => {
    store.delete(key);
  });
  const kv = { get, put, delete: del } as unknown as KVNamespace;
  return { kv, get, put };
}

// ── 4.6 auth gate ──────────────────────────────────────────────────────────
describe('POST /ingest/batch — governance auth gate (4.6)', () => {
  it('no key -> 401 auth-missing (batch endpoint self-mounts governance, not skipped); upsertRaw/background never engaged', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { repo, upsertRaw } = makeSpyRepo();
    const scheduleBackground = vi.fn(syncBackground);
    const { res, json } = await batch({
      makeRepo: () => repo,
      body: { items: cleanItems(3) },
      governance: createRealGovernance(),
      scheduleBackground,
      env,
    });
    expect(res.status).toBe(401);
    expect(json.error).toBe('auth-missing');
    // Auth short-circuits BEFORE any landing / background scheduling.
    expect(upsertRaw).not.toHaveBeenCalled();
    expect(scheduleBackground).not.toHaveBeenCalled();
  });

  it('valid key -> admitted (202, batch pipeline entered)', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { repo, upsertRaw } = makeSpyRepo();
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createRealGovernance(),
      makeRepo: () => repo,
      scheduleBackground: syncBackground,
    });
    const res = await app.request(
      '/ingest/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ items: cleanItems(3) }),
      },
      env,
    );
    expect(res.status).toBe(202);
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(upsertRaw).toHaveBeenCalledTimes(3);
  });
});

// ── 4.7 usage per landed item ──────────────────────────────────────────────
describe('POST /ingest/batch — usage = accepted (admission 1 + stack accepted-1) (4.7)', () => {
  /**
   * Real governance that admits any non-empty key, with a recordUsage spy that
   * records every (key, amount) call. The middleware admission call passes no
   * amount (-> treated as 1); the handler stacks recordUsage(key, accepted-1)
   * only when accepted>1.
   */
  function spyGovernance(): { gov: Governance; usageCalls: Array<{ amount: number }> } {
    const real = createRealGovernance();
    const usageCalls: Array<{ amount: number }> = [];
    const gov: Governance = {
      authenticate: real.authenticate,
      checkRateLimit: real.checkRateLimit,
      async recordUsage(_env, _key, amount?: number): Promise<void> {
        // Middleware admission passes amount=undefined -> baseline 1.
        usageCalls.push({ amount: amount ?? 1 });
      },
    };
    return { gov, usageCalls };
  }

  it('N=3 accepted -> total usage amount = 3 (admission 1 + stacked 2); no amount<=0', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { repo } = makeSpyRepo();
    const { gov, usageCalls } = spyGovernance();
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: gov,
      makeRepo: () => repo,
      scheduleBackground: syncBackground,
    });
    const res = await app.request(
      '/ingest/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ items: cleanItems(3) }),
      },
      env,
    );
    expect(res.status).toBe(202);
    const total = usageCalls.reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(3); // = accepted
    // Never pass amount <= 0 (would corrupt the KV count).
    expect(usageCalls.every((c) => c.amount >= 1)).toBe(true);
  });

  it('N=1 accepted -> total usage = 1 (no stacking call)', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { repo } = makeSpyRepo();
    const { gov, usageCalls } = spyGovernance();
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: gov,
      makeRepo: () => repo,
      scheduleBackground: syncBackground,
    });
    const res = await app.request(
      '/ingest/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ items: cleanItems(1) }),
      },
      env,
    );
    expect(res.status).toBe(202);
    const total = usageCalls.reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(1);
    // Exactly one usage call (admission); no stacking for accepted<=1.
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls.every((c) => c.amount >= 1)).toBe(true);
  });

  it('all-fail accepted=0 (-> 500) -> total usage = 1 (admission only, no amount<=0 call)', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { repo } = makeSpyRepo({
      upsertRaw: async () => {
        throw new Error('DB write failed');
      },
    });
    const { gov, usageCalls } = spyGovernance();
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: gov,
      makeRepo: () => repo,
      scheduleBackground: syncBackground,
    });
    const res = await app.request(
      '/ingest/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ items: cleanItems(3) }),
      },
      env,
    );
    expect(res.status).toBe(500);
    const total = usageCalls.reduce((s, c) => s + c.amount, 0);
    expect(total).toBe(1); // admission baseline only
    expect(usageCalls).toHaveLength(1); // no stacking call at all
    expect(usageCalls.every((c) => c.amount >= 1)).toBe(true); // never amount<=0
  });
});

// ── 4.8 rate limit per request, not per item ───────────────────────────────
describe('POST /ingest/batch — rate-limit per request, not per item (4.8)', () => {
  it('a 40-item batch consumes exactly ONE rate token (checkRateLimit called once)', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { repo } = makeSpyRepo();
    const real = createRealGovernance();
    const checkRateLimit = vi.fn(real.checkRateLimit);
    const gov: Governance = {
      authenticate: real.authenticate,
      checkRateLimit,
      recordUsage: real.recordUsage,
    };
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: gov,
      makeRepo: () => repo,
      scheduleBackground: syncBackground,
    });
    const res = await app.request(
      '/ingest/batch',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
        body: JSON.stringify({ items: cleanItems(MAX_BATCH) }), // 40 items
      },
      env,
    );
    expect(res.status).toBe(202);
    // One request = one rate token, regardless of item count (not 40).
    expect(checkRateLimit).toHaveBeenCalledTimes(1);
  });

  it('over-limit -> 429 before any landing (whole batch); upsertRaw never called', async () => {
    const fixedNow = 5_000_000;
    const { kv } = makeFakeKV({ now: () => fixedNow });
    const windowStart = fixedNow - (fixedNow % RATE_LIMIT_WINDOW_SECONDS);
    await kv.put(`rl:${VALID_KEY}:${windowStart}`, String(RATE_LIMIT_MAX), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow * 1000);
    try {
      const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
      const { repo, upsertRaw } = makeSpyRepo();
      const scheduleBackground = vi.fn(syncBackground);
      const app = createApp({
        makeLlm: () => throwingPort,
        governance: createRealGovernance(),
        makeRepo: () => repo,
        scheduleBackground,
      });
      const res = await app.request(
        '/ingest/batch',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
          body: JSON.stringify({ items: cleanItems(MAX_BATCH) }),
        },
        env,
      );
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe('rate-limited');
      expect(upsertRaw).not.toHaveBeenCalled();
      expect(scheduleBackground).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

// ── 4.9 bounded background concurrency ─────────────────────────────────────
describe('POST /ingest/batch — background concurrency bounded by BG_POOL (4.9)', () => {
  it(`MAX_BATCH (${MAX_BATCH}) landed items: in-flight orchestrate never exceeds BG_POOL (${BG_POOL}); ONE background unit`, async () => {
    // Count in-flight orchestrate calls via a controllable LLM port. Each parse
    // increments in-flight, yields control (so the pool fills before any
    // releases), records the peak, then resolves. If the handler fanned out one
    // waitUntil per item (unbounded), peak would reach MAX_BATCH (40); the pool
    // must pin it at BG_POOL (5). The clean title is tier1-sufficient, so to
    // make orchestrate actually call the LLM we use a no-shape title that drives
    // tier2 (the in-flight gauge lives in the port's parse).
    let inFlight = 0;
    let peak = 0;
    const releases: Array<() => void> = [];
    const llmParse = vi.fn(async (): Promise<ParseResult> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      // Block until explicitly released, so concurrency is observable: the pool
      // can have at most BG_POOL parses blocked here at once.
      await new Promise<void>((resolve) => {
        releases.push(() => {
          inFlight--;
          resolve();
        });
      });
      // transport failure -> orchestrate yields `insufficient` (no saveParsed),
      // keeping the background path simple (no repo write needed).
      return { ok: false, kind: 'transport', message: 'simulated' };
    });
    const port: SpecParserLLM = { parse: llmParse };

    const { repo } = makeSpyRepo();
    const scheduleBackground = vi.fn(syncBackground);

    // No-shape titles so orchestrate enters tier2 and calls llmParse.
    const items = Array.from({ length: MAX_BATCH }, (_v, i) => ({
      title: '农夫山泉',
      price: 5,
      store: 'sam',
      storeSku: `nfsq-${i}`,
    }));

    // syncBackground awaits drainBackground; drainBackground awaits Promise.all
    // of the pool workers, each blocked on a release. So we must NOT await the
    // request before draining the releases — kick the request, then drain.
    const app = createApp({
      makeLlm: () => port,
      governance: createNoopGovernance(),
      makeRepo: () => repo,
      scheduleBackground,
    });
    const reqPromise = app.request('/ingest/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items }),
    });

    // Drain releases until all 40 parses have been admitted+resolved. Each macro
    // tick: let pending microtasks settle, then release everything queued so far.
    for (let guard = 0; guard < 1000 && llmParse.mock.calls.length < MAX_BATCH; guard++) {
      await new Promise((r) => setTimeout(r, 0));
      while (releases.length > 0) releases.shift()!();
    }
    // Release any stragglers, then await the response.
    await new Promise((r) => setTimeout(r, 0));
    while (releases.length > 0) releases.shift()!();
    const res = await reqPromise;

    expect(res.status).toBe(202);
    expect(llmParse).toHaveBeenCalledTimes(MAX_BATCH); // every item parsed once
    // The crux: concurrency pinned to the pool width, NOT fanned out to 40.
    // Tight bound: pool fills to EXACTLY its width — a regression serializing
    // the pool to width 1 (or BG_POOL=1) fails this, where `<= BG_POOL` alone
    // would not. Reverse control: an unbounded fan-out would be MAX_BATCH.
    expect(peak).toBe(BG_POOL);
    expect(peak).toBeLessThan(MAX_BATCH);
    // Single background unit (one waitUntil), not one per item.
    expect(scheduleBackground).toHaveBeenCalledTimes(1);
  });
});
