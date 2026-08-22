// listBoardSnapshot: the single full-board object behind `GET /rankings`.
//
// The load-bearing assertion here is "attached to a NON-LEAF node still
// appears". `attachTag` rejects non-leaf attachment at write time, so the only
// way a row holds a non-leaf node is taxonomy EVOLUTION — a leaf that later
// grew children (P3.5 did this to `dairy` and `soft-drink`). Those products are
// live catalogue rows; a leaf-shaped admission gate would silently drop them on
// a taxonomy edit. Membership is therefore "any held slug is the target node or
// a descendant of it", and the field is `categorySlugs`, not `leafSlugs`.
//
// Also covered: total order, double-attachment kept as one row, single-row
// decode defects excluded-and-counted rather than thrown (this is the client's
// only endpoint), non-members not counted as defects, and category nodes
// carrying no rankableCount.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../db.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { buildBoardSnapshotQuery, createRepository, type Repository } from '../repository.js';
import { seedTaxonomy } from '../seed.js';

const migrationsFolder = fileURLToPath(new URL('../../drizzle', import.meta.url));

interface SnapTestDb {
  handle: Database.Database;
  db: Db;
  repo: Repository;
}

async function openSeededDb(): Promise<SnapTestDb> {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') throw new Error('expected sqlite');
  migrate(db.orm, { migrationsFolder });
  const t = { handle, db, repo: createRepository(db) };
  await seedTaxonomy(db);
  return t;
}

function tagId(handle: Database.Database, slug: string): string {
  return (
    handle.prepare('SELECT id FROM tag WHERE slug = ?').get(slug) as { id: string }
  ).id;
}

/** Seed one product; `categories` may hold any category slugs (leaf or not). */
function seedMember(
  handle: Database.Database,
  opts: {
    suffix: string;
    categories: string[];
    per100ml: number | null;
    rankable: boolean;
    warnings?: string;
  },
): void {
  const { suffix, categories, per100ml, rankable, warnings = '[]' } = opts;
  handle
    .prepare(
      `INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES (?,?,?,?,?,?)`,
    )
    .run(`raw-${suffix}`, 'sam', `sku-${suffix}`, `t-${suffix}`, 100, 1000);
  handle
    .prepare(
      `INSERT INTO product (id, raw_id, multipliers, category, confidence, dedupe_key, rankable) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(`prod-${suffix}`, `raw-${suffix}`, '[1]', 'beverage', 0.5, `dk-${suffix}`, rankable ? 1 : 0);
  handle
    .prepare(
      `INSERT INTO unit_price (id, product_id, per100ml, per100g, formula, confidence, warnings) VALUES (?,?,?,?,?,?,?)`,
    )
    .run(
      `up-${suffix}`,
      `prod-${suffix}`,
      per100ml,
      null,
      per100ml == null ? null : 'f',
      0.95,
      warnings,
    );
  categories.forEach((slug, i) => {
    handle
      .prepare(
        `INSERT INTO product_tag (id, product_id, tag_id, source, confidence) VALUES (?,?,?,'rule',1)`,
      )
      .run(`pt-${suffix}-${i}`, `prod-${suffix}`, tagId(handle, slug));
  });
}

describe('listBoardSnapshot', () => {
  let t: SnapTestDb;
  beforeEach(async () => {
    t = await openSeededDb();
  });

  it('keeps a row attached to a NON-LEAF node — taxonomy growth must not drop live rows', async () => {
    // `dairy` has children (milk/yogurt/lactic-drink), i.e. it is NOT a leaf.
    // A product attached to it predates that growth. It must still be in the
    // snapshot and must still carry `dairy`, so the client can surface it under
    // `dairy` and under any ancestor of `dairy`.
    seedMember(t.handle, { suffix: 'nonleaf', categories: ['dairy'], per100ml: 1, rankable: true });
    seedMember(t.handle, { suffix: 'leaf', categories: ['milk'], per100ml: 2, rankable: true });

    const snap = await t.repo.listBoardSnapshot();

    expect(snap.rows.map((r) => r.id)).toEqual(['up-nonleaf', 'up-leaf']);
    expect(snap.rows[0]?.categorySlugs).toEqual(['dairy']);
    expect(snap.excluded).toEqual([]);
  });

  it('orders by (per100ml, unit_price.id) so a client re-sort reproduces it', async () => {
    seedMember(t.handle, { suffix: 'b', categories: ['milk'], per100ml: 5, rankable: true });
    seedMember(t.handle, { suffix: 'a', categories: ['milk'], per100ml: 5, rankable: true });
    seedMember(t.handle, { suffix: 'c', categories: ['milk'], per100ml: 1, rankable: true });

    const snap = await t.repo.listBoardSnapshot();

    // per100ml ASC first; the two ties broken by unit_price.id ASC.
    expect(snap.rows.map((r) => r.id)).toEqual(['up-c', 'up-a', 'up-b']);
  });

  it('keeps a doubly-attached product as ONE row carrying both slugs', async () => {
    seedMember(t.handle, {
      suffix: 'dbl',
      categories: ['milk', 'carbonated'],
      per100ml: 1,
      rankable: true,
    });

    const snap = await t.repo.listBoardSnapshot();

    expect(snap.rows).toHaveLength(1);
    expect(snap.rows[0]?.categorySlugs).toEqual(['carbonated', 'milk']);
  });

  it('excludes-and-counts a single corrupt row instead of failing the snapshot', async () => {
    seedMember(t.handle, { suffix: 'ok', categories: ['milk'], per100ml: 1, rankable: true });
    seedMember(t.handle, {
      suffix: 'bad',
      categories: ['milk'],
      per100ml: 2,
      rankable: true,
      warnings: 'not-json{',
    });

    const snap = await t.repo.listBoardSnapshot();

    // The healthy row survives — one bad blob must not take down the only
    // endpoint the client has.
    expect(snap.rows.map((r) => r.id)).toEqual(['up-ok']);
    expect(snap.excluded).toEqual([{ reason: 'warnings_undecodable', count: 1 }]);
  });

  it('raises each remaining exclusion reason under its own name', async () => {
    // Three of the five reasons had no test at all, so swapping two literals in
    // the repository left the whole suite green while corrupting the only signal
    // an operator triages by (`excluded` non-zero → 按 reason 排查). The reason
    // vocabulary is closed precisely so it can be acted on; an untested name is
    // a name nothing holds to its meaning.
    seedMember(t.handle, {
      suffix: 'noedge',
      categories: [],
      per100ml: 1,
      rankable: true,
    });
    seedMember(t.handle, {
      suffix: 'shape',
      categories: ['carbonated'],
      per100ml: 2,
      rankable: true,
      warnings: '{"a":1}', // parses as JSON, is not string[]
    });
    seedMember(t.handle, {
      suffix: 'noformula',
      categories: ['carbonated'],
      per100ml: 3,
      rankable: true,
    });
    t.handle.prepare('UPDATE unit_price SET formula = NULL WHERE id = ?').run('up-noformula');
    // Empty string as well as NULL. The column is nullable AND the wire schema
    // requires non-empty, so `''` has its own branch — and with only the NULL
    // fixture, deleting that branch stays green while `''` gets mislabelled
    // `row_shape_invalid`, pointing an operator at the wrong layer.
    seedMember(t.handle, {
      suffix: 'emptyf',
      categories: ['carbonated'],
      per100ml: 4,
      rankable: true,
    });
    t.handle.prepare("UPDATE unit_price SET formula = '' WHERE id = ?").run('up-emptyf');

    const snap = await t.repo.listBoardSnapshot();

    expect(snap.rows).toEqual([]);
    expect([...snap.excluded].sort((a, b) => (a.reason < b.reason ? -1 : 1))).toEqual([
      { reason: 'formula_missing', count: 2 },
      { reason: 'rankable_without_category_edge', count: 1 },
      { reason: 'warnings_wrong_shape', count: 1 },
    ]);
  });

  it('does not count non-members as defects', async () => {
    seedMember(t.handle, { suffix: 'notrank', categories: ['milk'], per100ml: 1, rankable: false });
    seedMember(t.handle, { suffix: 'noaxis', categories: ['milk'], per100ml: null, rankable: true });

    const snap = await t.repo.listBoardSnapshot();

    expect(snap.rows).toEqual([]);
    // `rankable=0` and a null per100ml are ordinary non-membership, filtered in
    // SQL. Counting them would make the health signal fire on healthy data.
    expect(snap.excluded).toEqual([]);
  });

  it('carries category nodes with resolved inheritance, slug-sorted, without rankableCount', async () => {
    const snap = await t.repo.listBoardSnapshot();

    const slugs = snap.categoryNodes.map((n) => n.slug);
    expect(slugs).toEqual([...slugs].sort());
    expect(slugs).toContain('beverage');
    expect(slugs).toContain('milk');

    const milk = snap.categoryNodes.find((n) => n.slug === 'milk');
    expect(milk?.comparableUnit).toBe('per_100ml');
    expect(milk?.rankable).toBe(true);
    expect(milk?.parentSlug).toBe('dairy');

    const beverage = snap.categoryNodes.find((n) => n.slug === 'beverage');
    expect(beverage?.comparableUnit).toBeNull();
    expect(beverage?.rankable).toBe(false);

    // No per-node count: the client holds every row and counts for itself, so
    // the number can never disagree with the list beneath it.
    expect(milk).not.toHaveProperty('rankableCount');
  });

  it('returns an empty snapshot on an unseeded taxonomy rather than failing', async () => {
    const handle = new Database(':memory:');
    handle.pragma('foreign_keys = ON');
    const db = createDb(handle);
    if (db.kind !== 'sqlite') throw new Error('expected sqlite');
    migrate(db.orm, { migrationsFolder });

    const snap = await createRepository(db).listBoardSnapshot();

    expect(snap.rows).toEqual([]);
    expect(snap.categoryNodes).toEqual([]);
    expect(snap.excluded).toEqual([]);
  });
});

describe('listBoardSnapshot query plan', () => {
  // The board query is now the ONLY query behind /rankings, and — since /compute
  // reads the same snapshot — behind every compare too. The retired node-scoped
  // board carried the repo's only EXPLAIN guard; deleting it without this would
  // have taken index protection off the hot path entirely.
  //
  // EXPLAIN runs on the SQL production emits (`.toSQL()` on the shared builder),
  // so the baseline cannot drift from the query it claims to describe.
  it('probes unit_price through its unique product index', async () => {
    const t = await openSeededDb();
    for (let i = 0; i < 40; i += 1) {
      seedMember(t.handle, {
        suffix: `p${i}`,
        categories: ['carbonated'],
        per100ml: i + 1,
        rankable: true,
      });
    }
    const orm = drizzle(t.handle);
    const { sql: prodSql, params } = buildBoardSnapshotQuery(orm).toSQL();
    const details = (
      t.handle.prepare('EXPLAIN QUERY PLAN ' + prodSql).all(...params) as Array<{ detail: string }>
    ).map((d) => d.detail);

    // SQLite drives from product and must probe unit_price by the explicit
    // product-id unique index. Dropping that removable index changes the plan;
    // product_raw's primary-key probe is implicit and therefore not a useful
    // mutation guard.
    expect(
      details.some((d) =>
        /SEARCH\b.*\bunit_price\b.*USING INDEX unit_price_product_id_unique/.test(d),
      ),
    ).toBe(true);
    expect(details.some((d) => /\bSCAN\b\s+unit_price\b/.test(d))).toBe(false);

    t.handle.exec('DROP INDEX unit_price_product_id_unique');
    const withoutIndex = (
      t.handle.prepare('EXPLAIN QUERY PLAN ' + prodSql).all(...params) as Array<{ detail: string }>
    ).map((d) => d.detail);
    expect(
      withoutIndex.some((d) =>
        /SEARCH\b.*\bunit_price\b.*USING INDEX unit_price_product_id_unique/.test(d),
      ),
    ).toBe(false);

    t.handle.close();
  });
});

describe('listBoardSnapshot projection values', () => {
  let t: SnapTestDb;
  beforeEach(async () => {
    t = await openSeededDb();
  });

  // Projection values need their own guard: row count, identity, and ordering
  // cannot detect a wrong confidence source or a missing low-price watermark.
  it('takes confidence from unit_price and coalesces the low-price watermark', async () => {
    seedMember(t.handle, {
      suffix: 'v',
      categories: ['carbonated'],
      per100ml: 1,
      rankable: true,
    });
    seedMember(t.handle, {
      suffix: 'w',
      categories: ['carbonated'],
      per100ml: 2,
      rankable: true,
    });
    // Distinguishing values: the two confidences differ, so reading the wrong
    // column is visible; `v` has a real watermark below price, `w` has none, so
    // both branches of the COALESCE are pinned.
    t.handle.prepare('UPDATE product SET confidence = 0.11 WHERE id = ?').run('prod-v');
    t.handle.prepare('UPDATE unit_price SET confidence = 0.99 WHERE id = ?').run('up-v');
    t.handle.prepare('UPDATE product_raw SET price = 500, lowest_price = 300 WHERE id = ?').run('raw-v');
    t.handle.prepare('UPDATE product_raw SET price = 700, lowest_price = NULL WHERE id = ?').run('raw-w');
    t.handle.prepare('UPDATE product_raw SET source_url = ? WHERE id = ?').run('https://x/1', 'raw-v');

    const snap = await t.repo.listBoardSnapshot();
    const byId = new Map(snap.rows.map((r) => [r.id, r]));

    // Authoritative band, NOT product.confidence (0.11).
    expect(byId.get('up-v')?.confidence).toBe(0.99);
    expect(byId.get('up-v')?.priceCents).toBe(500);
    expect(byId.get('up-v')?.lowestPriceCents).toBe(300);
    // NULL watermark degrades to the current price — never null on the wire,
    // and equal to `priceCents`, which is what stops the client showing 历史低.
    expect(byId.get('up-w')?.lowestPriceCents).toBe(700);
    // Third unguarded field: nulling it out is equally invisible to every other
    // assertion, and the row still renders — just without its source link.
    expect(byId.get('up-v')?.sourceUrl).toBe('https://x/1');
  });
});
