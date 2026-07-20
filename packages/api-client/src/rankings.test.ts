import { describe, it, expect } from 'vitest';
import { ZodError } from 'zod';
import { RankingsResponseSchema, type RankingsItem } from './rankings.js';
import { parseRankingsResponse } from './client.js';
import { ComputeResultSchema, type ComputeResult } from './compute.js';

// A full valid ranking row WITH the two new optional fields present (the shape
// the ONLINE server projection always emits).
const fullItem: RankingsItem = {
  rank: 1,
  title: '可乐 330ml*24',
  priceCents: 4000,
  per100ml: 0.505,
  formula: '40 / (330 * 24 * 1) * 100',
  confidence: 0.95,
  warnings: [],
  store: 'sam',
  storeSku: 'sku-1',
  sourceUrl: null,
  capturedAt: 1_700_000_000_000,
  lowestPriceCents: 3900,
};

// The SAME row minus capturedAt/lowestPriceCents — a cross-version OLD server or
// a CDN-cached OLD response that predates the two fields.
const { capturedAt: _c, lowestPriceCents: _l, ...legacyItem } = fullItem;

// A valid compute result reusing RankingsItemSchema for `neighbors`.
const validResult: ComputeResult = {
  per100ml: 0.505,
  per100g: null,
  formula: '40 / (330 * 24 * 1) * 100',
  axis: 'per_100ml',
  rank: 1,
  total: 42,
  percentile: 0,
  neighbors: [fullItem],
};

describe('RankingsItem capturedAt/lowestPriceCents optionality', () => {
  it('parses a row WITH both fields present (online response)', () => {
    expect(RankingsResponseSchema.parse([fullItem])).toEqual([fullItem]);
  });

  it('parses a row MISSING both fields (old server / CDN old cache → no ZodError)', () => {
    expect(RankingsResponseSchema.parse([legacyItem])).toEqual([legacyItem]);
  });

  it('parseRankingsResponse (jitless) also tolerates the missing-fields row', () => {
    expect(parseRankingsResponse([legacyItem])).toEqual([legacyItem]);
  });

  it('rejects a string capturedAt (present ⇒ must be integer epoch ms)', () => {
    const bad: unknown = [{ ...fullItem, capturedAt: '1700000000000' }];
    expect(() => RankingsResponseSchema.parse(bad)).toThrow(ZodError);
    expect(() => parseRankingsResponse(bad)).toThrow(ZodError);
  });

  it('rejects a decimal capturedAt (present ⇒ must be integer)', () => {
    const bad: unknown = [{ ...fullItem, capturedAt: 1_700_000_000_000.5 }];
    expect(() => RankingsResponseSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a string lowestPriceCents (present ⇒ must be integer cents)', () => {
    const bad: unknown = [{ ...fullItem, lowestPriceCents: '3900' }];
    expect(() => RankingsResponseSchema.parse(bad)).toThrow(ZodError);
    expect(() => parseRankingsResponse(bad)).toThrow(ZodError);
  });

  it('rejects a decimal lowestPriceCents (present ⇒ must be integer)', () => {
    const bad: unknown = [{ ...fullItem, lowestPriceCents: 39.5 }];
    expect(() => RankingsResponseSchema.parse(bad)).toThrow(ZodError);
  });
});

describe('ComputeResultSchema neighbors reuse RankingsItemSchema (same optionality)', () => {
  it('accepts a neighbor MISSING both fields (optionality propagates to /compute)', () => {
    const res = { ...validResult, neighbors: [legacyItem] };
    expect(ComputeResultSchema.parse(res)).toEqual(res);
  });

  it('rejects a neighbor with a non-integer capturedAt (integrality propagates)', () => {
    const bad = { ...validResult, neighbors: [{ ...fullItem, capturedAt: 1.5 }] };
    expect(() => ComputeResultSchema.parse(bad)).toThrow(ZodError);
  });

  it('rejects a neighbor with a string lowestPriceCents', () => {
    const bad = { ...validResult, neighbors: [{ ...fullItem, lowestPriceCents: '3900' }] };
    expect(() => ComputeResultSchema.parse(bad)).toThrow(ZodError);
  });
});
