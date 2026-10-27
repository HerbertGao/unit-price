// SpecParserLLM — the domain port for tier2. Input `RawProduct`, output a
// Zod-validated `ParsedSpec` or a DISTINGUISHABLE failure signal. The port
// speaks only domain language; it must NOT leak provider SDK types to callers.
//
// Failure taxonomy (discriminated union):
//  - transport: timeout / network / upstream 5xx / empty response (retryable)
//  - config:    Workers AI is not configured, or the credential was rejected
//  - invalid:   the model returned something that fails ParsedSpec Zod (rejected,
//               not silently adopted; downstream forces confidence <= 0.5)
//
// A structurally-valid object with all-empty fields is NOT a transport failure:
// it is a valid parse result that flows downstream into tier banding (typically
// the uncomputable terminal state).
import { APICallError } from '@ai-sdk/provider';
import { createAI, CloudflareAIError, type ModelOptions } from 'agents/models/ai-sdk';
import { LoadAPIKeyError, generateObject } from 'ai';
import type { Ai } from '@cloudflare/workers-types';
import { ParsedSpecSchema, type ParsedSpec, type RawProduct } from '@unit-price/core';
import {
  ConfigError,
  DEFAULT_MODEL,
  PARSE_REASONING_EFFORT,
  type LlmConfig,
  type WorkersAiBinding,
} from './config.js';

/** Optional per-call options. The `tier` slot reserves the future upgrade path
 * (validation-fail -> retry with a stronger model). This change implements only
 * the cheap tier; passing or omitting `tier` must both be legal. */
export interface ParseOptions {
  /** Reserved upgrade slot. Ignored (single tier only). */
  tier?: 'cheap' | 'strong';
}

export type ParseResult =
  | { ok: true; spec: ParsedSpec }
  | { ok: false; kind: 'transport'; message: string }
  | { ok: false; kind: 'config'; message: string }
  | { ok: false; kind: 'invalid'; message: string };

/** The domain port. Implementations return domain types only. */
export interface SpecParserLLM {
  parse(input: RawProduct, opts?: ParseOptions): Promise<ParseResult>;
}

const SYSTEM_PROMPT = [
  'You extract structured beverage specs from a product title.',
  'Return only the fields you can determine from the title; leave others null.',
  'Volume units must be one of ml, L, g, kg (normalize 毫升/mL -> ml, 升 -> L).',
  'Do NOT decide price, unit conversion, comparability, or category — leave category as given.',
  'multipliers must be [1]. Do not invent values.',
].join(' ');

function buildUserPrompt(input: RawProduct): string {
  return `Title: ${input.title}\nCategory: ${input.categoryHint ?? 'beverage'}`;
}

/**
 * createAI types `reasoningEffort` as low/medium/high/null. `null` is rewritten
 * to `chat_template_kwargs.enable_thinking` and the field is dropped, which
 * leaves this model's default (`high`) in place. The runtime value stays the
 * string "none"; the assertion only satisfies the provider's union.
 */
const PARSE_MODEL_OPTIONS = {
  reasoningEffort: PARSE_REASONING_EFFORT,
} as unknown as ModelOptions;

/**
 * Last-mile guarantee for the binding path: stamp `reasoning_effort: "none"`
 * on the object `env.AI.run` actually receives, even if the provider drops it.
 * Clef calls use the raw binding and never pass through this wrapper.
 */
function forceReasoningNone(binding: WorkersAiBinding): Ai {
  const wrapped: WorkersAiBinding = {
    run(model, inputs, options) {
      const body =
        inputs !== null && typeof inputs === 'object' && !Array.isArray(inputs)
          ? { ...inputs, reasoning_effort: PARSE_REASONING_EFFORT }
          : inputs;
      return binding.run(model, body, options);
    },
  };
  return wrapped as unknown as Ai;
}

function providerFor(config: LlmConfig) {
  if (config.binding) {
    return createAI({ binding: forceReasoningNone(config.binding) });
  }
  return createAI({
    accountId: config.accountId ?? '',
    apiToken: config.apiToken ?? '',
  });
}

function statusOf(err: unknown): number | undefined {
  if (err instanceof APICallError) return err.statusCode;
  if (err instanceof CloudflareAIError) return err.status;
  if (err !== null && typeof err === 'object' && 'statusCode' in err) {
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number') return status;
  }
  return undefined;
}

/**
 * Map a thrown AI-SDK / provider error to a distinguishable failure signal.
 * A missing binding or a rejected credential is `config` (not retryable);
 * everything else — empty response, no-object-generated, network/timeout/
 * upstream 5xx — is `transport`.
 */
function classifyError(err: unknown): ParseResult {
  if (err instanceof ConfigError || err instanceof LoadAPIKeyError) {
    return { ok: false, kind: 'config', message: err.message };
  }
  if (err instanceof CloudflareAIError && err.code === 'auth') {
    return { ok: false, kind: 'config', message: err.message };
  }
  const status = statusOf(err);
  if (status === 401 || status === 402 || status === 403) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, kind: 'config', message };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, kind: 'transport', message };
}

/**
 * AI-SDK implementation of the port: `generateObject` over Workers AI. The
 * model id comes from config. Output is re-validated against ParsedSpecSchema;
 * a failure is `invalid` (rejected, not silently adopted).
 */
export class AiSdkSpecParser implements SpecParserLLM {
  private readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    // Config is resolved by the caller from the injected request-time env
    // (no global process.env fallback — Workers has none at module load).
    this.config = config;
  }

  async parse(input: RawProduct, _opts?: ParseOptions): Promise<ParseResult> {
    // `_opts.tier` is the reserved upgrade slot; ignored.
    let raw: unknown;
    try {
      const provider = providerFor(this.config);
      const result = await generateObject({
        model: provider.languageModel(this.config.model, PARSE_MODEL_OPTIONS),
        schema: ParsedSpecSchema,
        system: SYSTEM_PROMPT,
        prompt: buildUserPrompt(input),
        maxOutputTokens: 1024,
      });
      raw = result.object;
    } catch (err) {
      return classifyError(err);
    }

    // Re-validate against the domain schema. generateObject already validates,
    // but re-checking keeps the port authoritative if a provider skips it.
    const parsed = ParsedSpecSchema.safeParse(raw);
    if (!parsed.success) {
      return { ok: false, kind: 'invalid', message: parsed.error.message };
    }
    return { ok: true, spec: parsed.data };
  }
}

export { DEFAULT_MODEL, PARSE_REASONING_EFFORT };
