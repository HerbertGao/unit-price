// lowest_price low-water mark: upsertRaw maintenance (positive-only, min-monotone,
// anomalous ≤0 non-poisoning) + the migration 0007 backfill run from the shipped
// SQL bytes (drift-free). Pure in-memory better-sqlite3 via the shared harness.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrationsFolder, openTestDb, type TestDb } from './harness.js';

/** Read the stored low-water mark (integer cents) for a raw row, or null. */
function lowestPrice(t: TestDb, id: string): number | null {
  return (
    t.handle
      .prepare('SELECT lowest_price FROM product_raw WHERE id = ?')
      .get(id) as { lowest_price: number | null }
  ).lowest_price;
}

/** Upsert one `(sam, sku-lp)` report at a yuan price; returns the row id. */
async function report(t: TestDb, priceYuan: number): Promise<string> {
  return t.repo.upsertRaw({
    store: 'sam',
    storeSku: 'sku-lp',
    raw: { title: '椰子水', price: priceYuan },
    capturedAt: 1_000,
  });
}

describe('upsertRaw low-water mark', () => {
  let t: TestDb;
  beforeEach(() => {
    t = openTestDb();
  });

  it('first positive report seeds the mark to the current price', async () => {
    const id = await report(t, 12.9);
    expect(lowestPrice(t, id)).toBe(1290);
  });

  it('first ≤0 report leaves the mark NULL (0 and negative)', async () => {
    const zero = await t.repo.upsertRaw({
      store: 'sam',
      storeSku: 'sku-zero',
      raw: { title: 'x', price: 0 },
      capturedAt: 1_000,
    });
    const neg = await t.repo.upsertRaw({
      store: 'sam',
      storeSku: 'sku-neg',
      raw: { title: 'y', price: -3.5 },
      capturedAt: 1_000,
    });
    expect(lowestPrice(t, zero)).toBeNull();
    expect(lowestPrice(t, neg)).toBeNull();
  });

  it('a price drop refreshes the mark to the new lower value', async () => {
    const id = await report(t, 12.9);
    await report(t, 9.9);
    expect(lowestPrice(t, id)).toBe(990);
    // price column tracks the latest observation.
    const price = (
      t.handle
        .prepare('SELECT price FROM product_raw WHERE id = ?')
        .get(id) as { price: number }
    ).price;
    expect(price).toBe(990);
  });

  it('a price rise keeps the old low (min is monotone non-increasing)', async () => {
    const id = await report(t, 9.9);
    await report(t, 14.9);
    expect(lowestPrice(t, id)).toBe(990);
    const price = (
      t.handle
        .prepare('SELECT price FROM product_raw WHERE id = ?')
        .get(id) as { price: number }
    ).price;
    expect(price).toBe(1490); // latest observation still overwrites price
  });

  it('an anomalous 0/negative re-report never folds into the mark', async () => {
    const id = await report(t, 9.9);
    await report(t, 0); // anomalous — must not poison the mark
    expect(lowestPrice(t, id)).toBe(990);
    await report(t, -4); // still must not poison
    expect(lowestPrice(t, id)).toBe(990);
    const price = (
      t.handle
        .prepare('SELECT price FROM product_raw WHERE id = ?')
        .get(id) as { price: number }
    ).price;
    expect(price).toBe(-400); // price is stored faithfully even when anomalous
  });

  it('a first positive report AFTER a ≤0-only history seeds the mark (coalesce)', async () => {
    const id = await report(t, 0); // mark stays NULL
    expect(lowestPrice(t, id)).toBeNull();
    await report(t, 12.9); // coalesce(NULL, 1290) → 1290
    expect(lowestPrice(t, id)).toBe(1290);
  });
});

describe('migration 0007 lowest_price backfill', () => {
  it('sets positive rows to price, keeps ≤0 rows NULL, and is self-idempotent', () => {
    const t = openTestDb(); // full migration chain — the ADD COLUMN already applied
    // Simulate pre-backfill existing rows (mark NULL, as if inserted before 0007).
    const ins = t.handle.prepare(
      `INSERT INTO product_raw (id, store, store_sku, title, price, captured_at, lowest_price)
       VALUES (?, ?, ?, ?, ?, 1000, NULL)`,
    );
    ins.run('pos', 'sam', 'sku-pos', 'a', 1290);
    ins.run('zero', 'sam', 'sku-zero', 'b', 0);
    ins.run('neg', 'sam', 'sku-neg', 'c', -500);

    // Run the REAL backfill statement from the shipped 0007 migration (read from
    // disk, not re-typed — so a drift in the file breaks this test).
    const migration = readFileSync(
      join(migrationsFolder, '0007_legal_kitty_pryde.sql'),
      'utf8',
    );
    const backfill = migration.split('--> statement-breakpoint').at(-1);
    if (backfill == null || !/UPDATE\s+.*lowest_price/i.test(backfill)) {
      throw new Error('0007 migration is missing the lowest_price backfill statement');
    }
    t.handle.exec(backfill);

    expect(lowestPrice(t, 'pos')).toBe(1290); // positive → seeded to price
    expect(lowestPrice(t, 'zero')).toBeNull(); // ≤0 stays NULL
    expect(lowestPrice(t, 'neg')).toBeNull();

    // Idempotent: a replay must not reset an already-accumulated real low.
    t.handle.prepare('UPDATE product_raw SET lowest_price = 990 WHERE id = ?').run('pos');
    t.handle.exec(backfill);
    expect(lowestPrice(t, 'pos')).toBe(990); // WHERE lowest_price IS NULL → no-op
  });
});
