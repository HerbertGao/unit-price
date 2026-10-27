// Display copy for the trust page. Formatting only: the comparable number is
// the server's per100ml, and the percent is Math.round of the server percentile.
// Nothing here multiplies price by size.
import type { ProductTrust } from '@unit-price/api-client';
import { historicalLowYuan, isStale } from '../../components/RankingRow';

export function formatPer100ml(per100ml: number): string {
  return per100ml.toFixed(2);
}

export function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function formatConfidence(n: number): string {
  return Number.isFinite(n) ? String(n) : '未给出';
}

/** Calendar date in China (UTC+8), from the stored epoch ms. */
export function formatCapturedAt(ms: number): string {
  const shifted = new Date(ms + 8 * 60 * 60 * 1000);
  const y = shifted.getUTCFullYear();
  const m = shifted.getUTCMonth() + 1;
  const d = shifted.getUTCDate();
  return `${y}年${m}月${d}日`;
}

export function freshnessLine(trust: Pick<ProductTrust, 'capturedAt'>): string {
  return formatCapturedAt(trust.capturedAt);
}

/** Stale copy for the chip. Null while the capture is still inside the list threshold. */
export function staleNote(trust: Pick<ProductTrust, 'capturedAt'>, now: number): string | null {
  return isStale(trust, now) ? '超过 30 天未重报，标价可能已变动' : null;
}

export function priceLine(trust: Pick<ProductTrust, 'priceCents' | 'lowestPriceCents'>): string {
  return `整件 ¥${formatYuan(trust.priceCents)}`;
}

export function historicalLowLine(
  trust: Pick<ProductTrust, 'priceCents' | 'lowestPriceCents'>,
): string | null {
  const yuan = historicalLowYuan(trust);
  return yuan == null ? null : `历史低 ¥${yuan}`;
}

export interface SpecLine {
  label: string;
  value: string;
}

function measurementText(m: { value: number; unit: string } | null): string {
  if (m == null) return '未解析';
  return `${m.value} ${m.unit}`;
}

export function specLines(trust: Pick<ProductTrust, 'specs'>): SpecLine[] {
  const specs = trust.specs;
  const pack = specs.packageUnit;
  return [
    { label: '单件', value: measurementText(specs.unitSize) },
    { label: '数量', value: specs.quantity == null ? '未解析' : String(specs.quantity) },
    {
      label: '乘数',
      value: specs.multipliers.length === 0 ? '未解析' : specs.multipliers.join(' × '),
    },
    { label: '总量', value: measurementText(specs.totalAmount) },
    { label: '包装', value: pack == null || pack === '' ? '未解析' : pack },
  ];
}

export interface CohortCopy {
  headline: string;
  detail: string | null;
}

export function cohortCopy(trust: Pick<ProductTrust, 'cohort'>): CohortCopy {
  const cohort = trust.cohort;
  if (
    cohort.status !== 'ready' ||
    cohort.rank == null ||
    cohort.total == null ||
    cohort.name == null ||
    cohort.percentile == null
  ) {
    return { headline: cohort.note ?? '暂时给不出同类位置', detail: null };
  }
  const headline = `在「${cohort.name}」里排第 ${cohort.rank} / ${cohort.total}`;
  if (cohort.total < 2) {
    return { headline, detail: '这个品类里目前只有这一件' };
  }
  return { headline, detail: `比 ${Math.round(cohort.percentile)}% 的同类便宜` };
}
