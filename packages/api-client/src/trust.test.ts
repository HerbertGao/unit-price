import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { buildProductTrustUrl, parseProductTrust, type ProductTrust } from './trust.js';

function trust(over: Partial<ProductTrust> = {}): ProductTrust {
  return {
    id: 'up-1',
    title: '可乐 330ml*24',
    priceCents: 1000,
    lowestPriceCents: 900,
    capturedAt: 1_700_000_000_000,
    per100ml: 0.505,
    formula: '40 / (330 * 24 * 1) * 100',
    confidence: 0.95,
    warnings: [],
    store: 'sam',
    storeSku: 'sku-1',
    specs: {
      unitSize: { value: 330, unit: 'ml' },
      quantity: 24,
      multipliers: [1],
      totalAmount: null,
      packageUnit: null,
    },
    categorySlugs: ['carbonated'],
    cohort: {
      status: 'ready',
      basis: 'per100ml',
      slug: 'soft-drink',
      name: '软饮',
      rank: 1,
      total: 2,
      percentile: 50,
      peers: [{ id: 'up-2', title: '雪碧', per100ml: 2, rank: 2 }],
      note: null,
    },
    ...over,
  };
}

describe('ProductTrustSchema', () => {
  it('parses a ready payload and rejects per100g', () => {
    expect(parseProductTrust(trust())).toMatchObject({ id: 'up-1', per100ml: 0.505 });
    expect(() => parseProductTrust({ ...trust(), per100g: 1.2 })).toThrow(ZodError);
  });

  it('rejects a partial cohort that still carries a rank', () => {
    const partial = trust({
      cohort: {
        status: 'partial',
        basis: null,
        slug: null,
        name: null,
        rank: 1,
        total: null,
        percentile: null,
        peers: [],
        note: '多个品类',
      },
    });
    expect(() => parseProductTrust(partial)).toThrow(ZodError);
  });

  it('accepts an empty cohort with a note and no numbers', () => {
    const empty = trust({
      cohort: {
        status: 'empty',
        basis: null,
        slug: 'beverage',
        name: '饮料',
        rank: null,
        total: null,
        percentile: null,
        peers: [],
        note: '没有单一名次',
      },
    });
    expect(parseProductTrust(empty).cohort.status).toBe('empty');
  });

  it('rejects a peer that is the product itself', () => {
    const self = trust({
      cohort: {
        status: 'ready',
        basis: 'per100ml',
        slug: 'soft-drink',
        name: '软饮',
        rank: 1,
        total: 1,
        percentile: 0,
        peers: [{ id: 'up-1', title: '可乐 330ml*24', per100ml: 0.505, rank: 1 }],
        note: null,
      },
    });
    expect(() => parseProductTrust(self)).toThrow(ZodError);
  });
});

describe('buildProductTrustUrl', () => {
  it('omits the query when cohort is blank and encodes the id', () => {
    expect(buildProductTrustUrl('https://api.example', 'up 1')).toBe(
      'https://api.example/products/up%201',
    );
    expect(buildProductTrustUrl('https://api.example', 'up-1', '  ')).toBe(
      'https://api.example/products/up-1',
    );
  });

  it('adds an encoded cohort query', () => {
    expect(buildProductTrustUrl('https://api.example', 'a/b', 'soft drink')).toBe(
      'https://api.example/products/a%2Fb?cohort=soft%20drink',
    );
  });

  it('rejects an empty id and a dirty origin', () => {
    expect(() => buildProductTrustUrl('https://api.example', '  ')).toThrow(/non-empty/);
    expect(() => buildProductTrustUrl('https://api.example/v1', 'up-1')).toThrow(/clean origin/);
  });
});
