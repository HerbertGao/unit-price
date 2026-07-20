// Rankings contract — transport-agnostic single source of truth for GET /rankings.
// Lives here (NOT in apps/api/src/routes.ts) so `apps/api` and every client
// (miniapp, web, plugin) depend on ONE schema. This module is pure: it defines
// the Zod schema + inferred types ONLY; no network calls (fetch/Taro.request/
// wx.request) and no dependency on any runtime/framework package.
import { z } from 'zod';
import { WarningsSchema } from '@unit-price/core';

/**
 * One ranking row in the GET /rankings response. Every field is a PROJECTION of
 * a stored column read from `unit_price ⋈ product ⋈ product_raw` — the read path
 * NEVER recomputes (per the rankings-api spec / D1). `rank` is the only computed
 * field: assigned at read time as `offset + 1-based row index`, not persisted.
 *
 * Field shapes track the source columns:
 *  - `title`/`store`/`storeSku` are NON-empty (`product_raw` NOT NULL columns) —
 *    `z.string().min(1)`, never optional.
 *  - `sourceUrl` is nullable (`product_raw.source_url` is a nullable column).
 *  - `formula` is a non-empty string (NOT nullable): an in-ranking row has
 *    `per100ml IS NOT NULL`, and the persistence CalcResultGate invariant
 *    ("formula non-empty ⟺ per100ml/per100g one is non-empty") makes formula
 *    necessarily non-empty here.
 *  - `priceCents` is the integer cents from `product_raw.price` (raw observation,
 *    NOT converted to yuan / no float currency math on the server).
 *  - `confidence` is `unit_price.confidence` (the final authoritative band), NOT
 *    `product.confidence` (a parse-time intermediate).
 *  - `warnings` reuses core's `WarningsSchema` (`string[]`), the same shape the
 *    write path stores; passed through verbatim (single-unit-inference warnings
 *    are NOT silently dropped).
 *  - `capturedAt` (integer epoch ms, = `product_raw.captured_at`) and
 *    `lowestPriceCents` (integer cents, = `COALESCE(product_raw.lowest_price,
 *    price)`) are `.optional()` yet the server's ONLINE projection ALWAYS emits
 *    both (captured_at is NOT NULL; lowestPriceCents is COALESCE'd non-null), so a
 *    live response necessarily carries them. `.optional()` exists ONLY so the
 *    independently-deployed clients sharing this one schema tolerate a
 *    cross-version OLD server, or a CDN-cached (24h TTL) OLD response, that
 *    predates these fields: a missing field still parses (no whole-board ZodError)
 *    and the client degrades for free — its `isStale`/`historicalLowYuan` helpers
 *    guard on the field's presence, so an absent field means no grey / no
 *    historical-low badge (they short-circuit on `!== undefined`, not on NaN). If
 *    present they MUST still be integers (`z.number().int()`): `capturedAt` is
 *    epoch ms, `lowestPriceCents` is cents — a string/decimal is a real contract
 *    violation and fails. `ComputeResultSchema` reuses this schema by reference
 *    for `neighbors`, so the same optionality/integrality holds for /compute rows.
 */
export const RankingsItemSchema = z.object({
  rank: z.number().int().min(1),
  title: z.string().min(1),
  priceCents: z.number().int(),
  per100ml: z.number(),
  formula: z.string().min(1),
  confidence: z.number(),
  warnings: WarningsSchema,
  store: z.string().min(1),
  storeSku: z.string().min(1),
  sourceUrl: z.string().nullable(),
  capturedAt: z.number().int().optional(),
  lowestPriceCents: z.number().int().optional(),
});

export type RankingsItem = z.infer<typeof RankingsItemSchema>;

/**
 * GET /rankings response body: a bare array of ranking rows, already sorted by
 * `per100ml` ascending (cheapest real unit price first). An empty array is the
 * valid response for an empty library or an out-of-range `offset` (a 200, never
 * a 404). Validated before send to keep the contract honest.
 */
export const RankingsResponseSchema = z.array(RankingsItemSchema);

export type RankingsResponse = z.infer<typeof RankingsResponseSchema>;
