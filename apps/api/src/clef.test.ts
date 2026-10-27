import { describe, expect, it, vi } from 'vitest';
import type { ParsedSpec, RawProduct } from '@unit-price/core';
import {
  CLEF_MODEL,
  ClefSpecGuard,
  EXTRACTABLE_SKIP_BELOW,
  REVIEW_WARN_AT,
  WARN_DUAL_PRODUCT,
  WARN_QTY_SUSPICIOUS,
  readNoul,
} from './clef.js';
import type { WorkersAiBinding } from './config.js';

const RAW: RawProduct = { title: '农夫山泉', price: 5 };

const SPEC: ParsedSpec = {
  unitSize: { value: 330, unit: 'ml' },
  quantity: 24,
  multipliers: [1],
  totalAmount: null,
  packageUnit: null,
  category: 'beverage',
  confidence: 0.4,
};

function bindingReturning(body: unknown): WorkersAiBinding & { run: ReturnType<typeof vi.fn> } {
  return { run: vi.fn(async () => body) };
}

describe('readNoul', () => {
  it('reads a bare number or a noul/probability/yes field', () => {
    expect(readNoul(0.2)).toBe(0.2);
    expect(readNoul({ noul: 0.8 })).toBe(0.8);
    expect(readNoul({ probability: 0.1 })).toBe(0.1);
    expect(readNoul({ yes: 0.4 })).toBe(0.4);
    expect(readNoul({ noul: Number.NaN })).toBeUndefined();
    expect(readNoul('yes')).toBeUndefined();
  });
});

describe('ClefSpecGuard.shouldParse', () => {
  it('skips only below the extractable threshold', async () => {
    const low = bindingReturning({ answers: { extractable: { noul: EXTRACTABLE_SKIP_BELOW - 0.01 } } });
    expect(await new ClefSpecGuard({ model: CLEF_MODEL, binding: low }).shouldParse(RAW)).toBe('skip');

    const edge = bindingReturning({ answers: { extractable: { noul: EXTRACTABLE_SKIP_BELOW } } });
    expect(await new ClefSpecGuard({ model: CLEF_MODEL, binding: edge }).shouldParse(RAW)).toBe('parse');
  });

  it('does not skip when the probability is missing', async () => {
    const binding = bindingReturning({ answers: {} });
    expect(await new ClefSpecGuard({ model: CLEF_MODEL, binding }).shouldParse(RAW)).toBe('parse');
  });

  it('asks clef-flash a noul question and does not return a spec', async () => {
    const binding = bindingReturning({ answers: { extractable: { noul: 0.9 } } });
    const gate = await new ClefSpecGuard({ model: CLEF_MODEL, binding }).shouldParse(RAW);
    expect(gate).toBe('parse');
    expect(binding.run).toHaveBeenCalledWith(
      '@cf/cloudflare/clef-flash',
      expect.objectContaining({
        model: 'clef-flash',
        state: RAW.title,
        questions: { extractable: expect.objectContaining({ type: 'noul' }) },
      }),
    );
  });

  it('propagates a binding failure (the caller maps it to unavailable)', async () => {
    const binding = { run: vi.fn(async () => { throw new Error('down'); }) };
    await expect(new ClefSpecGuard({ model: CLEF_MODEL, binding }).shouldParse(RAW)).rejects.toThrow('down');
  });
});

describe('ClefSpecGuard.review', () => {
  it('warns on a suspicious quantity and a dual-product title without rewriting the spec', async () => {
    const binding = bindingReturning({
      answers: {
        qtySuspicious: { noul: REVIEW_WARN_AT },
        dualProduct: { noul: REVIEW_WARN_AT },
      },
    });
    const before = { ...SPEC, unitSize: { ...SPEC.unitSize! } };
    const warnings = await new ClefSpecGuard({ model: CLEF_MODEL, binding }).review(RAW, SPEC);
    expect(warnings).toEqual([WARN_QTY_SUSPICIOUS, WARN_DUAL_PRODUCT]);
    expect(SPEC).toEqual(before);
    const body = binding.run.mock.calls[0]?.[1] as { questions: Record<string, { type: string }> };
    expect(body.questions.qtySuspicious.type).toBe('noul');
    expect(body.questions.dualProduct.type).toBe('noul');
  });

  it('does not warn on quantity when the spec quantity is null', async () => {
    const binding = bindingReturning({
      answers: { qtySuspicious: { noul: 0.99 }, dualProduct: { noul: 0.1 } },
    });
    const warnings = await new ClefSpecGuard({ model: CLEF_MODEL, binding }).review(RAW, {
      ...SPEC,
      quantity: null,
    });
    expect(warnings).toEqual([]);
  });

  it('stays quiet below the review threshold', async () => {
    const binding = bindingReturning({
      answers: { qtySuspicious: { noul: REVIEW_WARN_AT - 0.01 }, dualProduct: { noul: 0.74 } },
    });
    const warnings = await new ClefSpecGuard({ model: CLEF_MODEL, binding }).review(RAW, SPEC);
    expect(warnings).toEqual([]);
  });
});
