// End-to-end board chain: real SQLite + real migrations + real taxonomy seed →
// the real `GET /rankings` route → the real client-side derivation.
//
// Every other test in this change stubs one side. This one stubs nothing, which
// is what makes it the check worth having: it is the only place where the SQL
// that emits `categorySlugs`, the ancestry the client walks to interpret them,
// and the ordering the client inherits are all the production implementations
// at once. A divergence between any two of them — the class of defect that
// motivated this whole reshape — shows up here and nowhere else.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath, URL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cohortSlugs,
  parseCategoryTreeResponse,
  parseRankingsSnapshot,
  rowsInCohort,
  type RankingsSnapshot,
} from '@unit-price/api-client';
import { createDb, createRepository, seedTaxonomy, type Repository } from '@unit-price/db';
import { createApp } from './routes.js';
import { createNoopGovernance } from './governance.js';
import type { SpecParserLLM } from './llm.js';

const migrationsFolder = fileURLToPath(new URL('../../../packages/db/drizzle', import.meta.url));

const throwingLlm: SpecParserLLM = {
  async parse() {
    throw new Error('board e2e must never call the LLM');
  },
};

interface Ctx {
  handle: Database.Database;
  repo: Repository;
  app: ReturnType<typeof createApp>;
}

async function open(): Promise<Ctx> {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') throw new Error('expected a better-sqlite3 Db');
  migrate(db.orm, { migrationsFolder });
  await seedTaxonomy(db);
  const repo = createRepository(db);
  const app = createApp({
    makeLlm: () => throwingLlm,
    governance: createNoopGovernance(),
    makeRepo: () => repo,
  });
  return { handle, repo, app };
}

function tagId(handle: Database.Database, slug: string): string {
  return (handle.prepare('SELECT id FROM tag WHERE slug = ?').get(slug) as { id: string }).id;
}

/** Land one rankable product attached to the given category slugs. */
function seedProduct(
  handle: Database.Database,
  opts: { suffix: string; per100ml: number; categories: string[]; title?: string },
): void {
  const { suffix, per100ml, categories, title = `item-${suffix}` } = opts;
  handle
    .prepare(
      'INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES (?,?,?,?,?,?)',
    )
    .run(`raw-${suffix}`, 'sam', `sku-${suffix}`, title, 1000, 1_700_000_000_000);
  handle
    .prepare(
      'INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key, rankable) VALUES (?,?,?,?,?,?,1)',
    )
    .run(`prod-${suffix}`, `raw-${suffix}`, '[1]', 'beverage', 0.9, `dk-${suffix}`);
  handle
    .prepare(
      'INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings) VALUES (?,?,?,?,?,?,?)',
    )
    .run(`up-${suffix}`, `prod-${suffix}`, per100ml, null, `f-${suffix}`, 0.95, '[]');
  categories.forEach((slug, i) => {
    handle
      .prepare(
        "INSERT INTO product_tag (id, product_id, tag_id, source, confidence) VALUES (?,?,?,'rule',1)",
      )
      .run(`pt-${suffix}-${i}`, `prod-${suffix}`, tagId(handle, slug));
  });
}

async function fetchSnapshot(app: Ctx['app']): Promise<RankingsSnapshot> {
  const res = await app.request('/rankings', { method: 'GET' });
  expect(res.status).toBe(200);
  // Parsed by the SAME validator the miniapp uses — including the cross-field
  // invariants, so a server that emitted a row referencing an absent node would
  // fail here rather than silently lose the row on a client.
  return parseRankingsSnapshot(await res.json());
}

describe('board e2e — real DB → route → client derivation', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await open();
  });

  it('a cohort derived on the client matches what the DB actually holds', async () => {
    seedProduct(ctx.handle, { suffix: 'a', per100ml: 1, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'b', per100ml: 2, categories: ['juice-plant'] });
    seedProduct(ctx.handle, { suffix: 'c', per100ml: 3, categories: ['milk'] });

    const snap = await fetchSnapshot(ctx.app);
    const softDrink = rowsInCohort(snap, 'soft-drink');

    // carbonated + juice-plant are under soft-drink; milk is not.
    expect(softDrink.ok && softDrink.rows.map((r) => r.id)).toEqual(['up-a', 'up-b']);
  });

  it('/categories nodes exactly match the snapshot node projection', async () => {
    const snap = await fetchSnapshot(ctx.app);
    const res = await ctx.app.request('/categories', { method: 'GET' });

    expect(res.status).toBe(200);
    const tree = parseCategoryTreeResponse(await res.json());
    expect(tree.nodes).toEqual(snap.categoryNodes);
    for (const node of tree.nodes) expect(node).not.toHaveProperty('rankableCount');
  });

  it('order is inherited from the server, not recomputed on the client', async () => {
    seedProduct(ctx.handle, { suffix: 'hi', per100ml: 9.9, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'lo', per100ml: 0.1, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'mid', per100ml: 5, categories: ['carbonated'] });

    const snap = await fetchSnapshot(ctx.app);
    const got = rowsInCohort(snap, 'carbonated');

    expect(got.ok && got.rows.map((r) => r.per100ml)).toEqual([0.1, 5, 9.9]);
  });

  it('a product attached to a NON-LEAF node stays visible under it', async () => {
    // `soft-drink` has children, so this attachment is non-leaf — the state a
    // taxonomy edit produces. Inserted directly because `attachTag` (correctly)
    // refuses non-leaf attachment at write time; the row is what an OLDER write
    // left behind before the node grew children.
    seedProduct(ctx.handle, { suffix: 'legacy', per100ml: 1, categories: ['soft-drink'] });
    seedProduct(ctx.handle, { suffix: 'leaf', per100ml: 2, categories: ['carbonated'] });

    const snap = await fetchSnapshot(ctx.app);

    const atSoftDrink = rowsInCohort(snap, 'soft-drink');
    expect(atSoftDrink.ok && atSoftDrink.rows.map((r) => r.id)).toEqual(['up-legacy', 'up-leaf']);
    // It is NOT a member of the leaf it never held.
    const atCarbonated = rowsInCohort(snap, 'carbonated');
    expect(atCarbonated.ok && atCarbonated.rows.map((r) => r.id)).toEqual(['up-leaf']);
  });

  it('the cross-cohort guard still holds, now on the client side', async () => {
    seedProduct(ctx.handle, { suffix: 'sd', per100ml: 1, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'al', per100ml: 50, categories: ['wine'] });

    const snap = await fetchSnapshot(ctx.app);

    // `beverage` spans soft drinks AND alcohol — mixing them on one per100ml
    // board is what the guard exists to prevent. It used to be a 400 on the
    // endpoint; it is now a refusal to derive a view from data that arrived fine.
    const root = rowsInCohort(snap, 'beverage');
    expect(root.ok).toBe(false);
    expect(!root.ok && root.reason.kind).toBe('cross-cohort');

    // Each single-axis cohort still derives cleanly.
    expect(rowsInCohort(snap, 'carbonated').ok).toBe(true);
    expect(rowsInCohort(snap, 'wine').ok).toBe(true);
  });

  it('/compute positions against the same population the board shows', async () => {
    // The invariant the reshape had to preserve: the rank on the compare card
    // and the rank on the board are cut from one object by one derivation, so
    // they cannot disagree.
    seedProduct(ctx.handle, { suffix: 'x', per100ml: 1, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'y', per100ml: 3, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'z', per100ml: 5, categories: ['juice-plant'] });
    // OUT of soft-drink and cheaper than the user's value — without the cohort
    // filter it would inflate `total` to 4 and push `rank` to 4. With every row
    // inside one cohort the two assertions below hold under BOTH behaviours,
    // which is how deleting the filter outright kept the suite green.
    seedProduct(ctx.handle, { suffix: 'w', per100ml: 2, categories: ['wine'] });

    const snap = await fetchSnapshot(ctx.app);
    const board = rowsInCohort(snap, 'soft-drink');

    const res = await ctx.app.request('/compute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        totalPrice: 4,
        totalAmount: { value: 100, unit: 'ml' },
        category: 'soft-drink',
      }),
    });
    const json = (await res.json()) as { total: number; rank: number };

    expect(res.status).toBe(200);
    expect(board.ok && json.total).toBe(board.ok ? board.rows.length : -1);
    // 4元/100ml → per100ml = 4, which sits after 1 and 3, before 5.
    expect(json.rank).toBe(3);
  });

  it('ancestry from the shipped tree matches the closure the DB materialized', async () => {
    // Two ancestry sources exist: `category_closure` (materialized at seed) and
    // the `parentSlug` chain the client walks. Nothing enforces that they agree,
    // and a divergence would be a silently wrong board — so assert it directly
    // against a freshly migrated+seeded DB.
    const snap = await fetchSnapshot(ctx.app);

    for (const node of snap.categoryNodes) {
      const derived = [...cohortSlugs(snap.categoryNodes, node.slug)].sort();
      const materialized = (
        ctx.handle
          .prepare(
            `SELECT t.slug AS slug FROM category_closure c
               JOIN tag t ON t.id = c.tag_id
              WHERE c.ancestor_tag_id = ?`,
          )
          .all(tagId(ctx.handle, node.slug)) as { slug: string }[]
      )
        .map((r) => r.slug)
        .sort();

      expect(derived).toEqual(materialized);
    }
  });

  it('one row that fails the wire schema is excluded, not fatal to the snapshot', async () => {
    // `title` is a NOT NULL column and the wire schema requires `.min(1)` — NOT
    // NULL does not exclude `''`, so this row is reachable from real data. It
    // clears every gate `listBoardSnapshot` can apply (it has a category edge,
    // decodable warnings and a formula) and fails only at the response schema.
    // Before the row-level admission gate this returned 500, taking the board,
    // the category tree, search and compare-positioning down together.
    seedProduct(ctx.handle, { suffix: 'ok', per100ml: 1, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'bad', per100ml: 2, categories: ['carbonated'], title: '' });

    const snap = await fetchSnapshot(ctx.app);

    expect(snap.rows.map((r) => r.id)).toEqual(['up-ok']);
    expect(snap.excluded).toEqual([{ reason: 'row_shape_invalid', count: 1 }]);
  });

  it('/compute positions against the admitted set, not the raw one', async () => {
    // A row the board turns away must not inflate the compare card's total —
    // that split is exactly what reading one snapshot was meant to eliminate.
    seedProduct(ctx.handle, { suffix: 'ok', per100ml: 1, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'bad', per100ml: 2, categories: ['carbonated'], title: '' });

    const res = await ctx.app.request('/compute', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        totalPrice: 3,
        totalAmount: { value: 100, unit: 'ml' },
        category: 'soft-drink',
      }),
    });
    const json = (await res.json()) as { total: number };

    expect(res.status).toBe(200);
    expect(json.total).toBe(1);
  });

  it('a malformed category node is excluded with its rows, not fatal', async () => {
    // `tag.name` is NOT NULL with no non-empty CHECK, and `comparable_unit` is
    // free TEXT — both storable as garbage by a hand-written migration, which
    // this project's runbook does perform. Rows got an admission gate; nodes did
    // not, so either one used to 500 /rankings AND /categories together.
    seedProduct(ctx.handle, { suffix: 'ok', per100ml: 1, categories: ['carbonated'] });
    seedProduct(ctx.handle, { suffix: 'bad', per100ml: 2, categories: ['milk'] });
    ctx.handle.prepare("UPDATE tag SET name = '' WHERE slug = 'milk'").run();

    const snap = await fetchSnapshot(ctx.app);

    expect(snap.categoryNodes.some((n) => n.slug === 'milk')).toBe(false);
    // The dropped node takes its rows with it — a surviving orphan row would
    // trip the cross-field invariant and turn this back into a 500.
    expect(snap.rows.map((r) => r.id)).toEqual(['up-ok']);
    expect(snap.excluded).toEqual(
      expect.arrayContaining([
        { reason: 'node_shape_invalid', count: 1 },
        { reason: 'row_references_invalid_node', count: 1 },
      ]),
    );
  });

  it('a category with a non-category parent is rejected instead of becoming a root', async () => {
    seedProduct(ctx.handle, { suffix: 'bad-parent', per100ml: 2, categories: ['coffee-tea'] });
    ctx.handle
      .prepare("UPDATE tag SET parent_id = ? WHERE slug = 'coffee-tea'")
      .run(tagId(ctx.handle, 'sugar-free'));

    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const categories = await ctx.app.request('/categories', { method: 'GET' });
    expect(categories.status).toBe(500);
    expect(error).toHaveBeenCalledWith(
      '[categories] response validation failed',
      expect.any(Array),
    );
    error.mockRestore();

    const snap = await fetchSnapshot(ctx.app);
    expect(snap.categoryNodes.some((n) => n.slug === 'coffee-tea')).toBe(false);
    expect(snap.rows.some((r) => r.id === 'up-bad-parent')).toBe(false);
    expect(snap.excluded).toEqual(
      expect.arrayContaining([
        { reason: 'node_shape_invalid', count: 1 },
        { reason: 'row_references_invalid_node', count: 1 },
      ]),
    );
  });

  it('an unrecognised comparable_unit degrades the node, it does not throw', async () => {
    // The resolver used a bare `.parse`, which threw before any exclusion
    // machinery could see it — the same trap as `decodeJson` one function over.
    seedProduct(ctx.handle, { suffix: 'ok', per100ml: 1, categories: ['carbonated'] });
    ctx.handle.prepare("UPDATE tag SET comparable_unit = 'per_100pcs' WHERE slug = 'beverage'").run();

    const snap = await fetchSnapshot(ctx.app);

    expect(snap.rows.map((r) => r.id)).toEqual(['up-ok']);
    // Degrades to not-rankable rather than taking the board down.
    expect(snap.categoryNodes.find((n) => n.slug === 'beverage')?.rankable).toBe(false);
  });

  it('an unseeded taxonomy yields an empty snapshot, not a failure', async () => {
    const handle = new Database(':memory:');
    handle.pragma('foreign_keys = ON');
    const db = createDb(handle);
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrate(db.orm, { migrationsFolder });
    const app = createApp({
      makeLlm: () => throwingLlm,
      governance: createNoopGovernance(),
      makeRepo: () => createRepository(db),
    });

    const snap = await fetchSnapshot(app);

    expect(snap).toEqual({ rows: [], categoryNodes: [], excluded: [] });
  });
});
