// POST /ingest — async crowd-sourced capture tests (group B). Lands raw
// synchronously, returns 202 {rawId}, runs orchestrate + saveParsed in the
// BACKGROUND via the injected `scheduleBackground` port.
//
// Functional cases inject a SYNCHRONOUS background port `(_, run) => run()`
// (createApp awaits it, so the background finishes BEFORE the 202 returns) plus
// a real in-memory better-sqlite3 repo, so post-background persistence can be
// asserted by querying actual rows. The non-blocking case (5.4) instead injects
// the fire-and-forget port `(_, run) => { void run(); }` with a never-resolving
// run — it MUST NOT use the sync port (a sync `await run()` on a never-resolving
// run would self-deadlock the test).
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type { Context } from 'hono';
import type { KVNamespace } from '@cloudflare/workers-types';
import { createDb, createRepository, type Repository } from '@unit-price/db';
import { createApp } from './routes.js';
import {
  createNoopGovernance,
  createRealGovernance,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_SECONDS,
} from './governance.js';
import type { AppEnv, Bindings } from './bindings.js';
import type { ParseResult, SpecParserLLM } from './llm.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
);

interface TestRepo {
  repo: Repository;
  handle: Database.Database;
}

/** Build a fresh in-memory repo with migrations applied (FKs on, like D1). */
function openRepo(): TestRepo {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') throw new Error('expected a better-sqlite3-backed Db');
  migrate(db.orm, { migrationsFolder });
  return { repo: createRepository(db), handle };
}

function countRows(handle: Database.Database, table: string): number {
  return (handle.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number }).c;
}

// ── LLM ports (drive orchestrate branches), mirroring contribute.test.ts ────
/** A port that must never be called (tier1-sufficient inputs skip tier2). */
const throwingPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    throw new Error('LLM must not be called for tier1-sufficient inputs');
  },
};
/** Always reports a transport failure (drives `insufficient` on no-shape titles). */
const transportFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'transport', message: 'simulated timeout' };
  },
};
/** Reports a runtime config error (drives `config-error`). */
const configFailPort: SpecParserLLM = {
  async parse(): Promise<ParseResult> {
    return { ok: false, kind: 'config', message: 'missing OPENROUTER_API_KEY' };
  },
};

/** Synchronous background port: run() is awaited, so the background completes
 *  before the 202 returns — lets functional tests query post-background rows. */
const syncBackground = (
  _c: Context<AppEnv>,
  run: () => Promise<void>,
): Promise<void> => run();

// A clean, tier1-sufficient title: 330ml*24 -> 7920ml, per100ml ~= 0.505.
const CLEAN = { title: '可口可乐 330ml*24听', price: 40 };

/**
 * POST /ingest against an app with the given repo factory + LLM port, a no-op
 * governance, and (by default) the SYNCHRONOUS background port. `makeRepo` may
 * be omitted to drive the persistence-error branch; `scheduleBackground` may be
 * overridden (e.g. fire-and-forget for the non-blocking test).
 */
async function ingest(opts: {
  port: SpecParserLLM;
  makeRepo?: (env: Bindings) => Repository | null;
  body: unknown;
  scheduleBackground?: (
    c: Context<AppEnv>,
    run: () => Promise<void>,
  ) => void | Promise<void>;
}) {
  const app = createApp({
    makeLlm: () => opts.port,
    governance: createNoopGovernance(),
    makeRepo: opts.makeRepo,
    scheduleBackground: opts.scheduleBackground ?? syncBackground,
  });
  const res = await app.request('/ingest', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { res, json };
}

// Silence the background's structured warn/error logs (insufficient/config/
// saveParsed-throw) so the test output stays clean; restore after each test.
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

describe('POST /ingest — happy path lands all three tables (4.1)', () => {
  it('returns 202 {rawId}; background writes one row to each table', async () => {
    const { repo, handle } = openRepo();
    const { res, json } = await ingest({
      port: throwingPort,
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
    });

    expect(res.status).toBe(202);
    // The 202 body is the minimal {rawId} — no spec/unitPrice/confidence.
    expect(typeof json.rawId).toBe('string');
    expect(json.rawId.length).toBeGreaterThan(0);
    expect(json.unitPrice).toBeUndefined();
    expect(json.spec).toBeUndefined();

    // Sync background ran to completion before the 202 returned: all three land.
    expect(countRows(handle, 'product_raw')).toBe(1);
    expect(countRows(handle, 'product')).toBe(1);
    expect(countRows(handle, 'unit_price')).toBe(1);
  });
});

describe('POST /ingest — nativeCategoryId provenance (2.1/2.3)', () => {
  it('nativeCategoryId lands on product_raw.native_category_id (shared upsertRaw map)', async () => {
    const { repo, handle } = openRepo();
    const { res } = await ingest({
      port: throwingPort,
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-native', nativeCategoryId: '10012164' },
    });
    expect(res.status).toBe(202);
    const raw = handle
      .prepare(
        'SELECT native_category_id AS n, category_hint AS h FROM product_raw WHERE store_sku = ?',
      )
      .get('coke-native') as { n: string | null; h: string | null };
    expect(raw.n).toBe('10012164');
    expect(raw.h).toBeNull(); // never touches the domain category column
  });

  it('empty-string nativeCategoryId → null + 202 (not 400)', async () => {
    const { repo, handle } = openRepo();
    const { res } = await ingest({
      port: throwingPort,
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'n-empty', nativeCategoryId: '' },
    });
    expect(res.status).toBe(202);
    const raw = handle
      .prepare('SELECT native_category_id AS n FROM product_raw WHERE store_sku = ?')
      .get('n-empty') as { n: string | null };
    expect(raw.n).toBeNull();
  });
});

describe('POST /ingest — invalid request writes nothing, no background (4.2)', () => {
  it.each([
    ['missing store', { ...CLEAN, storeSku: 'x' }],
    ['missing storeSku', { ...CLEAN, store: 'sam' }],
    ['empty store', { ...CLEAN, store: '', storeSku: 'x' }],
    ['empty storeSku', { ...CLEAN, store: 'sam', storeSku: '' }],
    ['whitespace store', { ...CLEAN, store: '   ', storeSku: 'x' }],
    ['whitespace storeSku', { ...CLEAN, store: 'sam', storeSku: '\t ' }],
    ['empty title', { title: '', price: 5, store: 'sam', storeSku: 'x' }],
    ['NaN price', { title: '可乐 330ml', price: Number.NaN, store: 'sam', storeSku: 'x' }],
    ['Infinity price', { title: '可乐 330ml', price: Infinity, store: 'sam', storeSku: 'x' }],
  ])('%s -> 400 invalid-request, no rows, background never scheduled', async (_name, body) => {
    const { repo, handle } = openRepo();
    const scheduleBackground = vi.fn(syncBackground);
    const { res, json } = await ingest({
      port: throwingPort,
      makeRepo: () => repo,
      body,
      scheduleBackground,
    });
    expect(res.status).toBe(400);
    expect(json.error).toBe('invalid-request');
    // 400 fires before any write AND before the background is scheduled.
    expect(countRows(handle, 'product_raw')).toBe(0);
    expect(countRows(handle, 'product')).toBe(0);
    expect(countRows(handle, 'unit_price')).toBe(0);
    expect(scheduleBackground).not.toHaveBeenCalled();
  });
});

describe('POST /ingest — no DB -> persistence-error, no background (4.3)', () => {
  it('makeRepo returns null -> 500 persistence-error, no rawId, no background', async () => {
    const scheduleBackground = vi.fn(syncBackground);
    const { res, json } = await ingest({
      port: throwingPort,
      makeRepo: () => null,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
      scheduleBackground,
    });
    expect(res.status).toBe(500);
    expect(json.error).toBe('persistence-error');
    // raw never landed -> no rawId on the body, and no background scheduled.
    expect(json.rawId).toBeUndefined();
    expect(scheduleBackground).not.toHaveBeenCalled();
  });
});

describe('POST /ingest — background insufficient leaves raw, no product (4.4)', () => {
  it('no-shape title + transport fail -> 202+rawId; raw landed, product absent; LLM called once', async () => {
    // "农夫山泉" has no tier1 shape; a transport-failing port leaves nothing to
    // judge -> insufficient. The background logs and stops (no saveParsed).
    const { repo, handle } = openRepo();
    const llmParse = vi.fn(transportFailPort.parse);
    const { res, json } = await ingest({
      port: { parse: llmParse },
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(202);
    expect(typeof json.rawId).toBe('string');
    expect(json.rawId.length).toBeGreaterThan(0);
    // "raw, no product" intermediate state: raw landed, product/unit_price not.
    expect(countRows(handle, 'product_raw')).toBe(1);
    expect(countRows(handle, 'product')).toBe(0);
    expect(countRows(handle, 'unit_price')).toBe(0);
    // No retry / no LLM re-burn: the background parses exactly once.
    expect(llmParse).toHaveBeenCalledTimes(1);
  });
});

describe('POST /ingest — background config-error leaves raw, no product (4.5)', () => {
  it('non-determinate title + config fail -> 202; no saveParsed, no retry', async () => {
    // "农夫山泉" is non-determinate so orchestrate enters tier2; the config port
    // makes it a config-error in the background -> log only, no saveParsed.
    const { repo, handle } = openRepo();
    const llmParse = vi.fn(configFailPort.parse);
    const { res, json } = await ingest({
      port: { parse: llmParse },
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(202);
    expect(typeof json.rawId).toBe('string');
    expect(countRows(handle, 'product_raw')).toBe(1);
    expect(countRows(handle, 'product')).toBe(0); // not saveParsed on config-error
    expect(llmParse).toHaveBeenCalledTimes(1); // no retry
  });
});

describe('POST /ingest — background saveParsed throws leaves raw, no product (4.5b)', () => {
  it('upsertRaw ok, saveParsed throws -> 202+rawId; raw landed, product absent, saveParsed called once', async () => {
    // Inject a repo where upsertRaw succeeds (raw lands) but saveParsed throws.
    // CLEAN is tier1-computable -> the ok branch reaches saveParsed. The
    // background self-wraps try/catch and swallows the throw, so the failure is
    // OBSERVED by the terminal state (raw present, product absent), not a reject.
    const upsertRaw = vi.fn(async () => 'raw-xyz');
    const saveParsed = vi.fn(async () => {
      throw new Error('boom');
    });
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

    const { res, json } = await ingest({
      port: throwingPort, // CLEAN tier1-sufficient -> ok branch -> saveParsed
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
    });
    expect(res.status).toBe(202);
    expect(json.rawId).toBe('raw-xyz');
    // upsertRaw ran (raw landed) but saveParsed threw (product not persisted).
    expect(upsertRaw).toHaveBeenCalledTimes(1);
    expect(saveParsed).toHaveBeenCalledTimes(1); // attempted once, no retry
  });
});

describe('POST /ingest — uncomputable product still lands in background (4.6)', () => {
  it('non-volume unit (ok, per100ml=null) -> 202; product + unit_price landed, per100ml NULL', async () => {
    // "大米 2kg": tier1 extracts a weight (non-volume) -> certain null, tier2
    // skipped (throwingPort never reached). Still a valid, persisted data point.
    const { repo, handle } = openRepo();
    const { res, json } = await ingest({
      port: throwingPort,
      makeRepo: () => repo,
      body: { title: '大米 2kg', price: 30, store: 'sam', storeSku: 'rice-2kg' },
    });
    expect(res.status).toBe(202);
    expect(typeof json.rawId).toBe('string');
    expect(countRows(handle, 'product')).toBe(1);
    expect(countRows(handle, 'unit_price')).toBe(1);
    const up = handle
      .prepare('SELECT per100ml FROM unit_price')
      .get() as { per100ml: number | null };
    expect(up.per100ml).toBeNull();
  });
});

describe('POST /ingest — background failure never bubbles 503/config-error (4.7)', () => {
  // "Never 503" is NOT a tautology here: BOTH inputs would be a 503 / business
  // 500 config-error on the SYNCHRONOUS /contribute path. On /ingest the same
  // background-failure states must still return 202 (failure stays in the
  // background, never reaching the request path).
  it('a background-insufficient report still returns 202 (not 503)', async () => {
    const { repo } = openRepo();
    const { res } = await ingest({
      port: transportFailPort, // no-shape title + transport fail -> insufficient
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(202);
    expect(res.status).not.toBe(503);
  });

  it('a background-config-error report still returns 202 (not business 500 config-error)', async () => {
    const { repo } = openRepo();
    const { res, json } = await ingest({
      port: configFailPort, // non-determinate title -> tier2 -> config-error
      makeRepo: () => repo,
      body: { title: '农夫山泉', price: 5, store: 'sam', storeSku: 'nfsq' },
    });
    expect(res.status).toBe(202);
    expect(res.status).not.toBe(500);
    expect(json.error).toBeUndefined(); // no business error code in the body
  });
});

describe('POST /ingest — non-blocking fire-and-forget (5.4)', () => {
  it('fire-and-forget port + a never-resolving run -> 202 returns immediately', async () => {
    // Fire-and-forget port: call run() but DO NOT await it (mirrors production
    // waitUntil "don't wait for the background" semantics). With a never-
    // resolving run, the handler's `await scheduleBackground` must still resolve
    // immediately so the 202 lands — proving the await does NOT block on run().
    // MUST NOT use the sync port here: `await run()` on a never-resolving run
    // would self-deadlock. The pending promise never rejects (no unhandled
    // rejection warning), it only stays pending.
    const { repo } = openRepo();
    const neverResolves = () => new Promise<void>(() => {});
    const fireAndForget = (
      _c: Context<AppEnv>,
      run: () => Promise<void>,
    ): void => {
      void run();
    };
    const res = await ingest({
      port: throwingPort,
      makeRepo: () => repo,
      body: { ...CLEAN, store: 'sam', storeSku: 'coke-24' },
      scheduleBackground: (c, _run) => fireAndForget(c, neverResolves),
    });
    expect(res.res.status).toBe(202);
    expect(typeof res.json.rawId).toBe('string');
    expect(res.json.rawId.length).toBeGreaterThan(0);
  });
});

// ── Governance regression on /ingest (5.1 / 5.2) ───────────────────────────
const VALID_KEY = 'key-alpha';

/** Map-backed fake KVNamespace (get/put with TTL semantics), like the other
 *  governance tests. Returns the put spy for usage-count assertions. */
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

/**
 * Build an /ingest app with REAL governance, spy-wrapped repo + LLM factories,
 * and a spy background port, so auth assertions can prove the ingest pipeline
 * (upsertRaw / LLM / background scheduling) is NOT entered when auth fails.
 */
function appWithSpies(env: Bindings) {
  const upsertRaw = vi.fn(async () => 'raw-id');
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
  const makeRepo = vi.fn(() => repo);
  const llmParse = vi.fn(async (): Promise<ParseResult> => ({ ok: true, spec: {} as any }));
  const makeLlm = vi.fn(() => ({ parse: llmParse }) as SpecParserLLM);
  const scheduleBackground = vi.fn(syncBackground);

  const app = createApp({
    makeLlm,
    governance: createRealGovernance(),
    makeRepo,
    scheduleBackground,
  });
  const request = (init: RequestInit) => app.request('/ingest', init, env);
  return { request, upsertRaw, saveParsed, makeLlm, llmParse, makeRepo, scheduleBackground };
}

const cleanIngestBody = JSON.stringify({ ...CLEAN, store: 'sam', storeSku: 'coke-24' });

describe('governance — /ingest auth gate (5.1)', () => {
  it('missing key -> 401 auth-missing; upsertRaw, LLM, and background never engaged', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { request, upsertRaw, makeLlm, llmParse, scheduleBackground } = appWithSpies(env);
    const res = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: cleanIngestBody,
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('auth-missing');
    // Auth short-circuits BEFORE the ingest pipeline + background scheduling.
    expect(upsertRaw).not.toHaveBeenCalled();
    expect(makeLlm).not.toHaveBeenCalled();
    expect(llmParse).not.toHaveBeenCalled();
    expect(scheduleBackground).not.toHaveBeenCalled();
  });
});

describe('governance — /ingest forbidden / admit+usage / rate-limit / health (5.2)', () => {
  it('unregistered key -> 403 auth-forbidden; ingest + background not entered', async () => {
    const { kv } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { request, upsertRaw, llmParse, scheduleBackground } = appWithSpies(env);
    const res = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer key-not-registered' },
      body: cleanIngestBody,
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('auth-forbidden');
    expect(upsertRaw).not.toHaveBeenCalled();
    expect(llmParse).not.toHaveBeenCalled();
    expect(scheduleBackground).not.toHaveBeenCalled();
  });

  it('valid key -> 202 admitted, usage count increments EXACTLY once (not double-counted by the background)', async () => {
    const { kv, put } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const { request, upsertRaw } = appWithSpies(env);
    const res = await request({
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
      body: cleanIngestBody,
    });
    expect(res.status).toBe(202);
    expect(upsertRaw).toHaveBeenCalledTimes(1);
    // Admission counts usage exactly once at the gate. The background work
    // (which runs AFTER admission) must NOT write another usage record.
    const usageWrites = put.mock.calls.filter(([k]) => String(k) === `usage:${VALID_KEY}`);
    expect(usageWrites).toHaveLength(1);
    expect(JSON.parse(String(usageWrites[0][1])).count).toBe(1);
  });

  it('over-limit -> 429; raw not landed, background not scheduled', async () => {
    const fixedNow = 5_000_000;
    const { kv } = makeFakeKV({ now: () => fixedNow });
    const windowStart = fixedNow - (fixedNow % RATE_LIMIT_WINDOW_SECONDS);
    await kv.put(`rl:${VALID_KEY}:${windowStart}`, String(RATE_LIMIT_MAX), {
      expirationTtl: RATE_LIMIT_WINDOW_SECONDS,
    });
    const spy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow * 1000);
    try {
      const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
      const { request, upsertRaw, scheduleBackground } = appWithSpies(env);
      const res = await request({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${VALID_KEY}` },
        body: cleanIngestBody,
      });
      expect(res.status).toBe(429);
      expect((await res.json()).error).toBe('rate-limited');
      expect(upsertRaw).not.toHaveBeenCalled();
      expect(scheduleBackground).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it('/health stays exempt from the governance chain (200, no KV access)', async () => {
    const { kv, get, put } = makeFakeKV();
    const env = { API_KEYS: VALID_KEY, GOVERNANCE_KV: kv } as unknown as Bindings;
    const app = createApp({
      makeLlm: () => throwingPort,
      governance: createRealGovernance(),
      makeRepo: () => null,
      scheduleBackground: syncBackground,
    });
    const res = await app.request('/health', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });
});
