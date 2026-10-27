// Node dev entry for @unit-price/api (dev-only; NOT the production runtime).
//
// Runtime boundary: this is the Node runtime adapter. It reuses the same
// runtime-agnostic app factory as the Workers entry (`worker.ts`), differing
// only in (a) packing `process.env` into the `Bindings` shape and injecting it
// as the per-request `env`, and (b) injecting a pass-through NO-OP governance so
// a keyless local dev (no KV, no API_KEYS) can smoke /parse without being
// blocked by 401/429.
//
// `process.env` appears ONLY here, at the entry layer — the app factory and
// routes never touch it. `@hono/node-server` is likewise dev-only.
import { serve } from '@hono/node-server';
import { createApp } from './routes.js';
import { createNoopGovernance } from './governance.js';
import { defaultMakeGuard, defaultMakeLlm } from './index.js';
import type { Bindings } from './bindings.js';

const port = Number(process.env.PORT ?? 8787);

// Pack the relevant process.env values into the Bindings shape so the app reads
// one path. KV / API_KEYS / DB are intentionally absent in local dev: the no-op
// governance does not need them. Node has no AI binding; tier2 uses the
// Cloudflare REST credentials when both are set. Clean titles never need them.
const bindings: Bindings = {
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID,
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN,
};

// `makeRepo` is intentionally NOT injected here: local Node dev has no D1
// binding, so `/contribute` takes the deterministic persistence-error branch
// (distinct from the LLM config-error), while `/parse` keeps working keylessly.
const app = createApp({
  makeLlm: defaultMakeLlm,
  makeGuard: defaultMakeGuard,
  governance: createNoopGovernance(),
});

serve({ fetch: (req: Request) => app.fetch(req, bindings), port }, (info) => {
  console.log(`[server] listening on http://localhost:${info.port}`);
});
