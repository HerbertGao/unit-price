// Tagging pipeline + backfill tests (3.4). Uses a REAL in-memory better-sqlite3
// repo with the @unit-price/db migrations applied AND the canonical taxonomy
// seeded (tag tree / attributes / closure / Sam store_category_map) — mirroring
// the package's openSeededTestDb harness (openTestDb + seedTaxonomy) without
// depending on its un-exported test file. Asserts leaf attribution + attributes
// + rankable derivation + the 待人工/待细化 branches, re-run idempotency, rule-
// re-decision single-attribution convergence, and that NO LLM is ever called.
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  calculate,
  parseTier1,
  type CalcResult,
  type ParsedSpec,
} from '@unit-price/core';
import {
  createDb,
  createRepository,
  seedTaxonomy,
  type Repository,
} from '@unit-price/db';
import { listProductsForBackfill, runBackfill, tagProduct } from './tagging.js';

const migrationsFolder = fileURLToPath(
  new URL('../../../packages/db/drizzle', import.meta.url),
);

interface SeededDb {
  handle: Database.Database;
  repo: Repository;
  db: ReturnType<typeof createDb>;
}

/** Open an in-memory DB with migrations applied + taxonomy seeded. */
async function openSeeded(): Promise<SeededDb> {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') throw new Error('expected a better-sqlite3 Db');
  migrate(db.orm, { migrationsFolder });
  await seedTaxonomy(db);
  return { handle, repo: createRepository(db), db };
}

/**
 * Land one product (product_raw + product + unit_price) via the real repo. When
 * `nativeCategoryId` is given it lands on product_raw.native_category_id (its
 * dedicated store-provenance column) via the real upsertRaw field — NOT
 * category_hint (which is the passthrough source of product.category) — so the
 * backfill's listProductsForBackfill reads it and store-map fires, mirroring
 * production. Returns the product id.
 */
async function landProduct(
  repo: Repository,
  opts: {
    title: string;
    price: number;
    store: string;
    storeSku: string;
    /** Store-native category id (lands on product_raw.native_category_id). */
    nativeCategoryId?: string;
  },
): Promise<string> {
  const rawId = await repo.upsertRaw({
    store: opts.store,
    storeSku: opts.storeSku,
    raw: { title: opts.title, price: opts.price },
    nativeCategoryId: opts.nativeCategoryId,
  });
  const spec: ParsedSpec = parseTier1({
    title: opts.title,
    price: opts.price,
  }).spec;
  const calc: CalcResult = calculate(spec, opts.price);
  const { productId } = await repo.saveParsed({ rawId, spec, calc });
  return productId;
}

describe('tagProduct — leaf attribution + attributes + rankable (3.1/3.4)', () => {
  it('tier1 carbonated leaf → classified-leaf, rankable=true, category column untouched', async () => {
    const { repo, handle } = await openSeeded();
    const id = await landProduct(repo, {
      title: '可口可乐 330ml*24听',
      price: 40,
      store: 'sam',
      storeSku: 'coke-24',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title: '可口可乐 330ml*24听',
      store: 'sam',
      nativeCategoryId: null,
    });
    expect(result.verdict).toEqual({
      verdict: 'leaf',
      leafSlug: 'carbonated',
      decidedBy: 'tier1',
    });
    expect(result.rankable).toBe(true);

    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(true);
    // product.category column is NEVER touched — still "beverage".
    const row = handle
      .prepare('SELECT category FROM product WHERE id = ?')
      .get(id) as { category: string };
    expect(row.category).toBe('beverage');
  });

  it('气泡水 → drinking-water leaf + sparkling attribute (not carbonated)', async () => {
    const { repo } = await openSeeded();
    const title = '屈臣氏苏打水 330ml*24';
    const id = await landProduct(repo, {
      title,
      price: 50,
      store: 'sam',
      storeSku: 'soda-24',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: null,
    });
    expect(result.leafSlug).toBe('drinking-water');
    expect(result.attributeSlugs).toContain('sparkling');
    expect(result.rankable).toBe(true);

    const attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('drinking-water');
    // sparkling attribute attached (orthogonal axis).
    expect(attr?.tags.some((t) => t.kind === 'attribute' && t.slug === 'sparkling')).toBe(true);
    // NOT a member of carbonated (closure search by category leaf).
    const carbonatedMembers = await repo.listProductIdsInCategoryNode('carbonated');
    expect(carbonatedMembers).not.toContain(id);
  });

  it('sugar-free attribute attaches alongside the carbonated leaf', async () => {
    const { repo } = await openSeeded();
    const title = '可口可乐无糖 330ml*24';
    const id = await landProduct(repo, { title, price: 40, store: 'sam', storeSku: 'coke-zero-24' });
    await tagProduct(repo, { productId: id, title, store: 'sam', nativeCategoryId: null });
    const attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.tags.some((t) => t.kind === 'attribute' && t.slug === 'sugar-free')).toBe(true);
  });
});

describe('tagProduct — store-map branches (3.1)', () => {
  it('store-map soft-drink leaf (tier1 miss) → take store-map leaf', async () => {
    const { repo } = await openSeeded();
    // Title with no tier1 leaf keyword, but Sam native 10003380 → carbonated.
    const title = '神秘饮料 330ml*24';
    const id = await landProduct(repo, {
      title,
      price: 30,
      store: 'sam',
      storeSku: 'mystery-24',
      nativeCategoryId: '10003380',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: '10003380',
    });
    expect(result.verdict).toEqual({
      verdict: 'leaf',
      leafSlug: 'carbonated',
      decidedBy: 'store-map',
    });
    expect(result.rankable).toBe(true);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    // Provenance: the leaf edge is sourced store-map.
    expect(attr?.tags.find((t) => t.slug === 'carbonated')?.source).toBe('store-map');
  });

  it('store-map alcohol leaf (tier1 miss, pure brand title) → classified-leaf store-map, pending NULL, rankable=TRUE', async () => {
    const { repo } = await openSeeded();
    // P3.5: this exercises the STORE-MAP-ONLY path, so the title must carry NO
    // tier1 alcohol keyword (under P3.5 `啤酒` IS a tier1 beer keyword, so the old
    // `某啤酒礼盒` would now decide at tier1, not store-map). `剑南春` is a pure
    // brand name NOT in any tier1 rule list → tier1 misses → store-map (Sam native
    // 10012164 → baijiu) is the only signal. baijiu binds comparable_unit=per_100ml
    // (its own cohort), so the leaf is rankable=TRUE.
    const title = '剑南春礼盒';
    const id = await landProduct(repo, {
      title,
      price: 100,
      store: 'sam',
      storeSku: 'baijiu-box',
      nativeCategoryId: '10012164',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: '10012164',
    });
    // An alcohol leaf is a determinate leaf (已分类叶), NOT 待细化 — pending must
    // never point at a leaf. decidedBy is store-map (tier1 missed on the pure brand
    // name). rankable=true because baijiu now resolves comparable_unit=per_100ml.
    expect(result.verdict).toEqual({
      verdict: 'leaf',
      leafSlug: 'baijiu',
      decidedBy: 'store-map',
    });
    expect(result.rankable).toBe(true);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('baijiu');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(true);
    // Provenance: the leaf edge is sourced store-map.
    expect(attr?.tags.find((t) => t.slug === 'baijiu')?.source).toBe('store-map');
  });

  it('tier1 alcohol keyword (啤酒) decides at tier1 → beer leaf, rankable=TRUE (no store-map needed)', async () => {
    // P3.5 complement: `啤酒` IS a tier1 beer keyword, so a title carrying it
    // decides at tier1 (decidedBy:'tier1'), independent of any store-map signal.
    // beer binds comparable_unit=per_100ml → rankable=true.
    const { repo } = await openSeeded();
    const title = '某啤酒礼盒';
    const id = await landProduct(repo, {
      title,
      price: 100,
      store: 'sam',
      storeSku: 'beer-box',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: null,
    });
    expect(result.verdict).toEqual({
      verdict: 'leaf',
      leafSlug: 'beer',
      decidedBy: 'tier1',
    });
    expect(result.rankable).toBe(true);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('beer');
    expect(attr?.rankable).toBe(true);
  });

  it('store-map coarse (non-leaf) node → 待细化 pending pointing at the non-leaf', async () => {
    const { repo, handle } = await openSeeded();
    // Seed a coarse-node map row directly (the canonical seed maps only leaf
    // natives): native "coarse-native" → soft-drink (a non-leaf coarse node).
    const softDrinkTagId = (
      handle.prepare("SELECT id FROM tag WHERE slug = 'soft-drink'").get() as {
        id: string;
      }
    ).id;
    handle
      .prepare(
        "INSERT INTO store_category_map (id, store, native_category_id, tag_id) VALUES ('m-coarse', 'sam', 'coarse-native', ?)",
      )
      .run(softDrinkTagId);
    // Title has no tier1 keyword → store-map is the only signal; it is coarse.
    const title = '神秘饮品礼盒 1套';
    const id = await landProduct(repo, {
      title,
      price: 30,
      store: 'sam',
      storeSku: 'coarse-box',
      nativeCategoryId: 'coarse-native',
    });
    const result = await tagProduct(repo, {
      productId: id,
      title,
      store: 'sam',
      nativeCategoryId: 'coarse-native',
    });
    expect(result.verdict).toEqual({
      verdict: 'pending',
      pendingNodeSlug: 'soft-drink',
    });
    expect(result.rankable).toBe(false);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('pending');
    expect(attr?.categoryLeafSlug).toBeNull();
    // pending points at the coarse non-leaf node.
    expect(attr?.pendingCategorySlug).toBe('soft-drink');
  });

  it('unmapped native + tier1 miss → 待人工 (no leaf, no pending), not force-assigned', async () => {
    const { repo, handle } = await openSeeded();
    // Use a title with zero tier1 keywords to land 待人工.
    const cleanTitle = '神秘赠品礼盒 1套';
    const id = await landProduct(repo, {
      title: cleanTitle,
      price: 20,
      store: 'sam',
      storeSku: 'gift-set',
      nativeCategoryId: '99999999', // not in store_category_map
    });
    // Capture the category column AS LANDED (before tagging) — the tagging
    // pipeline must never CHANGE it (it does not write product.category at all).
    const before = (
      handle.prepare('SELECT category FROM product WHERE id = ?').get(id) as { category: string }
    ).category;
    const result = await tagProduct(repo, {
      productId: id,
      title: cleanTitle,
      store: 'sam',
      nativeCategoryId: '99999999',
    });
    expect(result.verdict.verdict).toBe('manual');
    expect(result.rankable).toBe(false);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBeNull();
    // category column untouched by the pipeline (same value as before tagging).
    const after = (
      handle.prepare('SELECT category FROM product WHERE id = ?').get(id) as { category: string }
    ).category;
    expect(after).toBe(before);
  });
});

describe('tagProduct — three-state reconcile / single-attribution convergence (3.1)', () => {
  it('rule re-decision A→B leaves only leaf B (no residual A); rankable recomputed', async () => {
    const { repo } = await openSeeded();
    const idTitle = 'reuse-id';
    const id = await landProduct(repo, {
      title: '可口可乐 330ml*24听',
      price: 40,
      store: 'sam',
      storeSku: idTitle,
    });
    // First pass: title says carbonated.
    await tagProduct(repo, { productId: id, title: '可口可乐 330ml*24听', store: 'sam', nativeCategoryId: null });
    let attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('carbonated');

    // Second pass with a re-decided title (果汁 → juice-plant).
    await tagProduct(repo, { productId: id, title: '鲜榨果汁 330ml*24', store: 'sam', nativeCategoryId: null });
    attr = await repo.getProductAttribution(id);
    expect(attr?.categoryLeafSlug).toBe('juice-plant');
    // Exactly one kind=category leaf remains.
    const categoryLeaves = attr!.tags.filter((t) => t.kind === 'category');
    expect(categoryLeaves.map((t) => t.slug)).toEqual(['juice-plant']);
    expect(attr?.rankable).toBe(true);
  });

  it('leaf → 待人工 transition removes the old leaf (no residual, no 越界态)', async () => {
    const { repo } = await openSeeded();
    const id = await landProduct(repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 'coke-x' });
    await tagProduct(repo, { productId: id, title: '可口可乐 330ml*24听', store: 'sam', nativeCategoryId: null });
    expect((await repo.getProductAttribution(id))?.categoryLeafSlug).toBe('carbonated');
    // Re-tag with a no-keyword title and no native → 待人工: leaf must be removed.
    await tagProduct(repo, { productId: id, title: '神秘赠品 1套', store: 'sam', nativeCategoryId: null });
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('manual');
    expect(attr?.categoryLeafSlug).toBeNull();
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(false);
  });

  it('待细化 → 命中叶 clears pending (no "有叶 ∧ pending 非空" 越界态)', async () => {
    const { repo, handle } = await openSeeded();
    // Land pending first via a coarse-node store-map (the canonical seed maps
    // only leaf natives, so seed a coarse row directly): native "coarse-native"
    // → soft-drink (a non-leaf), with no tier1 keyword in the title.
    const softDrinkTagId = (
      handle.prepare("SELECT id FROM tag WHERE slug = 'soft-drink'").get() as {
        id: string;
      }
    ).id;
    handle
      .prepare(
        "INSERT INTO store_category_map (id, store, native_category_id, tag_id) VALUES ('m-coarse-rec', 'sam', 'coarse-native', ?)",
      )
      .run(softDrinkTagId);
    const id = await landProduct(repo, { title: '神秘饮品礼盒', price: 80, store: 'sam', storeSku: 'coarse-rec', nativeCategoryId: 'coarse-native' });
    await tagProduct(repo, { productId: id, title: '神秘饮品礼盒', store: 'sam', nativeCategoryId: 'coarse-native' });
    let attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('pending');
    expect(attr?.pendingCategorySlug).toBe('soft-drink');
    // Now re-tag with a carbonated title (tier1 hits a leaf) → leaf + pending cleared.
    await tagProduct(repo, { productId: id, title: '可乐 330ml*24', store: 'sam', nativeCategoryId: 'coarse-native' });
    attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.pendingCategorySlug).toBeNull(); // 落叶必清 pending
  });

  it('reconcile never removes orthogonal attribute edges', async () => {
    const { repo } = await openSeeded();
    const id = await landProduct(repo, { title: '可口可乐无糖 330ml*24', price: 40, store: 'sam', storeSku: 'coke-zero-y' });
    await tagProduct(repo, { productId: id, title: '可口可乐无糖 330ml*24', store: 'sam', nativeCategoryId: null });
    // Re-tag (re-decision) — sugar-free attribute (if still in title) survives.
    await tagProduct(repo, { productId: id, title: '可口可乐无糖 330ml*24', store: 'sam', nativeCategoryId: null });
    const attr = await repo.getProductAttribution(id);
    expect(attr?.tags.some((t) => t.kind === 'attribute' && t.slug === 'sugar-free')).toBe(true);
    const categoryLeaves = attr!.tags.filter((t) => t.kind === 'category');
    expect(categoryLeaves).toHaveLength(1);
  });
});

describe('runBackfill — full stock, idempotent, no LLM (3.2/3.4)', () => {
  it('backfills every product (store-map fires off native_category_id), derives state + rankable, re-run idempotent', async () => {
    const { repo, db, handle } = await openSeeded();

    // Seed a coarse-node map row alongside the canonical leaf-native seeds. The
    // backfill now READS product_raw.native_category_id (landProduct lands it via
    // the real upsertRaw field), so these natives fire store-map in the backfill.
    const softDrinkTagId = (
      handle.prepare("SELECT id FROM tag WHERE slug = 'soft-drink'").get() as {
        id: string;
      }
    ).id;
    handle
      .prepare(
        "INSERT INTO store_category_map (id, store, native_category_id, tag_id) VALUES ('m-coarse-bf', 'sam', 'coarse-native', ?)",
      )
      .run(softDrinkTagId);

    // Land a representative sample. Native ids land on product_raw.native_category_id
    // and the backfill reads them → store-map fires:
    //   可口可乐   (no native)        → tier1 carbonated → classified, rankable
    //   神秘饮料   + native 10003380  → tier1 miss, store-map carbonated leaf →
    //                                   classified, rankable, store-map DECISION
    //   某啤酒礼盒  + native 10012172  → tier1 hits `啤酒`=beer AND store-map=beer
    //                                   (SAME leaf) → classified, rankable,
    //                                   decidedBy=tier1 (NOT a store-map decision)
    //   神秘饮品盒  + native coarse    → tier1 miss, store-map COARSE node → pending
    //   神秘赠品   (no native)        → tier1 miss, no native → 待人工
    await landProduct(repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 's-coke' });
    await landProduct(repo, { title: '神秘饮料 330ml*24', price: 30, store: 'sam', storeSku: 's-mystery', nativeCategoryId: '10003380' });
    await landProduct(repo, { title: '某啤酒礼盒', price: 100, store: 'sam', storeSku: 's-beer', nativeCategoryId: '10012172' });
    await landProduct(repo, { title: '神秘饮品盒 1套', price: 25, store: 'sam', storeSku: 's-coarse', nativeCategoryId: 'coarse-native' });
    await landProduct(repo, { title: '神秘赠品 1套', price: 20, store: 'sam', storeSku: 's-gift' });

    const first = await runBackfill(repo, db);
    expect(first.total).toBe(5);
    // store-map fires off native ids: carbonated (tier1) + carbonated (store-map,
    // tier1-miss) + beer (tier1, same-leaf store-map agreement) = 3 classified;
    // the coarse native lands pending; the no-keyword/no-native product 待人工.
    expect(first.classified).toBe(3); // carbonated + store-map carbonated + beer
    expect(first.pending).toBe(1); // coarse store-map node
    expect(first.manual).toBe(1); // gift: tier1-miss, no native
    expect(first.rankable).toBe(3); // all three classified leaves bind per_100ml
    // Only 神秘饮料 is a store-map DECISION (tier1-miss filled by store-map leaf);
    // 某啤酒礼盒 is same-leaf agreement (recorded tier1), 神秘饮品盒 is coarse → pending.
    expect(first.storeMapDecisions).toBe(1);

    // Snapshot the product_tag rows for idempotency comparison.
    const tagCountBefore = (handle.prepare('SELECT count(*) AS c FROM product_tag').get() as { c: number }).c;

    // Re-run on the same snapshot → identical summary + no duplicate edges.
    const second = await runBackfill(repo, db);
    expect(second.total).toBe(5);
    expect(second.classified).toBe(3);
    expect(second.pending).toBe(1);
    expect(second.manual).toBe(1);
    expect(second.rankable).toBe(3);
    expect(second.storeMapDecisions).toBe(1);
    const tagCountAfter = (handle.prepare('SELECT count(*) AS c FROM product_tag').get() as { c: number }).c;
    expect(tagCountAfter).toBe(tagCountBefore);

    // No-LLM red line is structural, not spy-enforced: tagProduct/runBackfill take
    // no LLM port, and tagging.ts imports no LLM/provider module — only core rules,
    // db types/schema, and Drizzle query helpers — so no seam can invoke an LLM.
  });

  it('backfill fires store-map: a product classifiable ONLY by a store native leaf → classified (not 待人工)', async () => {
    // The canonical seed maps Sam native 10003380 → carbonated. The backfill now
    // reads product_raw.native_category_id, so a title with no tier1 keyword but a
    // mapped native leaf classifies via store-map — proving the backfill fires
    // store-map (the inverse of the old "store-map LAZY → 待人工" assertion).
    const { repo, db } = await openSeeded();
    const id = await landProduct(repo, {
      title: '神秘饮料 330ml*24', // no tier1 leaf keyword
      price: 30,
      store: 'sam',
      storeSku: 's-native',
      nativeCategoryId: '10003380', // seeded → carbonated, fires in backfill
    });
    const result = await runBackfill(repo, db);
    expect(result.classified).toBe(1);
    expect(result.manual).toBe(0);
    expect(result.storeMapDecisions).toBe(1); // tier1-miss filled by store-map leaf
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('carbonated');
    expect(attr?.pendingCategorySlug).toBeNull();
    expect(attr?.rankable).toBe(true);
    // Provenance: the leaf edge is sourced store-map (tier1 missed).
    expect(attr?.tags.find((t) => t.slug === 'carbonated')?.source).toBe('store-map');
  });

  it('backfill closure membership: a carbonated product is a member of soft-drink AND root', async () => {
    const { repo, db } = await openSeeded();
    const id = await landProduct(repo, { title: '雪碧 330ml*24', price: 36, store: 'sam', storeSku: 'sprite-24' });
    await runBackfill(repo, db);
    expect(await repo.listProductIdsInCategoryNode('carbonated')).toContain(id);
    expect(await repo.listProductIdsInCategoryNode('soft-drink')).toContain(id);
    expect(await repo.listProductIdsInCategoryNode('beverage')).toContain(id);
  });
});

describe('listProductsForBackfill — reads product_raw.native_category_id (1.3/1.4)', () => {
  it('surfaces native_category_id from the dedicated column (NOT category_hint), null when omitted', async () => {
    const { repo, db, handle } = await openSeeded();
    const withNative = await landProduct(repo, {
      title: '神秘饮料 330ml*24',
      price: 30,
      store: 'sam',
      storeSku: 's-native-read',
      nativeCategoryId: '10003380',
    });
    const withoutNative = await landProduct(repo, {
      title: '可口可乐 330ml*24听',
      price: 40,
      store: 'sam',
      storeSku: 's-no-native',
    });

    const inputs = await listProductsForBackfill(db);
    const byId = new Map(inputs.map((i) => [i.productId, i]));
    expect(byId.get(withNative)?.nativeCategoryId).toBe('10003380');
    expect(byId.get(withoutNative)?.nativeCategoryId).toBeNull();

    // The native id lands on product_raw.native_category_id, NOT category_hint
    // (which stays the domain passthrough source of product.category).
    const raw = handle
      .prepare(
        "SELECT native_category_id AS n, category_hint AS h FROM product_raw WHERE store_sku = 's-native-read'",
      )
      .get() as { n: string | null; h: string | null };
    expect(raw.n).toBe('10003380');
    expect(raw.h).toBeNull();
  });

  it('end-to-end backfill-read: native_category_id (via upsertRaw field) → listProductsForBackfill → runBackfill store-map hit', async () => {
    // Land a row whose ONLY classification signal is its native_category_id (no
    // tier1 keyword in the title), written via the real upsertRaw field — NOT
    // category_hint. The backfill must read the column and fire store-map.
    const { repo, db, handle } = await openSeeded();
    const id = await landProduct(repo, {
      title: '神秘饮料 330ml*24', // tier1 miss
      price: 30,
      store: 'sam',
      storeSku: 's-e2e',
      nativeCategoryId: '10012164', // seeded → baijiu
    });

    // Column written; domain category_hint untouched.
    const raw = handle
      .prepare(
        "SELECT native_category_id AS n, category_hint AS h FROM product_raw WHERE store_sku = 's-e2e'",
      )
      .get() as { n: string | null; h: string | null };
    expect(raw.n).toBe('10012164');
    expect(raw.h).toBeNull();

    // listProductsForBackfill surfaces it; runBackfill fires store-map → baijiu leaf.
    const inputs = await listProductsForBackfill(db);
    expect(inputs.find((i) => i.productId === id)?.nativeCategoryId).toBe('10012164');

    const result = await runBackfill(repo, db);
    expect(result.classified).toBe(1);
    expect(result.storeMapDecisions).toBe(1);
    const attr = await repo.getProductAttribution(id);
    expect(attr?.state).toBe('classified-leaf');
    expect(attr?.categoryLeafSlug).toBe('baijiu');
    expect(attr?.tags.find((t) => t.slug === 'baijiu')?.source).toBe('store-map');
  });
});

describe('runBackfill — storeMapDecisions counting (1.5)', () => {
  it('store-map deciding leaf (tier1-miss / cross-cohort) counts; same-leaf agreement does NOT', async () => {
    const { repo, db } = await openSeeded();
    // tier1-miss filled by store-map leaf → store-map DECISION (counts).
    await landProduct(repo, { title: '剑南春礼盒', price: 100, store: 'sam', storeSku: 'sm-decide', nativeCategoryId: '10012164' });
    // tier1 hits 啤酒=beer AND store-map=beer (SAME leaf) → recorded tier1, NOT counted.
    await landProduct(repo, { title: '某啤酒礼盒', price: 80, store: 'sam', storeSku: 'sm-same', nativeCategoryId: '10012172' });
    // tier1 carbonated, no native → tier1, NOT counted.
    await landProduct(repo, { title: '可口可乐 330ml*24听', price: 40, store: 'sam', storeSku: 'sm-tier1' });

    const result = await runBackfill(repo, db);
    expect(result.classified).toBe(3);
    // Only the 剑南春 row is a store-map decision; the same-leaf beer agreement
    // and the pure-tier1 carbonated row are recorded tier1.
    expect(result.storeMapDecisions).toBe(1);
  });
});
