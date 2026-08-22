import Database from "better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../db.js";
import { createRepository, type Repository } from "../repository.js";
import { seedTaxonomy } from "../seed.js";

const migrationsFolder = fileURLToPath(
  new URL("../../drizzle", import.meta.url),
);

interface TreeTestDb {
  handle: Database.Database;
  db: Db;
  repo: Repository;
}

function openMigratedDb(): TreeTestDb {
  const handle = new Database(":memory:");
  handle.pragma("foreign_keys = ON");
  const db = createDb(handle);
  if (db.kind !== "sqlite") throw new Error("expected sqlite");
  migrate(db.orm, { migrationsFolder });
  return { handle, db, repo: createRepository(db) };
}

async function openSeededDb(): Promise<TreeTestDb> {
  const t = openMigratedDb();
  await seedTaxonomy(t.db);
  return t;
}

describe("listCategoryTree", () => {
  let t: TreeTestDb;
  beforeEach(async () => {
    t = await openSeededDb();
  });

  it("returns every category node, sorted by slug, and no other tag axis", async () => {
    const tree = await t.repo.listCategoryTree();
    const slugs = tree.map((n) => n.slug);

    expect(slugs).toEqual([...slugs].sort());
    expect(slugs).toHaveLength(17);
    for (const slug of [
      "beverage",
      "soft-drink",
      "carbonated",
      "juice-plant",
      "coffee-tea",
      "drinking-water",
      "dairy",
      "milk",
      "yogurt",
      "lactic-drink",
      "alcohol",
      "baijiu",
      "wine",
      "spirits",
      "whisky",
      "beer",
      "sake-fruit-wine",
    ]) {
      expect(slugs).toContain(slug);
    }
    for (const slug of ["sugar-free", "sparkling", "imported"]) {
      expect(slugs).not.toContain(slug);
    }
  });

  it("resolves inherited comparableUnit and derives rankable", async () => {
    const bySlug = new Map(
      (await t.repo.listCategoryTree()).map((n) => [n.slug, n]),
    );

    for (const slug of [
      "soft-drink",
      "carbonated",
      "juice-plant",
      "coffee-tea",
      "drinking-water",
      "dairy",
      "milk",
      "yogurt",
      "lactic-drink",
      "baijiu",
      "wine",
      "spirits",
      "whisky",
      "beer",
      "sake-fruit-wine",
    ]) {
      expect(bySlug.get(slug)?.comparableUnit).toBe("per_100ml");
      expect(bySlug.get(slug)?.rankable).toBe(true);
    }
    for (const slug of ["beverage", "alcohol"]) {
      expect(bySlug.get(slug)?.comparableUnit).toBeNull();
      expect(bySlug.get(slug)?.rankable).toBe(false);
    }
  });

  it("projects parentSlug and never exposes rankableCount", async () => {
    const tree = await t.repo.listCategoryTree();
    const bySlug = new Map(tree.map((n) => [n.slug, n]));

    expect(bySlug.get("beverage")?.parentSlug).toBeNull();
    expect(bySlug.get("soft-drink")?.parentSlug).toBe("beverage");
    expect(bySlug.get("carbonated")?.parentSlug).toBe("soft-drink");
    expect(bySlug.get("wine")?.parentSlug).toBe("alcohol");
    for (const node of tree) expect(node).not.toHaveProperty("rankableCount");
  });

  it("does not silently promote a category with a non-category parent to root", async () => {
    t.handle
      .prepare(
        "INSERT INTO tag (id, slug, name, kind, parent_id, comparable_unit) VALUES ('attr-parent','attr-parent','属性父','attribute',NULL,NULL)",
      )
      .run();
    t.handle
      .prepare(
        "UPDATE tag SET parent_id = 'attr-parent' WHERE slug = 'coffee-tea'",
      )
      .run();

    const tree = await t.repo.listCategoryTree();
    expect(tree.find((n) => n.slug === "coffee-tea")?.parentSlug).toBe("");
  });

  it("returns an empty tree when taxonomy is unseeded", async () => {
    const unseeded = openMigratedDb();
    await expect(unseeded.repo.listCategoryTree()).resolves.toEqual([]);
    unseeded.handle.close();
  });
});
