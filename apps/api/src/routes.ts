// Hono app + POST /parse route. Request/response bodies are Zod-validated.
// HTTP status semantics (parse-api spec):
//  - 4xx: invalid request body (missing/empty title, missing/non-numeric price)
//  - 5xx info-insufficient: tier2 transport failed AND tier1 had no shape at all
//  - 5xx config-error: runtime config error (distinguishable error code)
//  - 200: everything else, including determined-uncomputable (per100ml=null),
//         contracted-form, and low-confidence results.
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { ParsedSpecSchema, UnitPriceSchema, WarningsSchema, type RawProduct } from '@unit-price/core';
import type { Repository } from '@unit-price/db';
import { orchestrate } from './orchestrate.js';
import type { SpecParserLLM } from './llm.js';
import type { Bindings } from './bindings.js';
import { governanceMiddleware, type Governance } from './governance.js';

/** Request schema: title non-empty string, price a finite number, optional hint. */
export const ParseRequestSchema = z.object({
  title: z.string().min(1, 'title must be a non-empty string'),
  price: z.number({ error: 'price must be a number' }).finite('price must be a finite number'),
  categoryHint: z.string().optional(),
});

/** Response schema (validated before send to keep the contract honest). */
export const ParseResponseSchema = z.object({
  spec: ParsedSpecSchema,
  unitPrice: UnitPriceSchema,
  confidence: z.number().min(0).max(1),
  warnings: WarningsSchema,
});

/**
 * Contribute request schema: RawProduct domain fields + provenance fields.
 *
 * `price` uses `.finite()` ONLY (rejects NaN/±Inf) — negative/zero prices are
 * LEGAL reports: product_raw faithfully stores the raw observation (including
 * anomalous prices), and core routes price<=0 to per100ml=null (a 200 with a
 * warning), per parse-api. DO NOT add `.positive()`/`.min(0)` here. `400` is
 * reserved for empty `title`, non-finite `price`, or empty dedupe keys.
 *
 * `store`/`storeSku` are the source of the `(store, store_sku)` dedupe key and
 * MUST be non-empty at the request layer (empty → 400 invalid-request) so an
 * empty key never reaches the repository. `capturedAt` is epoch ms (int only;
 * ISO strings are rejected). Provenance fields (store/storeSku/source/sourceUrl/
 * capturedAt) are NOT part of RawProductSchema — only `categoryHint` rides in
 * the domain `raw` object.
 */
export const ContributeRequestSchema = z.object({
  // Domain fields (aligned with RawProductSchema).
  title: z.string().min(1, 'title must be a non-empty string'),
  price: z.number({ error: 'price must be a number' }).finite('price must be a finite number'),
  categoryHint: z.string().optional(),
  // Provenance fields (dedupe / source-of-record). Trim BEFORE min(1) so a
  // whitespace-only dedupe key is rejected at the request layer (400) rather
  // than slipping past min(1) and tripping the repository's DedupeKeyGate
  // (which trims) into a generic 500 persistence-error. Mirrors DedupeKeyGate.
  store: z.string().trim().min(1, 'store must be a non-empty string'),
  storeSku: z.string().trim().min(1, 'storeSku must be a non-empty string'),
  source: z.string().optional(),
  sourceUrl: z.string().optional(),
  capturedAt: z.number().int('capturedAt must be an integer epoch-ms timestamp').optional(),
});

export type ContributeRequest = z.infer<typeof ContributeRequestSchema>;

/**
 * Contribute response = the /parse response contract plus the three persisted
 * app-generated TEXT ids. Validated before send (contract enforcement).
 */
export const ContributeResponseSchema = ParseResponseSchema.extend({
  rawId: z.string().min(1),
  productId: z.string().min(1),
  unitPriceId: z.string().min(1),
});

export type ContributeResponse = z.infer<typeof ContributeResponseSchema>;

/**
 * Minimal /ingest 202 body: just the landed app-generated TEXT rawId. Parsing
 * runs in the background after the response is sent, so the synchronous response
 * carries no spec/unitPrice/confidence/warnings — only proof the raw landed.
 * Validated before send (rawId from upsertRaw is always non-empty, so the guard
 * is defensive; a failure maps to 500 internal, mirroring /contribute).
 */
export const IngestResponseSchema = z.object({ rawId: z.string().min(1) });

export type IngestResponse = z.infer<typeof IngestResponseSchema>;

export interface AppDeps {
  /**
   * Factory that builds an LLM port from the per-request injected env. Building
   * per request (not a shared singleton) avoids isolate cross-request env
   * bleed: each request resolves config from its OWN `c.env`.
   */
  makeLlm: (env: Bindings) => SpecParserLLM;
  /**
   * Injectable access governance (auth / rate-limit / usage). Production injects
   * the real implementation; dev injects a pass-through no-op. Mounted as a
   * pre-middleware on /parse and /contribute — /health is exempt from the chain.
   */
  governance: Governance;
  /**
   * Optional factory that builds the persistence Repository from the per-request
   * injected env. Built per request (not a shared singleton), mirroring
   * `makeLlm`, so each request resolves its OWN `c.env.DB` — no isolate
   * cross-request env bleed. Production wires the real D1 repo; Node dev omits
   * it, so `/contribute` takes the persistence-error branch. Returns `null` when
   * no DB is bound; the factory itself may THROW on an invalid binding (both the
   * null and the throw map to a 500 persistence-error at the route).
   */
  makeRepo?: (env: Bindings) => Repository | null;
  /**
   * Injectable "background execution" port for /ingest's post-response work
   * (orchestrate + saveParsed), same paradigm as makeLlm/makeRepo/governance.
   * Production (`buildApp`) injects `(c, run) => c.executionCtx.waitUntil(run())`
   * so `run()` continues after the 202 is sent within the same invocation, and
   * the port RETURNS VOID so the handler's `await` resolves immediately (202
   * lands fast, never blocked on `run()`). Node dev / default is the synchronous
   * `(_, run) => run()` so local/tests are deterministic (202 after parsing
   * completes). The route MUST NOT touch `c.executionCtx` directly — that getter
   * throws under Node dev; the runtime difference is confined to this port.
   */
  scheduleBackground?: (
    c: Context<{ Bindings: Bindings }>,
    run: () => Promise<void>,
  ) => void | Promise<void>;
}

/**
 * Internal helper result: either the parsed/resolved value, or a short-circuit
 * Response (already a 400/500) the caller returns as-is. Shared by /contribute
 * and /ingest so the "validate body → resolve repo → land raw" preamble stays
 * identical (and /contribute's behavior is unchanged) — the two endpoints only
 * diverge afterward on parse timing + response.
 */
type HelperResult<T> = { ok: true; value: T } | { ok: false; response: Response };

/**
 * Validate the request body against ContributeRequestSchema. Non-JSON or schema
 * failure (incl. empty/whitespace dedupe keys, empty title, non-finite price) →
 * 400 invalid-request, no row written.
 */
async function parseContributeBody(
  c: Context<{ Bindings: Bindings }>,
): Promise<HelperResult<ContributeRequest>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'invalid-request', message: 'request body must be valid JSON' }, 400),
    };
  }

  const parsedReq = ContributeRequestSchema.safeParse(body);
  if (!parsedReq.success) {
    return {
      ok: false,
      response: c.json(
        {
          error: 'invalid-request',
          message: 'request body failed validation',
          issues: parsedReq.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      ),
    };
  }
  return { ok: true, value: parsedReq.data };
}

/**
 * Resolve the repository from this request's env. The factory's
 * createDb/createRepository THROW on an invalid binding — catch and map to
 * persistence-error. A null repo (no DB bound, e.g. Node dev) is the same
 * persistence-error. Both keep the failure from bubbling as a framework 500.
 */
function resolveRepo(
  c: Context<{ Bindings: Bindings }>,
  deps: AppDeps,
): HelperResult<Repository> {
  let repo: Repository | null;
  try {
    repo = deps.makeRepo?.(c.env) ?? null;
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'persistence-error', message: 'persistence layer initialization failed' }, 500),
    };
  }
  if (repo === null) {
    return { ok: false, response: c.json({ error: 'persistence-error', message: 'no database bound' }, 500) };
  }
  return { ok: true, value: repo };
}

/**
 * upsertRaw FIRST (observation-first): the raw report is the most valuable
 * crowd-sourced asset, persisted even if parsing later fails. A throw maps to
 * persistence-error (raw not landed → no rawId).
 */
async function landRaw(
  c: Context<{ Bindings: Bindings }>,
  repo: Repository,
  req: ContributeRequest,
): Promise<HelperResult<string>> {
  try {
    const rawId = await repo.upsertRaw({
      store: req.store,
      storeSku: req.storeSku,
      raw: { title: req.title, price: req.price, categoryHint: req.categoryHint },
      source: req.source,
      sourceUrl: req.sourceUrl,
      capturedAt: req.capturedAt,
    });
    return { ok: true, value: rawId };
  } catch {
    return {
      ok: false,
      response: c.json({ error: 'persistence-error', message: 'failed to persist raw report' }, 500),
    };
  }
}

export function createApp(deps: AppDeps): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  // /health is exempt from the entire governance chain (auth + rate + usage),
  // so liveness probes can hit it keyless and high-frequency.
  app.get('/health', (c) => c.json({ ok: true }));

  // Governance runs only on /parse, before the business handler. Order inside
  // the middleware: auth → rate-limit → usage → next().
  app.use('/parse', governanceMiddleware(deps.governance));

  app.post('/parse', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-request', message: 'request body must be valid JSON' }, 400);
    }

    const parsedReq = ParseRequestSchema.safeParse(body);
    if (!parsedReq.success) {
      return c.json(
        {
          error: 'invalid-request',
          message: 'request body failed validation',
          issues: parsedReq.error.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        400,
      );
    }

    const input: RawProduct = parsedReq.data;
    // Build the LLM port from THIS request's injected env (no cross-request
    // bleed). The factory's lazy parser only resolves config if tier2 is reached.
    const llm = deps.makeLlm(c.env);
    const outcome = await orchestrate(input, llm);

    if (outcome.kind === 'config-error') {
      // Distinguishable 5xx: runtime configuration error (no confidence body).
      return c.json({ error: 'config-error', message: outcome.message }, 500);
    }
    if (outcome.kind === 'insufficient') {
      // Distinguishable 5xx: information insufficient — can't even judge
      // computability (tier2 transport failed + tier1 had no shape).
      return c.json({ error: 'insufficient-information', message: outcome.message }, 503);
    }

    // Validate the response shape before returning (contract enforcement).
    const validated = ParseResponseSchema.safeParse(outcome.response);
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 200);
  });

  // Governance runs on /contribute too, mounted BEFORE the handler so Hono
  // (which matches by registration order) wraps the route. Mounting the
  // middleware after the handler would leave /contribute unauthenticated.
  app.use('/contribute', governanceMiddleware(deps.governance));

  app.post('/contribute', async (c) => {
    // ── Validate request body (4.2): non-JSON / schema fail / empty dedupe
    //    keys → 400 invalid-request. No row written, orchestrate not entered.
    const parsed = await parseContributeBody(c);
    if (!parsed.ok) return parsed.response;
    const req = parsed.value;

    // ── Resolve the repository (4.3). null/throw → 500 persistence-error.
    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response;
    const repo = resolved.value;

    // ── upsertRaw FIRST (4.4) — observation-first: the raw report is the most
    //    valuable crowd-sourced asset, persisted even if parsing later fails.
    const landed = await landRaw(c, repo, req);
    if (!landed.ok) return landed.response;
    const rawId = landed.value;

    // ── orchestrate (4.5). raw is already persisted and is NOT rolled back on
    //    failure; config-error/insufficient responses carry the landed rawId so
    //    the client knows the observation is saved and a retry only re-parses
    //    (which re-triggers tier2 LLM — abuse cost is bounded by api-governance
    //    rate limiting).
    const input: RawProduct = { title: req.title, price: req.price, categoryHint: req.categoryHint };
    const outcome = await orchestrate(input, deps.makeLlm(c.env));

    if (outcome.kind === 'config-error') {
      return c.json({ error: 'config-error', message: outcome.message, rawId }, 500);
    }
    if (outcome.kind === 'insufficient') {
      return c.json({ error: 'insufficient-information', message: outcome.message, rawId }, 503);
    }

    // ── saveParsed on ok (4.6). calc is assembled directly from orchestrate's
    //    response (no recompute); uncomputable results (per100ml/formula=null)
    //    are persisted normally.
    const res = outcome.response;
    let saved: { productId: string; unitPriceId: string };
    try {
      saved = await repo.saveParsed({
        rawId,
        spec: res.spec,
        calc: { unitPrice: res.unitPrice, confidence: res.confidence, warnings: res.warnings },
      });
    } catch {
      return c.json({ error: 'persistence-error', message: 'failed to persist parsed result', rawId }, 500);
    }

    // ── Assemble + validate the response (4.7). Validation failure → internal.
    const validated = ContributeResponseSchema.safeParse({
      spec: res.spec,
      unitPrice: res.unitPrice,
      confidence: res.confidence,
      warnings: res.warnings,
      rawId,
      productId: saved.productId,
      unitPriceId: saved.unitPriceId,
    });
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 200);
  });

  // Governance runs on /ingest too, mounted BEFORE the handler (same order as
  // /parse and /contribute) so Hono — which matches by registration order —
  // wraps the route; mounting it after would leave /ingest unauthenticated.
  app.use('/ingest', governanceMiddleware(deps.governance));

  // POST /ingest — async crowd-sourced capture: land raw synchronously, return
  // 202 immediately, run orchestrate + saveParsed in the BACKGROUND. Shares the
  // "validate body → resolve repo → land raw" preamble with /contribute; the two
  // diverge only on parse timing (background) + response (202 {rawId}). The
  // request-path error code set is {invalid-request(400), persistence-error(500),
  // internal(500), accepted(202)} plus governance codes — NO insufficient-
  // information / config-error, because upsertRaw success is already a 202 and
  // any orchestrate/saveParsed failure happens in the background (logged only).
  app.post('/ingest', async (c) => {
    // ── Same preamble as /contribute (helpers keep the behavior identical).
    const parsed = await parseContributeBody(c);
    if (!parsed.ok) return parsed.response; // 400 invalid-request
    const req = parsed.value;

    const resolved = resolveRepo(c, deps);
    if (!resolved.ok) return resolved.response; // 500 persistence-error
    const repo = resolved.value;

    const landed = await landRaw(c, repo, req);
    if (!landed.ok) return landed.response; // 500 persistence-error
    const rawId = landed.value;

    // ── Background work unit: orchestrate (tier1+tier2+tier3) then saveParsed on
    //    `ok`. It is `async` and SELF-WRAPS try/catch so both synchronous and
    //    asynchronous failures stay confined to the background (a rejected
    //    promise handed to waitUntil) and NEVER propagate back to the already-
    //    decided 202 path. Three-state failure disposition: log only — no retry,
    //    no LLM re-burn (event-driven, each report parsed exactly once).
    const env = c.env;
    const input: RawProduct = { title: req.title, price: req.price, categoryHint: req.categoryHint };
    const run = async (): Promise<void> => {
      try {
        const outcome = await orchestrate(input, deps.makeLlm(env));
        if (outcome.kind === 'insufficient') {
          // tier2 transport failed + tier1 had no shape (e.g. a spec-less title):
          // log structured (rawId/store/sku) and stop — leaves the intentionally
          // accepted "raw, no product" intermediate state.
          console.warn('[ingest] background parse insufficient', {
            rawId,
            store: req.store,
            storeSku: req.storeSku,
          });
          return;
        }
        if (outcome.kind === 'config-error') {
          console.error('[ingest] background parse config-error', {
            rawId,
            store: req.store,
            storeSku: req.storeSku,
            message: outcome.message,
          });
          return;
        }
        // ok → saveParsed. calc is assembled directly from orchestrate's response
        // (no recompute); uncomputable (per100ml=null) is persisted normally.
        const res = outcome.response;
        await repo.saveParsed({
          rawId,
          spec: res.spec,
          calc: { unitPrice: res.unitPrice, confidence: res.confidence, warnings: res.warnings },
        });
      } catch (err) {
        // saveParsed throw (or any other background failure): log only, no
        // retry, no LLM re-burn. Keeps the "raw, no product" intermediate state.
        console.error('[ingest] background work failed', {
          rawId,
          store: req.store,
          storeSku: req.storeSku,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    };

    // ── Schedule the background work via the injected port (NEVER bare
    //    c.executionCtx). Production's waitUntil version returns void so this
    //    `await` resolves immediately (202 lands fast); the default/dev sync
    //    version awaits `run()` to completion (deterministic for tests).
    await (deps.scheduleBackground ?? ((_c, r) => r()))(c, run);

    // ── Validate the 202 body (rawId from upsertRaw is always non-empty, so this
    //    is a defensive guard); failure → 500 internal (mirrors /contribute).
    const validated = IngestResponseSchema.safeParse({ rawId });
    if (!validated.success) {
      return c.json({ error: 'internal', message: 'response failed validation' }, 500);
    }
    return c.json(validated.data, 202);
  });

  return app;
}
