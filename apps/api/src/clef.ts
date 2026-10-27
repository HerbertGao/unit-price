// Clef-flash complement for tier2. It answers typed yes/no questions and never
// fills ParsedSpec. The generative parser still owns unitSize / quantity /
// every other spec field. A Clef failure does not become a parse failure:
// the caller treats "unavailable" as "fall through to generateObject" and an
// empty review as "no extra warning".
import type { ParsedSpec, RawProduct } from '@unit-price/core';
import {
  CLEF_MODEL,
  CLEF_MODEL_SELECTOR,
  type LlmConfig,
  runWorkersAi,
} from './config.js';

/** Whether the generative parser should run. `unavailable` means "do not skip". */
export type ParseGate = 'parse' | 'skip' | 'unavailable';

/**
 * Guardrail port beside SpecParserLLM. Implementations must not return a spec.
 */
export interface SpecGuard {
  shouldParse(input: RawProduct): Promise<ParseGate>;
  review(input: RawProduct, spec: ParsedSpec): Promise<string[]>;
}

/** Below this P(extractable) the generative call is skipped. */
export const EXTRACTABLE_SKIP_BELOW = 0.35;

/** At or above this probability a review warning is attached. The spec stays. */
export const REVIEW_WARN_AT = 0.75;

export const WARN_QTY_SUSPICIOUS = '数量与标题不一致，结果未改写';
export const WARN_DUAL_PRODUCT = '标题像是多件商品拼在一起，规格未拆分';

const EXTRACTABLE_QUESTION = [
  'Does this product title contain a measurable packaged volume, weight, or count',
  '(such as 330ml, 1.5L, 500g, or 24 cans) that a spec parser could extract?',
  'Answer yes when any such spec is present.',
  'Answer no for a bare brand or flavor name with no measurable spec.',
].join(' ');

const QTY_QUESTION = [
  'The state includes a parser quantity.',
  'Is that quantity inconsistent with this title as one product',
  '(a size or percent read as a count, or a count taken from a different product)?',
  'Answer yes only when the number clearly does not match.',
  'Answer no when it matches, when quantity is null, or when you are unsure.',
].join(' ');

const DUAL_QUESTION = [
  'Does this title describe two or more distinct products bundled together,',
  'rather than one product and its pack count?',
  'Answer yes for a lookalike pair or a multi-product bundle.',
  'Answer no for one product, including a multipack of that same product.',
].join(' ');

function answersOf(raw: unknown): Record<string, unknown> | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const answers = (raw as { answers?: unknown }).answers;
  if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) return undefined;
  return answers as Record<string, unknown>;
}

/** Probability that a noul answer is "yes". Missing or non-finite → undefined. */
export function readNoul(answer: unknown): number | undefined {
  if (typeof answer === 'number' && Number.isFinite(answer)) return answer;
  if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return undefined;
  const record = answer as Record<string, unknown>;
  for (const key of ['noul', 'probability', 'yes']) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function formatMeasurement(spec: ParsedSpec): string {
  if (spec.unitSize == null) return 'null';
  return `${spec.unitSize.value}${spec.unitSize.unit}`;
}

async function ask(config: LlmConfig, state: string, questions: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const raw = await runWorkersAi(config, CLEF_MODEL, {
    model: CLEF_MODEL_SELECTOR,
    state,
    questions,
  });
  return answersOf(raw);
}

/**
 * Clef-flash guard. `shouldParse` runs only when tier1 is not already
 * determinate. `review` runs only after a successful generative merge.
 */
export class ClefSpecGuard implements SpecGuard {
  private readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    this.config = config;
  }

  async shouldParse(input: RawProduct): Promise<ParseGate> {
    const answers = await ask(this.config, input.title, {
      extractable: { type: 'noul', instructions: EXTRACTABLE_QUESTION },
    });
    const probability = readNoul(answers?.extractable);
    if (probability === undefined) return 'parse';
    return probability < EXTRACTABLE_SKIP_BELOW ? 'skip' : 'parse';
  }

  async review(input: RawProduct, spec: ParsedSpec): Promise<string[]> {
    const state = [
      `Title: ${input.title}`,
      `Quantity: ${spec.quantity ?? 'null'}`,
      `Unit size: ${formatMeasurement(spec)}`,
    ].join('\n');
    const answers = await ask(this.config, state, {
      qtySuspicious: { type: 'noul', instructions: QTY_QUESTION },
      dualProduct: { type: 'noul', instructions: DUAL_QUESTION },
    });
    const warnings: string[] = [];
    const qty = readNoul(answers?.qtySuspicious);
    if (spec.quantity != null && qty !== undefined && qty >= REVIEW_WARN_AT) {
      warnings.push(WARN_QTY_SUSPICIOUS);
    }
    const dual = readNoul(answers?.dualProduct);
    if (dual !== undefined && dual >= REVIEW_WARN_AT) {
      warnings.push(WARN_DUAL_PRODUCT);
    }
    return warnings;
  }
}
