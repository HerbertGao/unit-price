// Pure category-tree flattening — the only non-trivial bit of the 分类 Tab, kept
// out of the Taro page so it's unit-testable without the runtime. Type-only
// dependency on the api-client contract; zero runtime imports.
import type { CategoryTreeNode } from '@unit-price/api-client';

export interface Row {
  node: CategoryTreeNode;
  depth: number;
}

// Flatten the flat parentSlug node set into a stable pre-order with depth, so the
// list renders as an indented tree. Siblings keep input (server) order.
//
// Assumes the server's connected is-a tree (rooted at `beverage`), and is
// FAIL-CLOSED: if any node is unreachable from a root (orphan / disconnected
// slug), toRows throws rather than silently emit an incomplete tree (which would
// drop a whole category from navigation with no signal) — the page catches it
// into its error state. Single-parent nodes can't form a root-reachable cycle, so
// the walk can't infinite-loop; a disconnected cycle's members are simply
// unreachable and caught by the same length check.
// ponytail: fully expanded, no collapse/expand — the tree is ~12 nodes; add
// collapse when it grows past one screen.
export function toRows(nodes: CategoryTreeNode[]): Row[] {
  const children = new Map<string | null, CategoryTreeNode[]>();
  for (const n of nodes) {
    const arr = children.get(n.parentSlug) ?? [];
    arr.push(n);
    children.set(n.parentSlug, arr);
  }
  const rows: Row[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const n of children.get(parent) ?? []) {
      rows.push({ node: n, depth });
      walk(n.slug, depth + 1);
    }
  };
  walk(null, 0);
  // A well-formed is-a tree emits every node exactly once; a shorter result means
  // some node is unreachable from the root → fail closed (page shows error state).
  if (rows.length !== nodes.length) {
    throw new Error(
      `category tree malformed: emitted ${rows.length} rows for ${nodes.length} nodes (orphan or duplicate slug)`,
    );
  }
  return rows;
}
