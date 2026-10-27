import { describe, expect, it, vi } from 'vitest';
import type { ParsedSpec, RawProduct } from '@unit-price/core';
import type { ParseGate, SpecGuard } from './clef.js';
import type { ParseResult, SpecParserLLM } from './llm.js';
import { orchestrate } from './orchestrate.js';

const DIRTY: RawProduct = { title: '农夫山泉', price: 5 };
const CLEAN: RawProduct = { title: '可口可乐 330ml*24听', price: 40 };

const FILLED: ParsedSpec = {
  unitSize: { value: 550, unit: 'ml' },
  quantity: 12,
  multipliers: [1],
  totalAmount: null,
  packageUnit: null,
  category: 'ignored-by-merge',
  confidence: 0.2,
};

function llm(result: ParseResult | (() => Promise<ParseResult>)): SpecParserLLM & { parse: ReturnType<typeof vi.fn> } {
  const parse = vi.fn(async () => (typeof result === 'function' ? result() : result));
  return { parse };
}

function guard(gate: ParseGate | Error, notes: string[] | Error = []): SpecGuard & {
  shouldParse: ReturnType<typeof vi.fn>;
  review: ReturnType<typeof vi.fn>;
} {
  return {
    shouldParse: vi.fn(async () => {
      if (gate instanceof Error) throw gate;
      return gate;
    }),
    review: vi.fn(async () => {
      if (notes instanceof Error) throw notes;
      return notes;
    }),
  };
}

describe('orchestrate guard', () => {
  it('does not call the guard or the generative parser on a determinate title', async () => {
    const port = llm({ ok: true, spec: FILLED });
    const g = guard('skip', ['should-not-appear']);
    const out = await orchestrate(CLEAN, port, g);
    expect(g.shouldParse).not.toHaveBeenCalled();
    expect(port.parse).not.toHaveBeenCalled();
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.response.spec.quantity).toBe(24);
      expect(out.response.warnings).not.toContain('should-not-appear');
    }
  });

  it('keeps the generative path when no guard is passed', async () => {
    const port = llm({ ok: false, kind: 'transport', message: 'down' });
    const out = await orchestrate(DIRTY, port);
    expect(port.parse).toHaveBeenCalledOnce();
    expect(out.kind).toBe('insufficient');
  });

  it('skips generateObject and keeps the tier1 spec when the gate says skip', async () => {
    const port = llm({ ok: true, spec: FILLED });
    const g = guard('skip');
    const out = await orchestrate(DIRTY, port, g);
    expect(port.parse).not.toHaveBeenCalled();
    expect(g.review).not.toHaveBeenCalled();
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.response.spec.quantity).toBeNull();
      expect(out.response.spec.unitSize).toBeNull();
      expect(out.response.warnings).toContain('标题未见可抽取规格，已跳过生成式解析');
    }
  });

  it('falls through to generateObject when the gate is unavailable or throws', async () => {
    const port = llm({ ok: false, kind: 'config', message: 'missing AI' });
    const thrown = guard(new Error('clef down'));
    const out = await orchestrate(DIRTY, port, thrown);
    expect(port.parse).toHaveBeenCalledOnce();
    expect(out).toMatchObject({ kind: 'config-error', message: 'missing AI' });

    const unavailable = guard('unavailable');
    const port2 = llm({ ok: false, kind: 'transport', message: 'down' });
    const out2 = await orchestrate(DIRTY, port2, unavailable);
    expect(port2.parse).toHaveBeenCalledOnce();
    expect(out2.kind).toBe('insufficient');
  });

  it('appends review warnings and does not rewrite the merged spec', async () => {
    const port = llm({ ok: true, spec: FILLED });
    const g = guard('parse', ['数量与标题不一致，结果未改写']);
    const out = await orchestrate(DIRTY, port, g);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') {
      expect(out.response.spec.quantity).toBe(12);
      expect(out.response.spec.unitSize).toEqual({ value: 550, unit: 'ml' });
      expect(out.response.spec.category).toBe('beverage');
      expect(out.response.warnings).toContain('数量与标题不一致，结果未改写');
    }
    expect(g.review).toHaveBeenCalledOnce();
  });

  it('ignores a review failure and still returns the merged spec', async () => {
    const port = llm({ ok: true, spec: FILLED });
    const g = guard('parse', new Error('review down'));
    const out = await orchestrate(DIRTY, port, g);
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok') expect(out.response.spec.quantity).toBe(12);
  });
});
