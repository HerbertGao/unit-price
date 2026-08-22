// Board-snapshot contract + client-side view derivation.
//
// `GET /rankings` returns ONE cacheable object holding every comparable row and
// the category nodes needed to resolve ancestry. All views the client shows —
// cohort board, drill-down, search, pagination — are derived from that object
// with no further network call.
//
// The client NEVER sorts. The server emits rows ascending by (per100ml,
// unit_price.id); filtering a sorted array yields a sorted subsequence and
// slicing preserves it, so every derived view inherits the server's total order
// rather than reproducing it. That is why no ordering key is on the wire: there
// is no cross-engine comparison to keep equivalent (SQLite compares TEXT as
// UTF-8 bytes, JS compares UTF-16 code units — they agree only on ASCII, and
// relying on that would make a non-ASCII id silently reorder the board).
//
// This module is pure: schema + inferred types + pure derivation. No network
// calls, no runtime/framework dependency.
import { z } from "zod";
import { RankingsItemSchema } from "./rankings.js";
import { CategoryTreeNodeSchema } from "./categories.js";

/**
 * One snapshot row: the ranking projection minus `rank`, plus its category
 * attachments and a stable identity.
 *
 * `rank` is absent because it is a read-time position *within a view* — in an
 * unfiltered full set it has no value. The client assigns it when it slices.
 *
 * `categorySlugs` is what the product is attached to, NOT a claim that those
 * nodes are leaves. `attachTag` enforces leaf granularity on write, so the only
 * way a row holds a non-leaf node is taxonomy evolution (a leaf that later grew
 * children). Those rows are live catalogue entries and must still surface under
 * the node they hold and its ancestors; membership is therefore "any held slug
 * is the target node or a descendant of it".
 *
 * `id` is an opaque row identity — use it as a list key (`rank` changes on every
 * cohort switch and re-slice, so keying on it remounts the whole list). It
 * carries no ordering meaning.
 */
export const SnapshotRowSchema = RankingsItemSchema.omit({ rank: true }).extend(
 {
  id: z.string().min(1),
  categorySlugs: z.array(z.string().min(1)).min(1),
 },
);

export type SnapshotRow = z.infer<typeof SnapshotRowSchema>;

/**
 * A row as rendered in a view: a snapshot row with its 1-based position in that
 * view. Distinct type from `SnapshotRow` so "not yet positioned" and "positioned
 * at N" are not the same value with a maybe-field.
 */
export const SnapshotViewRowSchema = SnapshotRowSchema.extend({
 rank: z.number().int().min(1),
});

export type SnapshotViewRow = z.infer<typeof SnapshotViewRowSchema>;

/** Category nodes have one wire shape in both `/categories` and the snapshot. */
export const SnapshotCategoryNodeSchema = CategoryTreeNodeSchema;

export type SnapshotCategoryNode = z.infer<typeof SnapshotCategoryNodeSchema>;

/**
 * The whole cacheable object.
 *
 * `categoryNodes` ships in the SAME object as `rows` on purpose: resolving a
 * row's ancestry needs both, and two independently-cached objects would expire
 * to different revisions — a row on a node the client's stale tree does not know
 * would be silently dropped from every filtered view.
 *
 * `excluded` reports rows the server refused to serialize (a corrupt stored
 * blob), by reason. It is a health signal, not an error: this is the client's
 * only endpoint, so one bad row must cost that row rather than the board, the
 * category tree and search together. Rows that are merely not members
 * (`rankable=0`, no comparable axis) are filtered in SQL and never appear here.
 */
export const RankingsSnapshotSchema = z
 .object({
  rows: z.array(SnapshotRowSchema),
  categoryNodes: z.array(SnapshotCategoryNodeSchema),
  excluded: z.array(
   // `reason` is a non-empty string, NOT a closed enum. The producer's vocabulary
   // IS closed (see `packages/db`), but re-validating it here would let a NEW
   // reason — a strictly better health signal — fail the whole response: board,
   // category tree, search and compare-positioning at once. A signal ABOUT the
   // payload must never be able to reject the payload.
   z.object({ reason: z.string().min(1), count: z.number().int().min(1) }),
  ),
 })
 // Cross-field invariants. Field-shape validation alone would admit an object
 // whose derivation silently produces wrong views rather than failing.
 .superRefine((snap, ctx) => {
  const known = new Set(snap.categoryNodes.map((n) => n.slug));
  if (known.size !== snap.categoryNodes.length) {
   ctx.addIssue({
    code: "custom",
    message: "categoryNodes contains duplicate slugs",
   });
  }
  for (const n of snap.categoryNodes) {
   if (n.parentSlug != null && !known.has(n.parentSlug)) {
    ctx.addIssue({
     code: "custom",
     message: `categoryNodes: parentSlug "${n.parentSlug}" has no node`,
    });
   }
  }
  // A cycle would hang ancestor resolution rather than return a wrong answer,
  // so it is worth the one pass.
  const parentOf = new Map(
   snap.categoryNodes.map((n) => [n.slug, n.parentSlug]),
  );
  for (const n of snap.categoryNodes) {
   const seen = new Set<string>([n.slug]);
   let cur = n.parentSlug;
   while (cur != null) {
    if (seen.has(cur)) {
     ctx.addIssue({
      code: "custom",
      message: `categoryNodes: cycle at "${n.slug}"`,
     });
     break;
    }
    seen.add(cur);
    cur = parentOf.get(cur) ?? null;
   }
  }
  // A row referencing an unknown node cannot be placed in any view; it would
  // vanish from every cohort while still being counted in the whole.
  for (const row of snap.rows) {
   for (const slug of row.categorySlugs) {
    if (!known.has(slug)) {
     ctx.addIssue({
      code: "custom",
      message: `row "${row.id}" references unknown category "${slug}"`,
     });
    }
   }
  }
 });

export type RankingsSnapshot = z.infer<typeof RankingsSnapshotSchema>;

/**
 * Validate a snapshot response. Single arg, `jitless` hard-coded: this package
 * runs inside the WeChat mini-program where `eval`/`new Function` are banned and
 * Zod's default JIT compiles validators with `new Function`. Exposing the flag
 * would make a caller's omission a runtime crash on one platform only.
 *
 * Throws `ZodError` on any violation (fail-closed) — a partially valid snapshot
 * would render a board that is quietly missing rows.
 */
export function parseRankingsSnapshot(json: unknown): RankingsSnapshot {
 return RankingsSnapshotSchema.parse(json, { jitless: true });
}

// ── View derivation ────────────────────────────────────────────────────────
// Pure functions over a parsed snapshot. Filtering and slicing preserve the
// server's order, so none of these sorts.

/** Slugs of `slug` and every descendant of it, per the snapshot's node set. */
export function cohortSlugs(
 nodes: readonly SnapshotCategoryNode[],
 slug: string,
): ReadonlySet<string> {
 const childrenOf = new Map<string, string[]>();
 for (const n of nodes) {
  if (n.parentSlug == null) continue;
  const list = childrenOf.get(n.parentSlug);
  if (list == null) childrenOf.set(n.parentSlug, [n.slug]);
  else list.push(n.slug);
 }
 const out = new Set<string>();
 const stack = [slug];
 while (stack.length > 0) {
  const cur = stack.pop() as string;
  if (out.has(cur)) continue;
  out.add(cur);
  for (const child of childrenOf.get(cur) ?? []) stack.push(child);
 }
 return out;
}

/** Why a cohort view could not be derived. Distinguishable on purpose. */
export type CohortRejection =
 | { kind: "unknown-category"; slug: string }
 | { kind: "cross-cohort"; slug: string };

/**
 * Rows belonging to `slug` (itself or any descendant), in the snapshot's order.
 *
 * Two rejections, kept apart because the server distinguishes them too: a slug
 * absent from the tree is a different user-facing situation (an unseeded window,
 * a delisted category, a stale snapshot) from a node that spans several
 * comparable axes and therefore has no meaningful single board.
 */
export function rowsInCohort(
 snapshot: RankingsSnapshot,
 slug: string,
): { ok: true; rows: SnapshotRow[] } | { ok: false; reason: CohortRejection } {
 const node = snapshot.categoryNodes.find((n) => n.slug === slug);
 if (node == null)
  return { ok: false, reason: { kind: "unknown-category", slug } };
 if (node.comparableUnit == null) {
  return { ok: false, reason: { kind: "cross-cohort", slug } };
 }
 const within = cohortSlugs(snapshot.categoryNodes, slug);
 return {
  ok: true,
  rows: snapshot.rows.filter((r) => r.categorySlugs.some((s) => within.has(s))),
 };
}

/** Minimum query length, in code points. Mirrors the retired server-side gate. */
export const SEARCH_MIN_CODEPOINTS = 2;
/** Maximum query length, in code points. */
export const SEARCH_MAX_CODEPOINTS = 64;

/**
 * Trim and truncate a raw search word, or `null` when it is too short to be
 * useful. A single CJK character matches most of the catalogue, which reads as
 * "search is broken" rather than "search is broad" — the removed server-side
 * `q` rejected it with a 400 for exactly that reason, and dropping the rule
 * along with the parameter would silently widen the behaviour.
 *
 * Truncation is by code point, not UTF-16 length, so an astral character is not
 * split into a lone surrogate.
 */
export function normalizeQuery(raw: string): string | null {
 const points = [...raw.trim()];
 if (points.length < SEARCH_MIN_CODEPOINTS) return null;
 return points.slice(0, SEARCH_MAX_CODEPOINTS).join("");
}

/**
 * Case-insensitive substring match over ASCII letters ONLY.
 *
 * `toLowerCase()` is deliberately not used: it folds Unicode, so `CAFÉ` would
 * match `café`. The retired server matcher was SQLite `LIKE`, which folds ASCII
 * only — keeping that behaviour means a word that matched before the parameter
 * was removed still matches now. There is no `LIKE` here, so `%`, `_` and `!`
 * are ordinary characters.
 */
export function matchesQuery(title: string, normalizedQuery: string): boolean {
 return foldAscii(title).includes(foldAscii(normalizedQuery));
}

function foldAscii(s: string): string {
 let out = "";
 for (const ch of s) {
  const c = ch.charCodeAt(0);
  out += c >= 65 && c <= 90 ? String.fromCharCode(c + 32) : ch;
 }
 return out;
}

/**
 * Take one page of an already-filtered list and attach 1-based positions.
 *
 * `offset` must be a non-negative integer and `limit` a positive integer; a
 * negative offset would slice from the tail and emit `rank: 0`, which the view
 * schema forbids. Slicing itself cannot fail, so callers need no error state for
 * it — but the arguments still have a domain.
 */
export function pageOf(
 rows: readonly SnapshotRow[],
 offset: number,
 limit: number,
): SnapshotViewRow[] {
 if (!Number.isInteger(offset) || offset < 0) {
  throw new RangeError(
   `pageOf: offset must be a non-negative integer, got ${offset}`,
  );
 }
 if (!Number.isInteger(limit) || limit < 1) {
  throw new RangeError(
   `pageOf: limit must be a positive integer, got ${limit}`,
  );
 }
 return rows
  .slice(offset, offset + limit)
  .map((row, i) => ({ ...row, rank: offset + i + 1 }));
}
