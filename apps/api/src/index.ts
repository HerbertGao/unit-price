// @unit-price/api — Hono backend (public API + LLM tier2).
// Wires the AI-SDK SpecParserLLM port into the POST /parse orchestration.
//
// Config vs runtime boundary: clean titles parse via tier1 with no model call, so
// the app builds even without a Workers AI binding. A missing binding only
// surfaces as a distinguishable runtime config-error if a request reaches tier2.
import type { ParsedSpec, RawProduct } from '@unit-price/core';
import { createDb, createRepository, type Db, type Repository } from '@unit-price/db';
import type { Bindings } from './bindings.js';
import { ClefSpecGuard, type ParseGate, type SpecGuard } from './clef.js';
import { ConfigError, loadLlmConfig } from './config.js';
import { AiSdkSpecParser, type ParseOptions, type ParseResult, type SpecParserLLM } from './llm.js';
import { createApp } from './routes.js';
import { createRealGovernance } from './governance.js';

export { createApp, type AppDeps } from './routes.js';
export {
  createRealGovernance,
  createNoopGovernance,
  governanceMiddleware,
  type Governance,
} from './governance.js';
export {
  ParseRequestSchema,
  ParseResponseSchema,
  ContributeRequestSchema,
  ContributeResponseSchema,
  IngestResponseSchema,
  BatchIngestRequestSchema,
  BatchIngestResponseSchema,
  type ContributeRequest,
  type ContributeResponse,
  type IngestResponse,
  type BatchIngestRequest,
  type BatchIngestResponse,
} from './routes.js';
// The rankings contract is re-exported FROM @unit-price/api-client (the shared
// single source of truth), keeping `@unit-price/api` downstream consumers
// unbroken while the definition lives in the transport-agnostic client package.
export {
  type RankingsItem,
} from '@unit-price/api-client';
export {
  orchestrate,
  type ParseResponse,
  type OrchestrationOutcome,
} from './orchestrate.js';
export {
  tagProduct,
  runBackfill,
  listProductsForBackfill,
  type TagProductInput,
  type TagProductResult,
  type BackfillResult,
} from './tagging.js';
export {
  AiSdkSpecParser,
  type SpecParserLLM,
  type ParseResult,
  type ParseOptions,
} from './llm.js';
export {
  ConfigError,
  CLEF_MODEL,
  DEFAULT_MODEL,
  PARSE_REASONING_EFFORT,
  loadLlmConfig,
  configPresent,
} from './config.js';
export { ClefSpecGuard, type SpecGuard, type ParseGate } from './clef.js';
export type { Bindings } from './bindings.js';

/**
 * A thin lazy wrapper bound to ONE request's injected env. It defers
 * `loadLlmConfig(env)` (which throws ConfigError on a missing key) until the
 * first parse, so building the app never throws and clean titles keep working
 * without a key. Built per request (see `makeLlm`) so two requests with
 * different env never share a resolved config — no isolate cross-request bleed.
 */
class LazySpecParser implements SpecParserLLM {
  private inner: AiSdkSpecParser | null = null;

  private readonly env: Bindings;

  constructor(env: Bindings | undefined) {
    // Hono passes `c.env` which is `undefined` when no env is injected (e.g. a
    // bare Node entry not yet bridging env). Treat that as an empty env so a
    // missing key surfaces as ConfigError, not a TypeError.
    this.env = env ?? {};
  }

  async parse(input: RawProduct, opts?: ParseOptions): Promise<ParseResult> {
    if (this.inner === null) {
      try {
        this.inner = new AiSdkSpecParser(loadLlmConfig(this.env));
      } catch (err) {
        if (err instanceof ConfigError) {
          return { ok: false, kind: 'config', message: err.message };
        }
        throw err;
      }
    }
    return this.inner.parse(input, opts);
  }
}

/**
 * The default LLM factory: a fresh env-bound lazy parser per request from the
 * injected `c.env`, so config is resolved at request time from each request's
 * own env (no cross-request env bleed). Shared by the production Workers entry
 * (`buildApp`/`worker.ts`) and the Node dev entry (`server.ts`) so both wire the
 * same parser, differing only in the injected governance.
 */
export const defaultMakeLlm = (env: Bindings): SpecParserLLM => new LazySpecParser(env);

/**
 * Clef guard for the same request env. Missing Workers AI config resolves to
 * "do not skip" / no warnings, so the generative port still reports config-error.
 * Built per request, same as `makeLlm`.
 */
class LazyClefGuard implements SpecGuard {
  private inner: ClefSpecGuard | null = null;
  private readonly env: Bindings;

  constructor(env: Bindings | undefined) {
    this.env = env ?? {};
  }

  private resolve(): ClefSpecGuard | null {
    if (this.inner) return this.inner;
    try {
      this.inner = new ClefSpecGuard(loadLlmConfig(this.env));
      return this.inner;
    } catch (err) {
      if (err instanceof ConfigError) return null;
      throw err;
    }
  }

  async shouldParse(input: RawProduct): Promise<ParseGate> {
    const inner = this.resolve();
    if (!inner) return 'unavailable';
    try {
      return await inner.shouldParse(input);
    } catch {
      return 'unavailable';
    }
  }

  async review(input: RawProduct, spec: ParsedSpec): Promise<string[]> {
    const inner = this.resolve();
    if (!inner) return [];
    try {
      return await inner.review(input, spec);
    } catch {
      return [];
    }
  }
}

export const defaultMakeGuard = (env: Bindings): SpecGuard => new LazyClefGuard(env);

/**
 * The default Repository factory: builds a fresh repo from THIS request's
 * injected `c.env.DB`, mirroring `makeLlm` (no isolate cross-request env bleed).
 * Returns `null` when no D1 is bound so `/contribute` takes the persistence-error
 * branch; `createDb`/`createRepository` throw on an invalid binding, which the
 * route catches and maps to persistence-error.
 */
export const defaultMakeRepo = (env: Bindings): Repository | null =>
  env.DB ? createRepository(createDb(env.DB)) : null;

/** 默认 Db 工厂:从本请求 env.DB 建 Db(供 admin backfill 游标读)。无 DB 绑定→null。 */
export const defaultMakeDb = (env: Bindings): Db | null =>
  env.DB ? createDb(env.DB) : null;

/**
 * Build the production app with the real AI-SDK port, the REAL governance
 * implementation, and the real D1-backed repository factory. The production
 * Workers entry (`worker.ts`) uses this; it must never be given the no-op
 * governance (public-endpoint wide-open guardrail).
 */
export function buildApp() {
  return createApp({
    makeLlm: defaultMakeLlm,
    makeGuard: defaultMakeGuard,
    governance: createRealGovernance(),
    makeRepo: defaultMakeRepo,
    makeDb: defaultMakeDb,
    adminGovernance: createRealGovernance({ allowlistVar: 'ADMIN_API_KEYS' }),
    // Production background-execution port: schedule /ingest's post-response work
    // (orchestrate + saveParsed) on the Workers ExecutionContext so it continues
    // after the 202 is sent within the same invocation. The closure captures the
    // PER-REQUEST `c` at CALL time (not at build time), and returns void
    // (waitUntil returns void) so the handler's `await` resolves immediately —
    // the 202 lands fast and is never blocked on `run()`.
    scheduleBackground: (c, run) => c.executionCtx.waitUntil(run()),
  });
}

export default buildApp;
