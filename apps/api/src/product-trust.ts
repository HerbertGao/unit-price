// Cohort placement for GET /products/:id.
//
// Rank is the row's 1-based index in the admitted snapshot order (the same
// order /rankings emits), not positionInCohort's "insert a user value" slot.
// Percentile is the share of cohort rows with a strictly higher stored
// per100ml. Nothing here calls calculate().
import { cohortSlugs, type ProductTrust, type ProductTrustSpecs } from '@unit-price/api-client';
import type { ParsedSpec } from '@unit-price/core';
import type { BoardSnapshotCategoryNode, BoardSnapshotRow } from '@unit-price/db';

export const TRUST_PEER_RADIUS = 2;

export const TRUST_NOTES = {
  multiple: '这件商品挂在多个可比品类，请从对应榜单打开才能看到名次',
  none: '没有可排名的品类，给不出名次',
  unknown: '未知品类，给不出名次',
  cross: '该品类跨多个比价口径，没有单一名次',
  notVolume: '该品类不是按每 100ml 比较，当前榜单给不出名次',
  notMember: '这件商品不在该品类里，给不出名次',
} as const;

export function toTrustSpecs(spec: ParsedSpec): ProductTrustSpecs {
  return {
    unitSize: spec.unitSize ?? null,
    quantity: spec.quantity ?? null,
    multipliers: spec.multipliers,
    totalAmount: spec.totalAmount ?? null,
    packageUnit: spec.packageUnit ?? null,
  };
}

function unplaced(
  status: 'partial' | 'empty',
  note: string,
  slug: string | null,
  name: string | null,
): ProductTrust['cohort'] {
  return {
    status,
    basis: null,
    slug,
    name,
    rank: null,
    total: null,
    percentile: null,
    peers: [],
    note,
  };
}

function placeIn(
  row: BoardSnapshotRow,
  rows: readonly BoardSnapshotRow[],
  nodes: readonly BoardSnapshotCategoryNode[],
  slug: string,
): ProductTrust['cohort'] {
  const node = nodes.find((n) => n.slug === slug);
  if (node == null) return unplaced('empty', TRUST_NOTES.unknown, slug, null);
  if (node.comparableUnit == null) return unplaced('empty', TRUST_NOTES.cross, slug, node.name);
  if (node.comparableUnit !== 'per_100ml') {
    return unplaced('empty', TRUST_NOTES.notVolume, slug, node.name);
  }
  const within = cohortSlugs(nodes, slug);
  const members = rows.filter((r) => r.categorySlugs.some((s) => within.has(s)));
  const index = members.findIndex((r) => r.id === row.id);
  if (index < 0) return unplaced('empty', TRUST_NOTES.notMember, slug, node.name);

  const total = members.length;
  const value = row.per100ml;
  let pricier = 0;
  for (const member of members) {
    if (member.per100ml > value) pricier += 1;
  }
  const start = Math.max(0, index - TRUST_PEER_RADIUS);
  const end = Math.min(total, index + TRUST_PEER_RADIUS + 1);
  const peers: ProductTrust['cohort']['peers'] = [];
  for (let i = start; i < end; i += 1) {
    if (i === index) continue;
    const member = members[i]!;
    peers.push({
      id: member.id,
      title: member.title,
      per100ml: member.per100ml,
      rank: i + 1,
    });
  }
  return {
    status: 'ready',
    basis: 'per100ml',
    slug,
    name: node.name,
    rank: index + 1,
    total,
    percentile: (pricier / total) * 100,
    peers,
    note: null,
  };
}

/**
 * `cohortQuery` blank → the row's single per_100ml category, or partial/empty
 * when that choice is not unique. A provided slug is used as-is.
 */
export function cohortForRow(
  row: BoardSnapshotRow,
  rows: readonly BoardSnapshotRow[],
  nodes: readonly BoardSnapshotCategoryNode[],
  cohortQuery: string | undefined,
): ProductTrust['cohort'] {
  const requested = cohortQuery?.trim() ?? '';
  if (requested !== '') return placeIn(row, rows, nodes, requested);

  const volumeSlugs = row.categorySlugs.filter((slug) => {
    const node = nodes.find((n) => n.slug === slug);
    return node?.comparableUnit === 'per_100ml';
  });
  if (volumeSlugs.length === 1) return placeIn(row, rows, nodes, volumeSlugs[0]!);
  if (volumeSlugs.length === 0) return unplaced('empty', TRUST_NOTES.none, null, null);
  return unplaced('partial', TRUST_NOTES.multiple, null, null);
}
