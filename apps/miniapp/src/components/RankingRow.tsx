// One ranking row — pure presentational, props-driven. Renders a single
// /rankings item in the 验货小票 ledger language (see apps/miniapp/DESIGN.md):
// a `#rank` mono mark, the product name, the COMPARABLE per100ml as the big mono
// number with the per-PACKAGE reference price right-aligned, a warnings chip, and
// — on rank 1 only — the blue 「验讫·最抵」inspection stamp. No card, no per-row
// shadow: rows are separated by a dashed ledger rule (RankingRow.css).
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

// >此值未重报 = 失效(小程序侧展示阈值裸常量;不从 @unit-price/core import——小程序对 core 无依赖边、经 babel 会重入 Zod class-transform 捆绑坑)
export const STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/** Integer cents → yuan with 2 decimals (display precision only). This is the
 *  per-PACKAGE reference price (priceCents/100); it is NEVER used to derive or
 *  replace per100ml. */
function formatYuan(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** 失效判定(纯派生、可单测):以客户端当前时钟 `now` 与 `capturedAt` 比较;
 *  `capturedAt` 为 undefined(旧缓存 / 跨版本响应缺字段)时判为**非失效**——缺字段
 *  降级为不置灰,不崩。默认 `now=Date.now()` 保留组件「以当前时钟判定」的原行为。 */
export function isStale(item: RankingsItem, now: number = Date.now()): boolean {
  return item.capturedAt !== undefined && now - item.capturedAt > STALE_AFTER_MS;
}

/** 历史低价标注文案(纯派生、可单测):仅当现价高于历史低点(错过抄底)才返回
 *  `¥X.XX` 的数字部分(两位小数);`lowestPriceCents` 为 undefined(缺字段降级)或
 *  现价即历史低点时返回 null(不呈现,免噪)。只比 priceCents vs lowestPriceCents
 *  (同为整件分)、不与 per100ml 大字混算(见 spec「三价并存」)。 */
export function historicalLowYuan(item: RankingsItem): string | null {
  const lowest = item.lowestPriceCents;
  return lowest !== undefined && item.priceCents > lowest ? formatYuan(lowest) : null;
}

/** The comparable unit price (元 / 100ml), shown verbatim — the server's
 *  authoritative comparable value, not back-derived. */
function formatPer100ml(per100ml: number): string {
  return per100ml.toFixed(2);
}

/** Zero-pad the rank to 2 digits to match the mono "#01 / #02 …" ledger mark. */
function formatRank(rank: number): string {
  return rank < 10 ? `0${rank}` : String(rank);
}

/** 单条榜单行:`#rank` 徽标 + 商品名 + `per100ml` 大字(可比真值)+ 整件参考价;
 *  `>30` 天未重报整行置灰(仍留榜)、现价高于历史低点时标「历史低 ¥X」,缺字段优雅降级。
 *  同一组件亦复用于即时比价页的邻居行。 */
export default function RankingRow({ item }: { item: RankingsItem }) {
  // rank 1 is the cheapest real unit price → 「值」highlight + blue 验讫 stamp.
  const isTop = item.rank === 1;
  const warnings = item.warnings ?? [];

  // 失效置灰:纯视觉、以客户端当前时钟判定(D1),不依赖服务端布尔。缺 capturedAt
  // (旧缓存 / 跨版本)时 stale=false → 不置灰(缺字段降级,不崩)。见 isStale。
  const stale = isStale(item);

  // 历史低价标注:仅当现价高于历史低点(错过抄底)才提示;缺 lowestPriceCents 或
  // 现价即历史低点时不呈现(缺字段降级 / 免噪)。见 historicalLowYuan。
  const lowestYuan = historicalLowYuan(item);

  // rrow--top / rrow--stale 两修饰正交、可并存(同一行既灰又带徽标)。
  const rowClass = ['rrow', isTop && 'rrow--top', stale && 'rrow--stale']
    .filter(Boolean)
    .join(' ');

  return (
    <View className={rowClass}>
      <Text className="rrow__rank">#{formatRank(item.rank)}</Text>
      <View className="rrow__body">
        <Text className="rrow__title">{item.title}</Text>
        <View className="rrow__meta">
          <Text className="rrow__per">
            <Text className="rrow__per-num">{formatPer100ml(item.per100ml)}</Text>
            <Text className="rrow__per-unit">元/100ml</Text>
          </Text>
          <Text className="rrow__pkg">整件 ¥{formatYuan(item.priceCents)}</Text>
        </View>
        {/* Chip row — 历史低价徽标 + 诚实 "盖戳" warn 标签(如"数量按单件推断");
            二者皆无则不渲染。两标注正交、可并存。 */}
        {lowestYuan || warnings.length > 0 ? (
          <View className="rrow__chips">
            {lowestYuan ? (
              <Text className="rrow__lowest">历史低 ¥{lowestYuan}</Text>
            ) : null}
            {warnings.map((w, i) => (
              <Text key={i} className="rrow__warn">⚠ {w}</Text>
            ))}
          </View>
        ) : null}
      </View>
      {/* 验讫·最抵 — the one deliberate brand intrusion on the raw receipt; rank 1 only. */}
      {isTop ? (
        <Text className="rrow__stamp">验讫·最抵</Text>
      ) : null}
    </View>
  );
}
