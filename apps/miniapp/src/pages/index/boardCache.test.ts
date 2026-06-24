import { describe, it, expect, vi, beforeEach } from 'vitest';
import Taro from '@tarojs/taro';
import type { RankingsItem } from '@unit-price/api-client';

// boardCache.ts imports @tarojs/taro for get/setStorageSync. Stub it with a
// stateful in-memory store so the read re-validation / write-swallow logic runs
// under vitest without the native runtime. `seedRaw` sets the raw value directly
// (for坏数据 tests). NOTE (per design): the weapp-only jitless failure is NOT
// covered here — vitest runs with Zod's JIT enabled, so parseRankingsResponse
// stays green either way; jitless正确性 is checked by devtools实测.
const store = new Map<string, unknown>();
vi.mock('@tarojs/taro', () => ({
  default: {
    getStorageSync: (k: string) => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k: string, v: unknown) => store.set(k, v),
  },
}));

import {
  readBoard,
  writeBoard,
  cohortKeyFor,
  DEFAULT_COHORT_KEY,
} from './boardCache';

// — fixtures —
/** A schema-valid RankingsItem (every field present and well-typed). */
const itemFixture = (over: Partial<RankingsItem> = {}): RankingsItem => ({
  rank: 1,
  title: '可乐 330ml×24',
  priceCents: 1200,
  per100ml: 1.51,
  formula: '1200 / (330*24) * 100',
  confidence: 0.9,
  warnings: [],
  store: 'sam',
  storeSku: 'spu-123',
  sourceUrl: null,
  ...over,
});

const seedRaw = (cohortKey: string, v: unknown) =>
  store.set(`rankings:board:${cohortKey}`, v);

beforeEach(() => store.clear());

describe('cohortKeyFor / DEFAULT_COHORT_KEY', () => {
  it('keys on the client category input, undefined → sentinel (not soft-drink)', () => {
    expect(cohortKeyFor(undefined)).toBe(DEFAULT_COHORT_KEY);
    expect(cohortKeyFor('dairy')).toBe('dairy');
    expect(DEFAULT_COHORT_KEY).not.toBe('soft-drink');
  });
});

describe('writeBoard ↔ readBoard — valid snapshot roundtrip', () => {
  it('a written snapshot reads back equal (validated)', () => {
    const items = [itemFixture({ rank: 1 }), itemFixture({ rank: 2, title: '雪碧' })];
    writeBoard('dairy', items);
    expect(readBoard('dairy')).toEqual(items);
  });

  it('default cohort roundtrips under the sentinel key', () => {
    const items = [itemFixture()];
    writeBoard(DEFAULT_COHORT_KEY, items);
    expect(readBoard(DEFAULT_COHORT_KEY)).toEqual(items);
  });

  it('an empty snapshot is a valid hit ([], not null — server returns [] legitimately)', () => {
    writeBoard('dairy', []);
    expect(readBoard('dairy')).toEqual([]);
  });

  it('cohort keys are isolated — reading a different cohort misses', () => {
    writeBoard('dairy', [itemFixture()]);
    expect(readBoard('spirits')).toBeNull();
  });
});

describe('readBoard — fail-closed on corrupt bodies → null', () => {
  it('never-written / non-array container → null (no validate on a non-array)', () => {
    expect(readBoard('dairy')).toBeNull(); // never written → '' → null
    seedRaw('dairy', { not: 'an array' });
    expect(readBoard('dairy')).toBeNull();
    seedRaw('dairy', 'garbage-string');
    expect(readBoard('dairy')).toBeNull();
    seedRaw('dairy', null);
    expect(readBoard('dairy')).toBeNull();
  });

  it('array with a stale-schema row (missing required field) → null', () => {
    const { formula: _drop, ...stale } = itemFixture();
    seedRaw('dairy', [stale]);
    expect(readBoard('dairy')).toBeNull();
  });

  it('array with a dirty field (wrong type) → null', () => {
    seedRaw('dairy', [itemFixture(), { ...itemFixture(), per100ml: 'NaN-string' }]);
    expect(readBoard('dairy')).toBeNull();
  });

  it('getStorageSync throws → null (no bubble)', () => {
    const spy = vi
      .spyOn(Taro, 'getStorageSync')
      .mockImplementationOnce(() => {
        throw new Error('storage unavailable');
      });
    let result: RankingsItem[] | null = [itemFixture()];
    expect(() => {
      result = readBoard('dairy');
    }).not.toThrow();
    expect(result).toBeNull();
    spy.mockRestore();
  });
});

describe('writeBoard — write failure is swallowed (cache lost, no throw)', () => {
  it('a throwing setStorageSync does not bubble (render must not block)', () => {
    const spy = vi.spyOn(Taro, 'setStorageSync').mockImplementation(() => {
      throw new Error('quota full');
    });
    expect(() => writeBoard('dairy', [itemFixture()])).not.toThrow();
    spy.mockRestore();
  });
});
