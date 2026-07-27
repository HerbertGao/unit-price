// D1-path dedupe verification. The repository's D1 branch (SELECT-first fast
// path + bare-insert-in-batch concurrency backstop) is exercised against a
// stateful fake D1 binding backed by a real better-sqlite3 database, so the
// SELECT actually sees previously written rows and batch() is truly atomic.
//
// This fake implements the same binding contract drizzle's D1 driver calls
// (prepare → bind → run/all/raw, and an atomic batch). The platform semantics
// it relies on — batch() rolls the whole group back when one statement throws —
// are independently pinned against real workerd in d1-workerd.test.ts; here we
// drive the actual saveParsed code path to prove the dedupe behavior it builds
// on top of those semantics.
import {
  calculate,
  ParsedSpecSchema,
  type CalcResult,
  type ParsedSpec,
} from '@unit-price/core';
import Database from 'better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDb, type D1BindingLike } from '../db.js';
import { createRepository, type Repository } from '../repository.js';
import {
  expectedUnitPriceRow,
  failUnitPriceUpdates,
  installUnitPriceUpdateCounter,
  migrationsFolder,
  readUnitPriceRow,
} from './harness.js';

/** Full consistent spec: 1L × 6 bottles, explicit 6L total. */
const fullSpec: ParsedSpec = ParsedSpecSchema.parse({
  unitSize: { value: 1, unit: 'L' },
  quantity: 6,
  multipliers: [1],
  totalAmount: { value: 6, unit: 'L' },
  packageUnit: '瓶',
  category: 'beverage',
  confidence: 0.9,
});
const fullCalc: CalcResult = calculate(fullSpec, 39.9);

/**
 * Stateful D1-shaped binding over a real better-sqlite3 handle. Implements the
 * binding contract drizzle's D1 driver invokes:
 *  - prepare(sql) → statement; statement.bind(...params) → statement
 *  - statement.run() / .all() (returns { results }) / .raw() (rows as arrays)
 *  - batch(statements) runs the whole group inside one sqlite transaction so it
 *    commits or rolls back atomically (a throwing statement rolls the group
 *    back), matching real D1 semantics (verified in d1-workerd.test.ts).
 */
function createSqliteBackedD1(handle: Database.Database): {
  binding: D1BindingLike;
  batchCount: number;
  /** Force the next product-by-dedupe_key SELECT to return empty (simulate a
   *  racer that hasn't seen the winner's commit yet) → drives the bare-insert
   *  conflict + catch/fallback path. */
  blindfoldNextProductSelect(): void;
  reset(): void;
} {
  const state = { batchCount: 0, blindfold: false };

  function makeStatement(sql: string) {
    let params: unknown[] = [];
    const isProductSelect =
      /^select .* from ["']?product["']?\b/i.test(sql) &&
      /dedupe_key/i.test(sql);
    const stmt = {
      bind(...p: unknown[]) {
        params = p;
        return stmt;
      },
      async run() {
        const info = handle.prepare(sql).run(...params);
        return { success: true, results: [], meta: { changes: info.changes } };
      },
      async all() {
        if (isProductSelect && state.blindfold) {
          state.blindfold = false;
          return { success: true, results: [], meta: {} };
        }
        const rows = handle.prepare(sql).all(...params);
        return { success: true, results: rows, meta: {} };
      },
      async raw() {
        if (isProductSelect && state.blindfold) {
          state.blindfold = false;
          return [];
        }
        return handle.prepare(sql).raw().all(...params);
      },
      async first() {
        if (isProductSelect && state.blindfold) {
          state.blindfold = false;
          return null;
        }
        return handle.prepare(sql).get(...params) ?? null;
      },
      // Drizzle reads the built sql/params off the prepared statement when
      // assembling a batch — expose what it bound.
      get _sql() {
        return sql;
      },
      get _params() {
        return params;
      },
    };
    return stmt;
  }

  const binding: D1BindingLike = {
    prepare(query: string) {
      return makeStatement(query);
    },
    async batch(statements: unknown[]) {
      state.batchCount += 1;
      const stmts = statements as Array<{ _sql: string; _params: unknown[] }>;
      // One sqlite transaction → atomic group: any throw rolls the whole batch
      // back (no partial writes / no orphans), like D1's batch().
      const run = handle.transaction(() => {
        const results: unknown[] = [];
        for (const s of stmts) {
          handle.prepare(s._sql).run(...s._params);
          results.push({ success: true, results: [], meta: {} });
        }
        return results;
      });
      return run();
    },
  };

  return {
    binding,
    get batchCount() {
      return state.batchCount;
    },
    blindfoldNextProductSelect() {
      state.blindfold = true;
    },
    reset() {
      state.batchCount = 0;
    },
  };
}

/**
 * Reject reason including `cause`: drizzle's D1 driver rewraps a driver error as
 * `DrizzleQueryError` ("Failed query: …") and keeps the original underneath, so
 * matching the top-level message alone would miss the injected failure.
 */
async function rejectionText(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => {
      throw new Error('expected the promise to reject');
    },
    (e: unknown) => e,
  );
  return `${String(err)} ${String((err as { cause?: unknown }).cause ?? '')}`;
}

interface Fixture {
  handle: Database.Database;
  repo: Repository;
  d1: ReturnType<typeof createSqliteBackedD1>;
  rawId: string;
  countProduct(): number;
  countUnitPrice(): number;
}

function openD1Fixture(): Fixture {
  const handle = new Database(':memory:');
  handle.pragma('foreign_keys = ON');
  // Apply the real migrations through a throwaway sqlite drizzle instance, then
  // hand the same underlying handle to the D1-backed binding.
  migrate(drizzle(handle), { migrationsFolder });
  const d1 = createSqliteBackedD1(handle);
  const db = createDb(d1.binding);
  if (db.kind !== 'd1') {
    throw new Error('expected the fake binding to be tagged as kind "d1"');
  }
  const repo = createRepository(db);
  // Seed a raw row so product.raw_id FK is satisfiable.
  const rawId = 'raw-1';
  handle
    .prepare(
      'INSERT INTO product_raw (id, store, store_sku, title, price, captured_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(rawId, 'sam', 'sku-1', '椰子水 1L*6瓶', 3990, 1_700_000_000_000);
  const count = (table: string) =>
    (handle.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number })
      .c;
  return {
    handle,
    repo,
    d1,
    rawId,
    countProduct: () => count('product'),
    countUnitPrice: () => count('unit_price'),
  };
}

describe('saveParsed dedupe (D1 path, stateful fake binding)', () => {
  let f: Fixture;
  beforeEach(() => {
    f = openD1Fixture();
  });

  it('SELECT-first hit: same rawId + spec twice → second returns the existing pair plus one refresh UPDATE, never entering batch', async () => {
    const first = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    expect(f.d1.batchCount).toBe(1); // first call inserted via batch
    f.d1.reset();
    // Same calc twice, so the stored values cannot show whether the refresh ran
    // — the trigger counts the UPDATE itself.
    const refreshes = installUnitPriceUpdateCounter(f.handle);

    const second = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    // SELECT-first found the existing product → returned the existing pair and
    // wrote exactly one refresh UPDATE on unit_price. That UPDATE runs on its
    // own statement, not through batch(), so batchCount stays 0.
    expect(refreshes()).toBe(1);
    expect(second).toEqual(first);
    expect(f.d1.batchCount).toBe(0); // second call must NOT enter batch
    expect(f.countProduct()).toBe(1);
    expect(f.countUnitPrice()).toBe(1); // no orphan
  });

  it('SELECT-first hit at a new price refreshes all five derived columns in place', async () => {
    const first = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    const productBefore = f.handle.prepare('SELECT * FROM product').all();
    const rawBefore = f.handle.prepare('SELECT * FROM product_raw').all();
    f.d1.reset();

    // Same spec → same dedupe key; a lower price moves per100ml and formula.
    const cheaper = calculate(fullSpec, 19.9);
    const second = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: cheaper,
    });

    expect(second).toEqual(first);
    expect(f.d1.batchCount).toBe(0);
    expect(f.countProduct()).toBe(1);
    expect(f.countUnitPrice()).toBe(1);
    // Same row id, now carrying the SECOND call's calc — the awaited UPDATE
    // really landed (an unawaited builder would lose it silently).
    expect(readUnitPriceRow(f.handle, first.productId)).toEqual(
      expectedUnitPriceRow(first.unitPriceId, cheaper),
    );
    // Scoped to unit_price: product and product_raw stay frozen column for column.
    expect(f.handle.prepare('SELECT * FROM product').all()).toEqual(
      productBefore,
    );
    expect(f.handle.prepare('SELECT * FROM product_raw').all()).toEqual(
      rawBefore,
    );
  });

  it('a failing refresh on the SELECT-first hit rejects and leaves the row untouched', async () => {
    const first = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    const before = readUnitPriceRow(f.handle, first.productId);
    failUnitPriceUpdates(f.handle);
    f.d1.reset();

    expect(
      await rejectionText(
        f.repo.saveParsed({
          rawId: f.rawId,
          spec: fullSpec,
          calc: calculate(fullSpec, 19.9),
        }),
      ),
    ).toMatch(/injected refresh failure/);

    // The refresh sits OUTSIDE the try, so its failure propagates as itself
    // instead of being mistaken for a lost insert race and retried via batch.
    expect(f.d1.batchCount).toBe(0);
    expect(readUnitPriceRow(f.handle, first.productId)).toEqual(before);
    expect(f.countProduct()).toBe(1);
    expect(f.countUnitPrice()).toBe(1);
  });

  it('late bare-insert conflict rolls the whole batch back (no unit_price orphan), falls back to the oldest pair and refreshes it with the racer calc', async () => {
    // The winner commits first.
    const winner = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    expect(f.countProduct()).toBe(1);
    expect(f.countUnitPrice()).toBe(1);
    f.d1.reset();

    // The racer must carry a DIFFERENT calc, or the five-column assertion below
    // would stay green even with the fallback refresh missing entirely. The
    // uncomputable terminal state (a ≤0 report) moves four of the five columns;
    // per100g is the one an identical-spec refresh can never move — the axis
    // follows the spec, which the dedupe key pins.
    const racerCalc = calculate(fullSpec, 0);
    // Drive the racer deterministically: blindfold its SELECT-first so it
    // misses the already-committed row and proceeds to batch([insert product
    // (bare), insert unit_price]). The bare product insert hits the dedupe_key
    // unique index and THROWS → the whole batch rolls back (no unit_price
    // orphan). saveParsed catches and re-SELECTs the (now visible) winner.
    f.d1.blindfoldNextProductSelect();
    const loser = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: racerCalc,
    });
    // Fell back to the committed (oldest) pair.
    expect(loser).toEqual(winner);
    // The racer entered batch (and it threw → rolled back), so still exactly
    // one product + one unit_price, no orphan.
    expect(f.d1.batchCount).toBe(1);
    expect(f.countProduct()).toBe(1);
    expect(f.countUnitPrice()).toBe(1);
    // Same unit_price id, refreshed to the racer's (later) parse result.
    expect(readUnitPriceRow(f.handle, winner.productId)).toEqual(
      expectedUnitPriceRow(winner.unitPriceId, racerCalc),
    );
  });

  it('a failing refresh on the post-conflict fallback rejects and leaves the row untouched', async () => {
    const winner = await f.repo.saveParsed({
      rawId: f.rawId,
      spec: fullSpec,
      calc: fullCalc,
    });
    const before = readUnitPriceRow(f.handle, winner.productId);
    failUnitPriceUpdates(f.handle);
    f.d1.reset();

    f.d1.blindfoldNextProductSelect();
    expect(
      await rejectionText(
        f.repo.saveParsed({
          rawId: f.rawId,
          spec: fullSpec,
          calc: calculate(fullSpec, 19.9),
        }),
      ),
    ).toMatch(/injected refresh failure/);

    // It did take the batch (which rolled back on the unique conflict) and then
    // failed in the fallback refresh — that error is not swallowed by the race
    // handling, and the winner's row is intact with no orphan left behind.
    expect(f.d1.batchCount).toBe(1);
    expect(readUnitPriceRow(f.handle, winner.productId)).toEqual(before);
    expect(f.countProduct()).toBe(1);
    expect(f.countUnitPrice()).toBe(1);
  });
});
