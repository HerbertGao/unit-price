// Runtime-agnostic shape contract for `c.env` (the injected binding set).
//
// On Cloudflare Workers these come from the fetch handler's `env` argument
// (secrets + D1 + KV). On the Node dev entry the entry layer packs `process.env`
// into the same shape and injects it as `env`, so the app reads one path.
//
// All four are OPTIONAL at the type level (dev/no-op paths may lack them);
// required-ness is enforced at the injection entry at runtime, not by the type.
import type { D1Database, KVNamespace } from '@cloudflare/workers-types';

export interface Bindings {
  /** OpenRouter LLM key (secret). Used only by the stateless tier2 path. */
  OPENROUTER_API_KEY?: string;
  /** Governance allowlist (secret, comma-separated). Consumed by governance. */
  API_KEYS?: string;
  /** D1 database binding (production pipeline; not consumed by /parse). */
  DB?: D1Database;
  /** KV namespace for governance (rate-limit + usage counters). */
  GOVERNANCE_KV?: KVNamespace;
}

/**
 * Hono environment for the app: the binding set plus context Variables. Defined
 * on this shared leaf (both routes.ts and governance.ts already import Bindings
 * from here) so the `Variables` SOT lives alongside the `Bindings` SOT and the
 * existing `routes → governance` dependency direction is preserved.
 *
 * `govKey` is set by governanceMiddleware after auth so handlers can attribute
 * usage (e.g. batch overflow accounting) to the authenticated key.
 */
export type AppEnv = { Bindings: Bindings; Variables: { govKey: string } };
