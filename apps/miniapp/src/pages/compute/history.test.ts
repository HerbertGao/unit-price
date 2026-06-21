import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComputeRequest } from '@unit-price/api-client';

// history.ts imports @tarojs/taro for get/setStorageSync. Stub it with a stateful
// in-memory store so the ring-buffer/filter/dedupe logic runs under vitest without
// the native runtime. `__store` is the raw value (set directly for坏数据 tests).
// NOTE (per design): the weapp-only jitless failure is NOT covered here — vitest
// runs with Zod's JIT enabled, so safeParse stays green either way; jitless正确性
// is checked by the devtools实测 (task 4.2). These tests assert ring/filter/dedupe.
const store = new Map<string, unknown>();
vi.mock('@tarojs/taro', () => ({
  default: {
    getStorageSync: (k: string) => (store.has(k) ? store.get(k) : ''),
    setStorageSync: (k: string, v: unknown) => store.set(k, v),
  },
}));

import {
  readHistory,
  appendHistory,
  summarizeInput,
  findHistoryByTs,
  HISTORY_KEY,
  HISTORY_MAX,
  type HistoryItem,
} from './history';

// — fixtures —
/** A complete unit-path request (unitSize + quantity). */
const unitReq = (over: Partial<ComputeRequest> = {}): ComputeRequest => ({
  totalPrice: 12,
  quantity: 24,
  unitSize: { value: 330, unit: 'ml' },
  category: 'soft-drink',
  ...over,
});

/** A complete total-path request (totalAmount, no quantity). */
const totalReq = (over: Partial<ComputeRequest> = {}): ComputeRequest => ({
  totalPrice: 12,
  totalAmount: { value: 7920, unit: 'ml' },
  category: 'soft-drink',
  ...over,
});

const item = (input: ComputeRequest, ts: number, summary = 's'): HistoryItem => ({
  input,
  summary,
  ts,
});

/** Set the raw storage value directly (bypassing append) for坏数据 tests. */
const seedRaw = (v: unknown) => store.set(HISTORY_KEY, v);

beforeEach(() => store.clear());
afterEach(() => vi.useRealTimers());

describe('appendHistory — ring buffer (newest-first, drop oldest)', () => {
  it('① 写满 20 后第 21 条令最旧被切、最新在 index 0 (覆盖方向, not just length)', () => {
    // Seed 20 distinct requests; tag each via totalPrice so we can track identity.
    for (let i = 0; i < HISTORY_MAX; i++) {
      appendHistory(unitReq({ totalPrice: i + 1 }), `s${i}`);
    }
    let h = readHistory();
    expect(h).toHaveLength(HISTORY_MAX);
    // newest written (totalPrice=20) is at index 0, oldest (totalPrice=1) at end
    expect(h[0].input.totalPrice).toBe(20);
    expect(h[HISTORY_MAX - 1].input.totalPrice).toBe(1);

    // 21st distinct write: newest in front, the OLDEST (totalPrice=1) is切尾-dropped
    appendHistory(unitReq({ totalPrice: 99 }), 's99');
    h = readHistory();
    expect(h).toHaveLength(HISTORY_MAX);
    expect(h[0].input.totalPrice).toBe(99); // newest at index 0
    expect(h.some((x) => x.input.totalPrice === 1)).toBe(false); // oldest gone
    expect(h.some((x) => x.input.totalPrice === 2)).toBe(true); // second-oldest survives
  });
});

describe('readHistory — robustness: bad container + bad items filtered/deduped', () => {
  it('② non-array container → []  (no .map on a corrupt value)', () => {
    seedRaw({ not: 'an array' });
    expect(readHistory()).toEqual([]);
    seedRaw('garbage-string');
    expect(readHistory()).toEqual([]);
    seedRaw(null);
    expect(readHistory()).toEqual([]);
  });

  it('② bad items (missing fields / summary非字符串 / ts非安全正整数 / 退化项) → 合法子集', () => {
    const good = item(unitReq(), 100, 'keep');
    seedRaw([
      good,
      { input: unitReq(), ts: 101 }, // missing summary
      { input: unitReq(), summary: 42, ts: 102 }, // summary not string
      { input: unitReq(), summary: 's', ts: 0 }, // ts not positive
      { input: unitReq(), summary: 's', ts: -5 }, // ts negative
      { input: unitReq(), summary: 's', ts: 1.5 }, // ts not integer
      { input: unitReq(), summary: 's', ts: Number.MAX_SAFE_INTEGER + 2 }, // unsafe
      { summary: 's', ts: 103 }, // missing input
      { input: { totalPrice: 12, category: 'x' }, summary: 's', ts: 104 }, // 退化: neither amount
      null,
      'string-item',
    ]);
    expect(readHistory()).toEqual([good]);
  });

  it('② duplicate ts → keep the FIRST occurrence only', () => {
    const first = item(unitReq({ totalPrice: 1 }), 200, 'first');
    const dup = item(unitReq({ totalPrice: 2 }), 200, 'second');
    seedRaw([first, dup]);
    const h = readHistory();
    expect(h).toHaveLength(1);
    expect(h[0]).toEqual(first); // first wins
  });
});

describe('appendHistory — dedupe same input (recompute moves to front, no growth)', () => {
  it('③ writing the same input again does not grow, moves it to the front', () => {
    appendHistory(unitReq({ totalPrice: 1 }), 'a');
    appendHistory(unitReq({ totalPrice: 2 }), 'b');
    appendHistory(unitReq({ totalPrice: 3 }), 'c');
    expect(readHistory()).toHaveLength(3);

    // re-write the OLDEST (totalPrice=1) input → length unchanged, it jumps to front
    appendHistory(unitReq({ totalPrice: 1 }), 'a2');
    const h = readHistory();
    expect(h).toHaveLength(3);
    expect(h[0].input.totalPrice).toBe(1);
    expect(h[0].summary).toBe('a2');
    // no duplicate of totalPrice=1 remains
    expect(h.filter((x) => x.input.totalPrice === 1)).toHaveLength(1);
  });
});

describe('appendHistory — ts monotonic & unique', () => {
  it('④ two DIFFERENT inputs in the same millisecond get distinct ts', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    appendHistory(unitReq({ totalPrice: 1 }), 'a');
    appendHistory(unitReq({ totalPrice: 2 }), 'b'); // same Date.now()
    const h = readHistory();
    expect(h).toHaveLength(2);
    expect(h[0].ts).not.toBe(h[1].ts);
    expect(h[0].ts).toBeGreaterThan(h[1].ts); // newest has the larger ts
  });

  it('⑥ replacing the newest duplicate: new ts > remaining max even if clock not advanced', () => {
    vi.useFakeTimers();
    // First write at t=500 → ts=500.
    vi.setSystemTime(new Date(500));
    appendHistory(unitReq({ totalPrice: 1 }), 'a'); // ts=500
    // Second DIFFERENT write at same clock → ts = max(500, 500+1) = 501.
    appendHistory(unitReq({ totalPrice: 2 }), 'b'); // ts=501 (the newest)
    let h = readHistory();
    const newestTs = h[0].ts; // 501
    expect(newestTs).toBe(501);
    expect(h[1].ts).toBe(500);

    // Now RE-write the NEWEST input (totalPrice=2) while clock is BELOW its ts.
    // prevMaxTs is taken BEFORE dedupe → still 501, so new ts = 502 > remaining max(500).
    vi.setSystemTime(new Date(300)); // clock NOT greater than old ts
    appendHistory(unitReq({ totalPrice: 2 }), 'b2');
    h = readHistory();
    expect(h).toHaveLength(2);
    expect(h[0].input.totalPrice).toBe(2);
    expect(h[0].ts).toBe(502); // > prevMaxTs(501), strictly monotonic
    expect(h[0].ts).toBeGreaterThan(h[1].ts); // > the remaining item's ts (500)
  });
});

describe('readHistory — ⑤ 正向保留 + 退化丢弃 (complete required set guard)', () => {
  it('keeps a valid unitSize+quantity row AND a totalAmount row; drops unitSize-no-quantity AND neither', () => {
    seedRaw([
      item(unitReq(), 10, 'unit-ok'), // unitSize + quantity → KEEP
      item(totalReq(), 11, 'total-ok'), // totalAmount → KEEP
      // unitSize WITHOUT quantity → passes schema (quantity optional) but degenerate → DROP
      item(
        { totalPrice: 12, unitSize: { value: 330, unit: 'ml' }, category: 'soft-drink' },
        12,
        'unit-no-qty',
      ),
      // neither amount field → DROP
      item({ totalPrice: 12, category: 'soft-drink' }, 13, 'neither'),
    ]);
    const h = readHistory();
    expect(h.map((x) => x.summary)).toEqual(['unit-ok', 'total-ok']);
  });
});

describe('summarizeInput & findHistoryByTs', () => {
  it('summary includes the cohort display name (not the slug)', () => {
    const s = summarizeInput(unitReq(), '软饮');
    expect(s).toContain('软饮');
    expect(s).not.toContain('soft-drink');
    expect(s).toContain('12'); // totalPrice
    expect(s).toContain('330ml'); // unitSize
  });

  it('total-path summary uses totalAmount', () => {
    const s = summarizeInput(totalReq(), '软饮');
    expect(s).toContain('7920ml');
  });

  it('findHistoryByTs returns the matching item, undefined when absent', () => {
    appendHistory(unitReq({ totalPrice: 1 }), 'a');
    const h = readHistory();
    const ts = h[0].ts;
    expect(findHistoryByTs(ts)?.summary).toBe('a');
    expect(findHistoryByTs(ts + 999)).toBeUndefined();
  });
});

describe('appendHistory — write failure is swallowed (history lost, no throw)', () => {
  it('a throwing setStorageSync does not bubble (compute result must still show)', async () => {
    const Taro = (await import('@tarojs/taro')).default;
    const spy = vi
      .spyOn(Taro, 'setStorageSync')
      .mockImplementation(() => {
        throw new Error('quota full');
      });
    expect(() => appendHistory(unitReq(), 'a')).not.toThrow();
    spy.mockRestore();
  });
});
