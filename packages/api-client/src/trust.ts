// Product-trust contract — transport-agnostic source of truth for
// GET /products/:id. The rankings row id (`unit_price.id`) is the key.
// Unit price fields are a projection of stored columns; this module does not
// calculate them and does not import a calculator.
import { z } from 'zod';
import { WarningsSchema } from '@unit-price/core';
import { cleanOrigin } from './client.js';

const TrustUnitSchema = z.enum(['ml', 'L', 'g', 'kg']);

const TrustMeasurementSchema = z.object({
  value: z.number(),
  unit: TrustUnitSchema,
});

export const ProductTrustPeerSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  per100ml: z.number(),
  rank: z.number().int().min(1),
});

export type ProductTrustPeer = z.infer<typeof ProductTrustPeerSchema>;

export const ProductTrustSpecsSchema = z.object({
  unitSize: TrustMeasurementSchema.nullable(),
  quantity: z.number().nullable(),
  multipliers: z.array(z.number()),
  totalAmount: TrustMeasurementSchema.nullable(),
  packageUnit: z.string().nullable(),
});

export type ProductTrustSpecs = z.infer<typeof ProductTrustSpecsSchema>;

export const ProductTrustCohortSchema = z
  .object({
    status: z.enum(['ready', 'partial', 'empty']),
    basis: z.enum(['per100ml']).nullable(),
    slug: z.string().min(1).nullable(),
    name: z.string().min(1).nullable(),
    rank: z.number().int().min(1).nullable(),
    total: z.number().int().min(1).nullable(),
    percentile: z.number().nullable(),
    peers: z.array(ProductTrustPeerSchema).max(4),
    note: z.string().min(1).nullable(),
  })
  .superRefine((cohort, ctx) => {
    if (cohort.status === 'ready') {
      if (
        cohort.basis !== 'per100ml' ||
        cohort.slug == null ||
        cohort.name == null ||
        cohort.rank == null ||
        cohort.total == null ||
        cohort.percentile == null ||
        cohort.note != null
      ) {
        ctx.addIssue({ code: 'custom', message: 'ready cohort must be fully placed' });
      }
      if (cohort.rank != null && cohort.total != null && cohort.rank > cohort.total) {
        ctx.addIssue({ code: 'custom', message: 'rank out of cohort' });
      }
      if (
        cohort.percentile != null &&
        (cohort.percentile < 0 || cohort.percentile > 100 || Number.isNaN(cohort.percentile))
      ) {
        ctx.addIssue({ code: 'custom', message: 'percentile out of range' });
      }
      return;
    }
    if (
      cohort.basis != null ||
      cohort.rank != null ||
      cohort.total != null ||
      cohort.percentile != null ||
      cohort.peers.length !== 0 ||
      cohort.note == null
    ) {
      ctx.addIssue({ code: 'custom', message: 'unplaced cohort must not invent numbers' });
    }
  });

export type ProductTrustCohort = z.infer<typeof ProductTrustCohortSchema>;

export const ProductTrustSchema = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1),
    priceCents: z.number().int(),
    lowestPriceCents: z.number().int(),
    capturedAt: z.number().int(),
    per100ml: z.number(),
    formula: z.string().min(1),
    confidence: z.number(),
    warnings: WarningsSchema,
    store: z.string().min(1),
    storeSku: z.string().min(1),
    specs: ProductTrustSpecsSchema,
    categorySlugs: z.array(z.string().min(1)).min(1),
    cohort: ProductTrustCohortSchema,
  })
  .strict()
  .superRefine((body, ctx) => {
    if (body.cohort.status !== 'ready' || body.cohort.total == null) return;
    for (const peer of body.cohort.peers) {
      if (peer.id === body.id) {
        ctx.addIssue({ code: 'custom', message: 'peer must not be the product itself' });
      }
      if (peer.rank > body.cohort.total) {
        ctx.addIssue({ code: 'custom', message: 'peer rank out of cohort' });
      }
    }
  });

export type ProductTrust = z.infer<typeof ProductTrustSchema>;

/**
 * `<origin>/products/<id>` plus an optional `cohort` query. `id` is the
 * rankings row id. A blank cohort is omitted so the server can apply its
 * single-category rule instead of treating whitespace as a slug.
 */
export function buildProductTrustUrl(base: string, id: string, cohort?: string): string {
  const origin = cleanOrigin(base, 'buildProductTrustUrl');
  const trimmed = id.trim();
  if (trimmed.length === 0) {
    throw new Error('buildProductTrustUrl: id must be non-empty');
  }
  const path = `${origin}/products/${encodeURIComponent(trimmed)}`;
  const scoped = cohort?.trim() ?? '';
  if (scoped.length === 0) return path;
  return `${path}?cohort=${encodeURIComponent(scoped)}`;
}

/** Fail-closed parse. `jitless` is fixed so the WeChat runtime can run it. */
export function parseProductTrust(json: unknown): ProductTrust {
  return ProductTrustSchema.parse(json, { jitless: true });
}
