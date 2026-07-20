import { describe, it, expect } from 'vitest';
import { vi } from 'vitest';
import type { RankingsItem } from '@unit-price/api-client';

// RankingRow.tsx imports @tarojs/components (View/Text) at module load — its weapp
// runtime does not exist under vitest. We only exercise the PURE, exported derivations
// (isStale / historicalLowYuan / STALE_AFTER_MS), never the JSX, so stub the components
// to a no-op module (same pattern as boardCache.test.ts stubbing @tarojs/taro). The CSS
// import resolves to an empty module under vitest natively.
vi.mock('@tarojs/components', () => ({ View: () => null, Text: () => null }));

import { isStale, historicalLowYuan, STALE_AFTER_MS } from './RankingRow';

// A schema-valid RankingsItem; overrides layer the field(s) under test. capturedAt /
// lowestPriceCents are .optional() in the api-client contract — parseRankingsResponse's
// tolerance of missing fields is covered in packages/api-client; here we assert the
// COMPONENT's缺字段降级 (7.3): missing field → no gray, no badge, no crash.
const item = (over: Partial<RankingsItem> = {}): RankingsItem => ({
  rank: 1,
  title: '可乐 330ml×24',
  priceCents: 1490,
  per100ml: 1.51,
  formula: '1490 / (330*24) * 100',
  confidence: 0.9,
  warnings: [],
  store: 'sam',
  storeSku: 'spu-123',
  sourceUrl: null,
  capturedAt: 1_700_000_000_000,
  lowestPriceCents: 990,
  ...over,
});

const NOW = 1_800_000_000_000; // fixed clock so boundary math is deterministic

describe('isStale — 缺 capturedAt 降级 + 30 天边界', () => {
  it('① capturedAt 为 undefined → 非失效(缺字段降级,不置灰)', () => {
    expect(isStale(item({ capturedAt: undefined }), NOW)).toBe(false);
  });

  it('⑤ now - capturedAt 刚过 STALE_AFTER_MS → 失效', () => {
    expect(isStale(item({ capturedAt: NOW - STALE_AFTER_MS - 1 }), NOW)).toBe(true);
  });

  it('⑤ now - capturedAt 恰为 STALE_AFTER_MS(严格 >,正好 30 天)→ 不失效', () => {
    expect(isStale(item({ capturedAt: NOW - STALE_AFTER_MS }), NOW)).toBe(false);
  });

  it('⑤ now - capturedAt 刚不到 STALE_AFTER_MS → 不失效', () => {
    expect(isStale(item({ capturedAt: NOW - STALE_AFTER_MS + 1 }), NOW)).toBe(false);
  });
});

describe('historicalLowYuan — 缺 lowestPriceCents 降级 + 现价 vs 历史低点', () => {
  it('② lowestPriceCents 为 undefined → 无徽标(null,缺字段降级)', () => {
    expect(historicalLowYuan(item({ lowestPriceCents: undefined }))).toBeNull();
  });

  it('③ priceCents > lowestPriceCents(1490 > 990)→ 徽标 "9.90"', () => {
    expect(historicalLowYuan(item({ priceCents: 1490, lowestPriceCents: 990 }))).toBe('9.90');
  });

  it('④ priceCents === lowestPriceCents(990 / 990)→ 无徽标(现价即历史低点,免噪)', () => {
    expect(historicalLowYuan(item({ priceCents: 990, lowestPriceCents: 990 }))).toBeNull();
  });
});

describe('缺二字段的旧响应整体降级 — 无灰、无徽标、不崩', () => {
  it('capturedAt 与 lowestPriceCents 皆 undefined → 非失效且无徽标', () => {
    const stale = item({ capturedAt: undefined, lowestPriceCents: undefined });
    expect(isStale(stale, NOW)).toBe(false);
    expect(historicalLowYuan(stale)).toBeNull();
  });
});
