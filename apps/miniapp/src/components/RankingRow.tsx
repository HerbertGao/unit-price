// One ranking row — pure presentational, props-driven. Renders a single
// /rankings item per the P0 design baseline (design/sams-zhibuzhi/index.html
// "榜单行"): rank badge, the COMPARABLE per100ml as the big number, the
// per-PACKAGE reference price (small, muted), and a warnings chip slot.
//
// Read-only display ONLY: NO data request, NO state machine, NO calculation.
// per100ml is the server-computed comparable truth shown verbatim — NEVER
// back-derived from the package price. The package price is reference-only.
//
// Ad insertion is the PAGE's concern (it wraps rows with AdSlot by item.rank);
// this component renders just the one row. No product image in this phase (P7).
import { View, Text } from '@tarojs/components';
import type { RankingsItem } from '@unit-price/api-client';

import './RankingRow.css';

export interface RankingRowProps {
  item: RankingsItem;
}

/** Integer cents → yuan with 2 decimals (display precision only). This is the
 *  per-PACKAGE reference price (priceCents/100); it is NEVER used to derive or
 *  replace per100ml. */
function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** The comparable unit price (元 / 100ml), shown verbatim — the server's
 *  authoritative comparable value, not back-derived. */
function formatPer100ml(per100ml: number): string {
  return per100ml.toFixed(2);
}

/** Zero-pad the rank to 2 digits to match the P0 "01 / 02 …" mono treatment. */
function formatRank(rank: number): string {
  return rank < 10 ? `0${rank}` : String(rank);
}

export default function RankingRow({ item }: RankingRowProps) {
  // rank 1 is the cheapest real unit price → "值" highlight (P0 `.row.top`).
  const isTop = item.rank === 1;
  const warnings = item.warnings ?? [];

  return (
    <View className={isTop ? 'rrow rrow--top' : 'rrow'}>
      <View className="rrow__rank">
        <Text className="rrow__rank-num">{formatRank(item.rank)}</Text>
      </View>
      <View className="rrow__body">
        <Text className="rrow__title">{item.title}</Text>
        <View className="rrow__meta">
          <Text className="rrow__per">
            <Text className="rrow__per-num">{formatPer100ml(item.per100ml)}</Text>
            <Text className="rrow__per-unit">元/100ml</Text>
          </Text>
          <Text className="rrow__pkg">整件 ¥{formatYuan(item.priceCents)}</Text>
          {/* Warnings chip slot — surfaced as honest "盖戳" warn tags (e.g.
              "数量按单件推断"); hidden when there are none. */}
          {warnings.map((w, i) => (
            <Text key={i} className="rrow__warn">
              ⚠ {w}
            </Text>
          ))}
        </View>
      </View>
    </View>
  );
}
