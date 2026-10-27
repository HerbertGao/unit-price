// Runtime/config boundary for Workers AI. A missing binding (and no
// out-of-Worker Cloudflare credentials) is a CONFIG error, not a transient
// transport failure. Callers surface a distinguishable config-error; they
// never treat it as retryable.
//
// Production reaches Workers AI through the `AI` binding, billed on the
// Cloudflare account (Workers Paid or AI Gateway credits). Node dev and the
// eval CLI have no binding, so they may pass an account id plus an API token;
// that REST path is the same Workers AI bill, not a third-party vendor.

import type { Bindings } from './bindings.js';

/** Default generative model for tier2 title parsing. */
export const DEFAULT_MODEL = '@cf/deepseek-ai/deepseek-v4.1-flash-1017';

/**
 * Wire value for the parse path. This model defaults to `high` and spends
 * output tokens on reasoning. `none` turns that off. The provider's typed
 * `null` is a different signal (it drops the field), so the string is required.
 */
export const PARSE_REASONING_EFFORT = 'none' as const;

/** Decision model used beside generative parsing. It does not fill specs. */
export const CLEF_MODEL = '@cf/cloudflare/clef-flash';

/** `model` selector Clef-flash requires in the request body. */
export const CLEF_MODEL_SELECTOR = 'clef-flash';

/** Minimal binding surface. The real Workers `Ai` binding satisfies it. */
export interface WorkersAiBinding {
  run(
    model: string,
    inputs: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
}

export interface LlmConfig {
  model: string;
  /** Set when the request env carries an AI binding. Preferred over REST. */
  binding?: WorkersAiBinding;
  /** Set together with `apiToken` for the out-of-Worker REST path. */
  accountId?: string;
  apiToken?: string;
}

/**
 * Thrown when Workers AI is not configured. Distinguishable from a transient
 * transport failure.
 */
export class ConfigError extends Error {
  readonly kind = 'config' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const MISSING_CONFIG =
  'Missing Workers AI binding (AI), or CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN (configuration error, not a transport failure)';

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function hasBinding(env: Pick<Bindings, 'AI'>): env is { AI: WorkersAiBinding } {
  return typeof env.AI?.run === 'function';
}

/**
 * Read LLM config from the INJECTED env (no global `process.env` fallback —
 * Workers has no module-load-time env). Throws `ConfigError` when neither the
 * AI binding nor both REST credentials are present. The binding wins when both
 * are set, so a Worker never sends a token it does not need.
 */
export function loadLlmConfig(
  env: Pick<Bindings, 'AI' | 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_TOKEN'>,
  model = DEFAULT_MODEL,
): LlmConfig {
  if (hasBinding(env)) {
    return { model, binding: env.AI };
  }
  const accountId = nonEmpty(env.CLOUDFLARE_ACCOUNT_ID);
  const apiToken = nonEmpty(env.CLOUDFLARE_API_TOKEN);
  if (accountId !== undefined && apiToken !== undefined) {
    return { model, accountId, apiToken };
  }
  throw new ConfigError(MISSING_CONFIG);
}

/** True when `loadLlmConfig` would succeed for this env. */
export function configPresent(
  env: Pick<Bindings, 'AI' | 'CLOUDFLARE_ACCOUNT_ID' | 'CLOUDFLARE_API_TOKEN'>,
): boolean {
  if (hasBinding(env)) return true;
  return nonEmpty(env.CLOUDFLARE_ACCOUNT_ID) !== undefined && nonEmpty(env.CLOUDFLARE_API_TOKEN) !== undefined;
}

/**
 * Run one Workers AI model. The binding returns the bare result. The REST API
 * wraps it in `{ success, result }`, which is unwrapped here.
 */
export async function runWorkersAi(
  config: LlmConfig,
  model: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  if (config.binding) {
    return config.binding.run(model, input);
  }
  const accountId = encodeURIComponent(config.accountId ?? '');
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiToken ?? ''}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text === '' ? undefined : JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (!response.ok) {
    const err = new Error(`Workers AI HTTP ${response.status}`);
    (err as Error & { statusCode: number }).statusCode = response.status;
    throw err;
  }
  if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as { success?: unknown; result?: unknown };
    if (record.success === false) {
      throw new Error('Workers AI request failed');
    }
    if (record.success === true && 'result' in record) return record.result;
  }
  return body;
}
