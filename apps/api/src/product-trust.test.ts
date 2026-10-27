import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { ParsedSpec } from '@unit-price/core';
import { parseProductTrust } from '@unit-price/api-client';
import type { BoardSnapshotCategoryNode, BoardSnapshotRow, Repository } from '@unit-price/db';
import type { Bindings } from './bindings.js';
import { createNoopGovernance, createRealGovernance } from './governance.js';
import type { SpecParserLLM } from './llm.js';
import { TRUST_NOTES } from './product-trust.js';
import { createApp } from './routes.js';

const throwingPort: SpecParserLLM = {
  async parse() {
    throw new Error('trust read must not call the LLM');
  },
};

const SPEC: ParsedSpec = {
  unitSize: { value: 330, unit: 'ml' },
  quantity: 24,
  multipliers: [1],
  totalAmount: null,
  packageUnit: null,
  category: 'beverage',
  confidence: 0.2,
};

function row(
  over: Partial<BoardSnapshotRow> & Pick<BoardSnapshotRow, 'id' | 'per100ml'>,
): BoardSnapshotRow {
  return {
    formula: 'stored-formula',
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

const NODES: BoardSnapshotCategoryNode[] = [
  { slug: 'beverage', name: '饮料', parentSlug: null, comparableUnit: null, rankable: false },
  { slug: 'soft-drink', name: '软饮', parentSlug: 'beverage', comparableUnit: 'per_100ml', rankable: true },
  { slug: 'carbonated', name: '碳酸饮料', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true },
  { slug: 'juice-plant', name: '果汁植物饮', parentSlug: 'soft-drink', comparableUnit: 'per_100ml', rankable: true },
  { slug: 'tissue', name: '纸巾', parentSlug: 'beverage', comparableUnit: 'per_100sheet', rankable: true },
];

function trustApp(
  rows: BoardSnapshotRow[],
  opts: { spec?: ParsedSpec | null; specThrows?: boolean; snapshotThrows?: boolean } = {},
) {
  const getStoredSpecByUnitPriceId = vi.fn(async () => {
    if (opts.specThrows) throw new Error('corrupt spec');
    return opts.spec === undefined ? SPEC : opts.spec;
  });
  const listBoardSnapshot = vi.fn(async () => {
    if (opts.snapshotThrows) throw new Error('db down');
    return { rows, categoryNodes: NODES, excluded: [] };
  });
  const repo = {
    async upsertRaw() {
      throw new Error('trust is read-only');
    },
    async saveParsed() {
      throw new Error('trust is read-only');
    },
    async getProduct() {
      throw new Error('trust is read-only');
    },
    async saveCorrection() {
      throw new Error('trust is read-only');
    },
    listBoardSnapshot,
    getStoredSpecByUnitPriceId,
  } as unknown as Repository;
  const app = createApp({
    makeLlm: () => throwingPort,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { app, getStoredSpecByUnitPriceId, listBoardSnapshot };
}

const BOARD: BoardSnapshotRow[] = [
  row({ id: 'ml-1', per100ml: 0.505, formula: '40 / (330 * 24 * 1) * 100', priceCents: 1000 }),
  row({ id: 'ml-2a', per100ml: 2 }),
  row({ id: 'ml-2b', per100ml: 2, categorySlugs: ['juice-plant'] }),
  row({ id: 'ml-3', per100ml: 5.5, warnings: ['数量按单件推断为 1'] }),
];

describe('GET /products/:id', () => {
  it('returns stored per100ml and formula, not a price×size recompute', async () => {
    const { app } = trustApp(BOARD);
    const res = await app.request('/products/ml-1?cohort=soft-drink');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = parseProductTrust(await res.json());
    expect(body.per100ml).toBe(0.505);
    expect(body.formula).toBe('40 / (330 * 24 * 1) * 100');
    expect(body.confidence).toBe(0.95);
    expect(body.specs.unitSize).toEqual({ value: 330, unit: 'ml' });
    expect(body.specs.totalAmount).toBeNull();
    expect(body.specs.quantity).toBe(24);
    expect(body).not.toHaveProperty('per100g');
    const recomputed = (1000 / 100) / (330 * 24) * 100;
    expect(body.per100ml).not.toBeCloseTo(recomputed);
    // soft-drink contains carbonated + juice-plant, server order.
    expect(body.cohort).toMatchObject({
      status: 'ready',
      slug: 'soft-drink',
      name: '软饮',
      rank: 1,
      total: 4,
      basis: 'per100ml',
      note: null,
    });
    expect(body.cohort.peers.map((p) => p.id)).toEqual(['ml-2a', 'ml-2b']);
    expect(body.cohort.peers.map((p) => p.rank)).toEqual([2, 3]);
  });

  it('keeps tie order from the snapshot instead of ranking both as 1', async () => {
    const { app } = trustApp(BOARD);
    const first = parseProductTrust(await (await app.request('/products/ml-2a?cohort=soft-drink')).json());
    const second = parseProductTrust(await (await app.request('/products/ml-2b?cohort=soft-drink')).json());
    expect(first.cohort.rank).toBe(2);
    expect(second.cohort.rank).toBe(3);
    expect(first.cohort.percentile).toBe(second.cohort.percentile);
  });

  it('uses the single per_100ml category when cohort is omitted', async () => {
    const { app } = trustApp(BOARD);
    const body = parseProductTrust(await (await app.request('/products/ml-2b')).json());
    expect(body.cohort).toMatchObject({ status: 'ready', slug: 'juice-plant', rank: 1, total: 1 });
    expect(body.cohort.peers).toEqual([]);
    expect(body.cohort.percentile).toBe(0);
  });

  it('returns partial with no numbers when several categories match and no cohort is given', async () => {
    const dual = [row({ id: 'both', per100ml: 1, categorySlugs: ['carbonated', 'juice-plant'] })];
    const { app } = trustApp(dual);
    const body = parseProductTrust(await (await app.request('/products/both')).json());
    expect(body.cohort).toEqual({
      status: 'partial',
      basis: null,
      slug: null,
      name: null,
      rank: null,
      total: null,
      percentile: null,
      peers: [],
      note: TRUST_NOTES.multiple,
    });
  });

  it('returns empty notes instead of a rank for a bad cohort', async () => {
    const { app } = trustApp(BOARD);
    const unknown = parseProductTrust(await (await app.request('/products/ml-1?cohort=nope')).json());
    expect(unknown.cohort.status).toBe('empty');
    expect(unknown.cohort.note).toBe(TRUST_NOTES.unknown);
    expect(unknown.cohort.rank).toBeNull();
    expect(unknown.per100ml).toBe(0.505);

    const cross = parseProductTrust(await (await app.request('/products/ml-1?cohort=beverage')).json());
    expect(cross.cohort.note).toBe(TRUST_NOTES.cross);

    const sheet = parseProductTrust(await (await app.request('/products/ml-1?cohort=tissue')).json());
    expect(sheet.cohort.note).toBe(TRUST_NOTES.notVolume);

    const other = parseProductTrust(await (await app.request('/products/ml-1?cohort=juice-plant')).json());
    expect(other.cohort.note).toBe(TRUST_NOTES.notMember);
  });

  it('404s unknown and admission-rejected ids without reading the spec', async () => {
    const rows = [row({ id: 'bad', per100ml: 0.1, title: '' }), row({ id: 'ok', per100ml: 0.2 })];
    const { app, getStoredSpecByUnitPriceId } = trustApp(rows);
    const missing = await app.request('/products/nope');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBeNull();
    expect(await missing.json()).toEqual({ error: 'not-found', message: '榜单里没有这件商品' });
    const rejected = await app.request('/products/bad');
    expect(rejected.status).toBe(404);
    expect(getStoredSpecByUnitPriceId).not.toHaveBeenCalled();

    const ok = parseProductTrust(await (await app.request('/products/ok?cohort=carbonated')).json());
    expect(ok.cohort.total).toBe(1);
  });

  it('maps snapshot and spec failures to 500 without an empty cohort', async () => {
    const down = trustApp(BOARD, { snapshotThrows: true });
    const readFail = await down.app.request('/products/ml-1');
    expect(readFail.status).toBe(500);
    expect((await readFail.json()).error).toBe('persistence-error');
    expect(readFail.headers.get('cache-control')).toBeNull();

    const missingSpec = trustApp(BOARD, { spec: null });
    const specRes = await missingSpec.app.request('/products/ml-1');
    expect(specRes.status).toBe(500);
    expect(await specRes.json()).toMatchObject({ error: 'persistence-error', message: 'stored spec missing' });

    const corrupt = trustApp(BOARD, { specThrows: true });
    const corruptRes = await corrupt.app.request('/products/ml-1');
    expect(corruptRes.status).toBe(500);
    expect((await corruptRes.json()).error).toBe('persistence-error');
  });

  it('does not add specs or per100g to /rankings', async () => {
    const { app } = trustApp(BOARD);
    const res = await app.request('/rankings');
    const body = await res.json();
    expect(body.rows[0].per100ml).toBe(0.505);
    expect(body.rows[0].specs).toBeUndefined();
    expect(body.rows[0].per100g).toBeUndefined();
  });

  it('is governance-exempt and does not open /parse', async () => {
    const get = vi.fn(async () => null);
    const put = vi.fn(async () => undefined);
    const kv = { get, put } as unknown as Bindings['GOVERNANCE_KV'];
    const { app } = (() => {
      const built = trustApp(BOARD);
      return {
        app: createApp({
          makeLlm: () => throwingPort,
          governance: createRealGovernance(),
          makeRepo: () =>
            ({
              listBoardSnapshot: built.listBoardSnapshot,
              getStoredSpecByUnitPriceId: built.getStoredSpecByUnitPriceId,
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
            }) as unknown as Repository,
        }),
      };
    })();
    const env = { API_KEYS: 'key-alpha', GOVERNANCE_KV: kv };
    const res = await app.request('/products/ml-1?cohort=carbonated', { method: 'GET' }, env);
    expect(res.status).toBe(200);
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    const parse = await app.request(
      '/parse',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      env,
    );
    expect(parse.status).toBe(401);
    expect((await parse.json()).error).toBe('auth-missing');
  });

  it('leaves the CDN warm list on /rankings and /categories', () => {
    const yml = readFileSync(new URL('../../../.github/workflows/cdn-warm.yml', import.meta.url), 'utf8');
    expect(yml).toContain('"${BASE}/rankings"');
    expect(yml).toContain('"${BASE}/categories"');
    expect(yml).not.toContain('/products');
  });
});
