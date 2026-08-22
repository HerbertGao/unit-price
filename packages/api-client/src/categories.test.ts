import { describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  CategoryTreeResponseSchema,
  type CategoryTreeNode,
} from "./categories.js";
import { buildCategoriesUrl, parseCategoryTreeResponse } from "./client.js";

const rootNode: CategoryTreeNode = {
  slug: "beverage",
  name: "饮料",
  parentSlug: null,
  comparableUnit: null,
  rankable: false,
};
const softDrinkLeaf: CategoryTreeNode = {
  slug: "carbonated",
  name: "碳酸饮料",
  parentSlug: "soft-drink",
  comparableUnit: "per_100ml",
  rankable: true,
};
const alcoholNode: CategoryTreeNode = {
  slug: "alcohol",
  name: "酒类",
  parentSlug: "beverage",
  comparableUnit: null,
  rankable: false,
};
const validResponse = { nodes: [rootNode, softDrinkLeaf, alcoholNode] };

describe("CategoryTreeResponseSchema", () => {
  it("parses the shared count-free category-node shape", () => {
    expect(CategoryTreeResponseSchema.parse(validResponse)).toEqual(
      validResponse,
    );
  });

  it("parses an empty tree (unseeded taxonomy)", () => {
    expect(CategoryTreeResponseSchema.parse({ nodes: [] })).toEqual({
      nodes: [],
    });
  });

  it("does not expose a legacy rankableCount field", () => {
    const parsed = CategoryTreeResponseSchema.parse({
      nodes: [{ ...softDrinkLeaf, rankableCount: 42 }],
    });
    expect(parsed.nodes[0]).toEqual(softDrinkLeaf);
    expect(parsed.nodes[0]).not.toHaveProperty("rankableCount");
  });

  it("rejects a node missing a required field", () => {
    const { slug: _omit, ...missing } = rootNode;
    expect(() =>
      CategoryTreeResponseSchema.parse({ nodes: [missing] }),
    ).toThrow(ZodError);
  });

  it("rejects a wrong-typed field", () => {
    expect(() =>
      CategoryTreeResponseSchema.parse({
        nodes: [{ ...softDrinkLeaf, rankable: "yes" }],
      }),
    ).toThrow(ZodError);
  });

  it("rejects an unknown comparableUnit", () => {
    expect(() =>
      CategoryTreeResponseSchema.parse({
        nodes: [{ ...softDrinkLeaf, comparableUnit: "per_liter" }],
      }),
    ).toThrow(ZodError);
  });

  it("rejects nodes that is not an array and a bare-array body", () => {
    expect(() => CategoryTreeResponseSchema.parse({ nodes: rootNode })).toThrow(
      ZodError,
    );
    expect(() => CategoryTreeResponseSchema.parse([rootNode])).toThrow(
      ZodError,
    );
  });
});

describe("buildCategoriesUrl", () => {
  it("returns <origin>/categories for canonical origins", () => {
    expect(buildCategoriesUrl("https://api.example.com")).toBe(
      "https://api.example.com/categories",
    );
    expect(buildCategoriesUrl("https://api.example.com/")).toBe(
      "https://api.example.com/categories",
    );
    expect(buildCategoriesUrl("https://api.example.com:8080")).toBe(
      "https://api.example.com:8080/categories",
    );
  });

  it.each([
    "https://api.example.com/v1",
    "https://api.example.com?a=1",
    "https://api.example.com#x",
    "",
    "ftp://api.example.com",
    "https://user:pw@api.example.com",
    "https:api.example.com",
    "https://api.example.com:443",
    "https://API.EXAMPLE.COM",
  ])("fails fast for non-canonical base %j", (base) => {
    expect(() => buildCategoriesUrl(base)).toThrow();
  });
});

describe("parseCategoryTreeResponse", () => {
  it("uses the jitless parser for valid and empty trees", () => {
    expect(parseCategoryTreeResponse(validResponse)).toEqual(validResponse);
    expect(parseCategoryTreeResponse({ nodes: [] })).toEqual({ nodes: [] });
  });

  it("strips a legacy count instead of exposing a second count source", () => {
    const parsed = parseCategoryTreeResponse({
      nodes: [{ ...softDrinkLeaf, rankableCount: 1 }],
    });
    expect(parsed.nodes[0]).toEqual(softDrinkLeaf);
  });

  it("throws ZodError for malformed responses", () => {
    const { name: _omit, ...missing } = rootNode;
    expect(() => parseCategoryTreeResponse({ nodes: [missing] })).toThrow(
      ZodError,
    );
    expect(() =>
      parseCategoryTreeResponse({ nodes: [{ ...softDrinkLeaf, rankable: 1 }] }),
    ).toThrow(ZodError);
    expect(() => parseCategoryTreeResponse({ nodes: "x" })).toThrow(ZodError);
  });
});
