import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoadAPIKeyError } from 'ai';
import {
  AI_GATEWAY_ID,
  AI_GATEWAY_ID_HEADER,
  ConfigError,
  DEFAULT_MODEL,
  configPresent,
  loadLlmConfig,
  runWorkersAi,
  workersAiRunOptions,
} from './config.js';
import { AiSdkSpecParser } from './llm.js';
import { ParsedSpecSchema, type RawProduct } from '@unit-price/core';

// Mock only `generateObject`; keep the real `LoadAPIKeyError` so classifyError's
// `instanceof` check stays meaningful. Provider construction still runs.
const generateObjectMock = vi.fn();
vi.mock('ai', async (importActual) => {
  const actual = await importActual<typeof import('ai')>();
  return { ...actual, generateObject: (...args: unknown[]) => generateObjectMock(...args) };
});

const RAW: RawProduct = { title: '可乐 330ml*24', price: 40 };
const TEST_CFG = { accountId: 'acct', apiToken: 'tok', model: DEFAULT_MODEL };

describe('config boundary (missing Workers AI vs transport)', () => {
  it('loadLlmConfig throws a distinguishable ConfigError when nothing is configured', () => {
    expect(() => loadLlmConfig({}, DEFAULT_MODEL)).toThrowError(ConfigError);
    try {
      loadLlmConfig({}, DEFAULT_MODEL);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as ConfigError).kind).toBe('config');
    }
  });

  it('REST credentials yield account id + token; model from the constant', () => {
    const cfg = loadLlmConfig({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' });
    expect(cfg.accountId).toBe('acct');
    expect(cfg.apiToken).toBe('tok');
    expect(cfg.binding).toBeUndefined();
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(DEFAULT_MODEL).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
  });

  it('the AI binding wins over REST credentials', () => {
    const binding = { run: vi.fn() };
    const cfg = loadLlmConfig({
      AI: binding,
      CLOUDFLARE_ACCOUNT_ID: 'acct',
      CLOUDFLARE_API_TOKEN: 'tok',
    });
    expect(cfg.binding).toBe(binding);
    expect(cfg.accountId).toBeUndefined();
    expect(cfg.apiToken).toBeUndefined();
  });

  it('a binding without run, or only one REST credential, is absent', () => {
    expect(() => loadLlmConfig({ AI: {} as never })).toThrowError(ConfigError);
    expect(() => loadLlmConfig({ CLOUDFLARE_ACCOUNT_ID: 'acct' })).toThrowError(ConfigError);
    expect(() => loadLlmConfig({ CLOUDFLARE_API_TOKEN: 'tok' })).toThrowError(ConfigError);
    expect(configPresent({ AI: {} as never })).toBe(false);
    expect(configPresent({ CLOUDFLARE_ACCOUNT_ID: 'acct' })).toBe(false);
  });

  it('empty/whitespace credentials are treated as absent', () => {
    expect(() =>
      loadLlmConfig({ CLOUDFLARE_ACCOUNT_ID: '  ', CLOUDFLARE_API_TOKEN: 'tok' }),
    ).toThrowError(ConfigError);
    expect(configPresent({ CLOUDFLARE_ACCOUNT_ID: '  ', CLOUDFLARE_API_TOKEN: ' tok ' })).toBe(false);
    expect(configPresent({ CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' })).toBe(true);
    expect(configPresent({ AI: { run: vi.fn() } })).toBe(true);
  });

  it('a non-default model id is honored (config-driven model switch)', () => {
    const cfg = loadLlmConfig(
      { CLOUDFLARE_ACCOUNT_ID: 'acct', CLOUDFLARE_API_TOKEN: 'tok' },
      '@cf/other/model',
    );
    expect(cfg.model).toBe('@cf/other/model');
  });
});

describe('workersAiRunOptions', () => {
  it('forces gateway id unit-price and keeps options already on the call', () => {
    expect(workersAiRunOptions({ returnRawResponse: true, gateway: { skipCache: false } })).toEqual({
      returnRawResponse: true,
      gateway: { skipCache: false, id: 'unit-price' },
    });
    expect(AI_GATEWAY_ID).toBe('unit-price');
  });
});

describe('runWorkersAi', () => {
  it('returns the binding result unchanged and passes the gateway id', async () => {
    const binding = { run: vi.fn(async () => ({ answers: { extractable: { noul: 0.9 } } })) };
    const raw = await runWorkersAi({ model: DEFAULT_MODEL, binding }, '@cf/cloudflare/clef-flash', {
      model: 'clef-flash',
    });
    expect(binding.run).toHaveBeenCalledWith(
      '@cf/cloudflare/clef-flash',
      { model: 'clef-flash' },
      { gateway: { id: 'unit-price' } },
    );
    expect(raw).toEqual({ answers: { extractable: { noul: 0.9 } } });
  });

  it('unwraps the REST { success, result } envelope', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, result: { answers: { a: 1 } } }), { status: 200 }),
    );
    const raw = await runWorkersAi(
      { model: DEFAULT_MODEL, accountId: 'acct', apiToken: 'tok' },
      '@cf/cloudflare/clef-flash',
      { model: 'clef-flash' },
    );
    expect(raw).toEqual({ answers: { a: 1 } });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/cloudflare/clef-flash',
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok');
    expect(headers[AI_GATEWAY_ID_HEADER]).toBe('unit-price');
    fetchMock.mockRestore();
  });

  it('marks a non-OK REST response with statusCode', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('nope', { status: 401 }));
    await expect(
      runWorkersAi({ model: DEFAULT_MODEL, accountId: 'acct', apiToken: 'tok' }, '@cf/x', {}),
    ).rejects.toMatchObject({ statusCode: 401 });
    vi.restoreAllMocks();
  });
});

describe('AiSdkSpecParser — upgrade slot is shape-only', () => {
  it('accepts an optional tier option without changing behavior (type-level)', () => {
    const parser = new AiSdkSpecParser(TEST_CFG);
    expect(typeof parser.parse).toBe('function');
  });
});

describe('AiSdkSpecParser.parse — failure classification (mocked generateObject)', () => {
  afterEach(() => {
    generateObjectMock.mockReset();
  });

  it('config: LoadAPIKeyError -> { ok:false, kind:"config" }', async () => {
    generateObjectMock.mockRejectedValueOnce(new LoadAPIKeyError({ message: 'missing key' }));
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ ok: false, kind: 'config' });
  });

  it('config: HTTP 401/402/403 -> { ok:false, kind:"config" }', async () => {
    const err = new Error('payment required');
    (err as Error & { statusCode: number }).statusCode = 402;
    generateObjectMock.mockRejectedValueOnce(err);
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res).toMatchObject({ ok: false, kind: 'config', message: 'payment required' });
  });

  it('transport: a plain Error -> { ok:false, kind:"transport" }', async () => {
    generateObjectMock.mockRejectedValueOnce(new Error('timeout'));
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res).toMatchObject({ ok: false, kind: 'transport', message: 'timeout' });
  });

  it('invalid: object failing ParsedSpec Zod -> { ok:false, kind:"invalid" } (no fabricated spec)', async () => {
    generateObjectMock.mockResolvedValueOnce({ object: { unitSize: '乱' } });
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res).toMatchObject({ ok: false, kind: 'invalid' });
    expect((res as { spec?: unknown }).spec).toBeUndefined();
  });

  it('ok: a valid ParsedSpec object -> { ok:true, spec } and re-validates via Zod', async () => {
    generateObjectMock.mockResolvedValueOnce({
      object: {
        unitSize: { value: 330, unit: 'ml' },
        quantity: 24,
        multipliers: [1],
        totalAmount: null,
        packageUnit: null,
        category: 'beverage',
        confidence: 0.7,
      },
    });
    const parser = new AiSdkSpecParser(TEST_CFG);
    const res = await parser.parse(RAW);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.spec.unitSize).toEqual({ value: 330, unit: 'ml' });
      expect(res.spec.quantity).toBe(24);
      expect(ParsedSpecSchema.safeParse(res.spec).success).toBe(true);
    }
  });
});
