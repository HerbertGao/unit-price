import { describe, it, expect } from 'vitest';
import { toRows } from './tree';
import type { CategoryTreeNode } from '@unit-price/api-client';

const node = (slug: string, parentSlug: string | null): CategoryTreeNode => ({
  slug,
  name: slug,
  parentSlug,
  comparableUnit: null,
  rankable: false,
  rankableCount: 0,
});

describe('toRows', () => {
  it('flattens to stable pre-order with depth; siblings keep input order', () => {
    // beverage → [soft-drink → [carbonated], alcohol → [baijiu]]
    const rows = toRows([
      node('beverage', null),
      node('soft-drink', 'beverage'),
      node('carbonated', 'soft-drink'),
      node('alcohol', 'beverage'),
      node('baijiu', 'alcohol'),
    ]);
    expect(rows.map((r) => [r.node.slug, r.depth])).toEqual([
      ['beverage', 0],
      ['soft-drink', 1],
      ['carbonated', 2],
      ['alcohol', 1],
      ['baijiu', 2],
    ]);
  });

  it('handles empty input and multiple roots', () => {
    expect(toRows([])).toEqual([]);
    const roots = toRows([node('a', null), node('b', null)]);
    expect(roots.map((r) => r.node.slug)).toEqual(['a', 'b']);
  });

  it('fails closed on an orphan node unreachable from a root', () => {
    expect(() => toRows([node('beverage', null), node('ghost', 'nonexistent-parent')])).toThrow();
  });
});
