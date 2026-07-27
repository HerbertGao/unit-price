// Test harness: in-memory better-sqlite3 with the real Drizzle migrations
// applied, and `PRAGMA foreign_keys=ON` set explicitly — bare SQLite defaults
// foreign keys OFF and driver behavior can drift across versions/swaps, while
// D1 always enforces them; without the pragma the saveParsed FK/rollback
// assertions would pass vacuously.
import type { CalcResult } from '@unit-price/core';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { fileURLToPath } from 'node:url';
import { encodeJson } from '../codec.js';
import { createDb, type Db } from '../db.js';
import { createRepository, type Repository } from '../repository.js';
import { seedTaxonomy } from '../seed.js';

export const migrationsFolder = fileURLToPath(
  new URL('../../drizzle', import.meta.url),
);

export interface TestDb {
  handle: Database.Database;
  db: Db;
  repo: Repository;
}

export function openTestDb(): TestDb {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  const db = createDb(handle);
  if (db.kind !== 'sqlite') {
    throw new Error('test harness expected a better-sqlite3-backed Db');
  }
  migrate(db.orm, { migrationsFolder });
  return { handle, db, repo: createRepository(db) };
}

/** Like `openTestDb`, but with the canonical taxonomy seeded (tag tree, */
/** attributes, closure, Sam store_category_map). */
export async function openSeededTestDb(): Promise<TestDb> {
  const test = openTestDb();
  await seedTaxonomy(test.db);
  return test;
}

export function countRows(handle: Database.Database, table: string): number {
  const row = handle
    .prepare(`SELECT count(*) AS c FROM ${table}`)
    .get() as { c: number };
  return row.c;
}

/** The row id + the five columns a dedupe-hit refresh may rewrite, as stored. */
export function readUnitPriceRow(
  handle: Database.Database,
  productId: string,
): Record<string, unknown> {
  return handle
    .prepare(
      'SELECT id, per100ml, per100g, formula, confidence, warnings FROM unit_price WHERE product_id = ?',
    )
    .get(productId) as Record<string, unknown>;
}

/** How `readUnitPriceRow` must read after a refresh from `calc` (id unchanged). */
export function expectedUnitPriceRow(
  unitPriceId: string,
  calc: CalcResult,
): Record<string, unknown> {
  return {
    id: unitPriceId,
    per100ml: calc.unitPrice.per100ml,
    per100g: calc.unitPrice.per100g,
    formula: calc.unitPrice.formula,
    confidence: calc.confidence,
    warnings: encodeJson(calc.warnings),
  };
}

/**
 * Count refresh writes to `unit_price` via an AFTER UPDATE trigger (one log row
 * per updated row). Needed because a same-price refresh rewrites identical
 * values: asserting the stored values would stay green under an implementation
 * that skipped the write, so the count is the only write evidence. Returns a
 * reader for the running count.
 */
export function installUnitPriceUpdateCounter(
  handle: Database.Database,
): () => number {
  handle.exec(`
    CREATE TABLE unit_price_update_log (n INTEGER);
    CREATE TRIGGER unit_price_update_counter AFTER UPDATE ON unit_price
    BEGIN INSERT INTO unit_price_update_log (n) VALUES (1); END;
  `);
  return () => countRows(handle, 'unit_price_update_log');
}

/** Make every UPDATE on `unit_price` throw — the refresh write-failure injector. */
export function failUnitPriceUpdates(handle: Database.Database): void {
  handle.exec(`
    CREATE TRIGGER unit_price_update_boom BEFORE UPDATE ON unit_price
    BEGIN SELECT RAISE(ABORT, 'injected refresh failure'); END;
  `);
}
