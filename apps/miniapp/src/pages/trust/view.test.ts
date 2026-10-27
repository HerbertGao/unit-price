import { describe, expect, it, vi } from 'vitest';
import { parseProductTrust, type ProductTrust } from '@unit-price/api-client';

vi.mock('@tarojs/components', () => ({ View: () => null, Text: () => null }));
import {
  cohortCopy,
  formatPer100ml,
  freshnessLine,
  historicalLowLine,
  specLines,
} from './view';
import { readTrustParams, trustCohortSlug, trustPageUrl } from './params';
import { acceptTrustResponse, TrustNotFound } from './response';
import { STALE_AFTER_MS } from '../../components/RankingRow';

function payload(over: Partial<ProductTrust> = {}): ProductTrust {
  return parseProductTrust({
    id: 'up-1',
    title: '可乐 330ml*24',
    priceCents: 1000,
    lowestPriceCents: 900,
    capturedAt: 1_700_000_000_000,
    per100ml: 0.505,
    formula: '40 / (330 * 24 * 1) * 100',
    confidence: 0.95,
    warnings: ['数量按单件推断为 1'],
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
      total: 3,
      percentile: 40,
      peers: [],
      note: null,
    },
    ...over,
  });
}

describe('trust display does not recompute unit price', () => {
  it('formats the server per100ml, not price × size', () => {
    const trust = payload();
    const recomputed = ((trust.priceCents / 100) / (330 * 24)) * 100;
    expect(formatPer100ml(trust.per100ml)).toBe('0.51');
    expect(formatPer100ml(trust.per100ml)).not.toBe(recomputed.toFixed(2));
    expect(specLines(trust).find((line) => line.label === '总量')?.value).toBe('未解析');
    expect(specLines(trust).map((line) => line.value).join(' ')).not.toContain(String(330 * 24));
  });

  it('rounds the server percentile and hides a percent when the cohort is one row', () => {
    expect(cohortCopy(payload())).toEqual({
      headline: '在「软饮」里排第 1 / 3',
      detail: '比 40% 的同类便宜',
    });
    const only = payload({
      cohort: {
        status: 'ready',
        basis: 'per100ml',
        slug: 'juice-plant',
        name: '果汁植物饮',
        rank: 1,
        total: 1,
        percentile: 0,
        peers: [],
        note: null,
      },
    });
    expect(cohortCopy(only).detail).toBe('这个品类里目前只有这一件');
    expect(cohortCopy(only).detail).not.toContain('%');
  });

  it('shows the server note when the cohort is partial', () => {
    const partial = payload({
      cohort: {
        status: 'partial',
        basis: null,
        slug: null,
        name: null,
        rank: null,
        total: null,
        percentile: null,
        peers: [],
        note: '这件商品挂在多个可比品类，请从对应榜单打开才能看到名次',
      },
    });
    expect(cohortCopy(partial)).toEqual({
      headline: '这件商品挂在多个可比品类，请从对应榜单打开才能看到名次',
      detail: null,
    });
  });

  it('formats freshness in UTC+8 and reuses the stale threshold', () => {
    const trust = payload();
    expect(freshnessLine(trust, trust.capturedAt)).toBe('2023年11月15日');
    expect(freshnessLine(trust, trust.capturedAt + STALE_AFTER_MS + 1)).toContain('可能已变动');
    expect(historicalLowLine(trust)).toBe('历史低 ¥9.00');
  });
});

describe('trust navigation', () => {
  it('builds a page url with the current cohort', () => {
    expect(trustCohortSlug(undefined)).toBe('soft-drink');
    expect(trustCohortSlug('  ')).toBe('soft-drink');
    expect(trustCohortSlug('milk')).toBe('milk');
    expect(trustPageUrl('a/b', 'soft drink')).toBe(
      '/pages/trust/index?id=a%2Fb&cohort=soft%20drink',
    );
    expect(readTrustParams({ id: 'a%2Fb', cohort: 'soft%20drink' })).toEqual({
      id: 'a/b',
      cohort: 'soft drink',
    });
  });
});

describe('acceptTrustResponse', () => {
  it('parses 200 and surfaces 404 copy', () => {
    const trust = payload();
    expect(acceptTrustResponse(200, trust).per100ml).toBe(0.505);
    expect(() => acceptTrustResponse(404, { error: 'not-found', message: '榜单里没有这件商品' })).toThrow(
      TrustNotFound,
    );
    expect(() => acceptTrustResponse(500, { error: 'persistence-error' })).toThrow(/trust 500/);
  });
});
