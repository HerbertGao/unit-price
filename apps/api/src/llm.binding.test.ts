import { describe, expect, it, vi } from 'vitest';
import { AI_GATEWAY_ID_HEADER, DEFAULT_MODEL, PARSE_REASONING_EFFORT } from './config.js';
import { AiSdkSpecParser } from './llm.js';
import type { RawProduct } from '@unit-price/core';

const RAW: RawProduct = { title: '可乐 330ml*24', price: 40 };

const SPEC = {
  unitSize: { value: 330, unit: 'ml' },
  quantity: 24,
  multipliers: [1],
  totalAmount: null,
  packageUnit: null,
  category: 'beverage',
  confidence: 0.7,
};

function chatCompletion(inputs: Record<string, unknown>): Response {
  const tools = inputs.tools as Array<{ function?: { name?: string } }> | undefined;
  const toolName = tools?.[0]?.function?.name;
  const message =
    toolName !== undefined
      ? {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: toolName, arguments: JSON.stringify(SPEC) },
            },
          ],
        }
      : { role: 'assistant', content: JSON.stringify(SPEC) };
  return new Response(
    JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      model: DEFAULT_MODEL,
      choices: [{ index: 0, finish_reason: toolName ? 'tool_calls' : 'stop', message }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
    { headers: { 'content-type': 'application/json' } },
  );
}

function gatewayIdOf(headers: HeadersInit | undefined): string | null {
  if (headers instanceof Headers) return headers.get(AI_GATEWAY_ID_HEADER);
  if (Array.isArray(headers)) {
    const found = headers.find(([name]) => name.toLowerCase() === AI_GATEWAY_ID_HEADER);
    return found === undefined ? null : found[1];
  }
  if (headers === undefined) return null;
  const record = headers as Record<string, string>;
  return record[AI_GATEWAY_ID_HEADER] ?? null;
}

describe('AiSdkSpecParser binding wire', () => {
  it('calls the AI binding with the DeepSeek model, reasoning_effort none, and gateway unit-price', async () => {
    const calls: Array<{
      model: string;
      inputs: Record<string, unknown>;
      options?: Record<string, unknown>;
    }> = [];
    const binding = {
      async run(model: string, inputs: Record<string, unknown>, options?: Record<string, unknown>) {
        calls.push({ model, inputs, options });
        return chatCompletion(inputs);
      },
    };
    const parser = new AiSdkSpecParser({ model: DEFAULT_MODEL, binding });
    const res = await parser.parse(RAW);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.spec.quantity).toBe(24);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.model).toBe('@cf/deepseek-ai/deepseek-v4.1-flash-1017');
    expect(calls[0]?.inputs.reasoning_effort).toBe(PARSE_REASONING_EFFORT);
    expect(calls[0]?.inputs.reasoning_effort).toBe('none');
    expect(calls[0]?.options).toMatchObject({
      gateway: { id: 'unit-price' },
      returnRawResponse: true,
    });
  });

  it('sends the REST path through the same gateway id and reasoning_effort none', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return chatCompletion(body);
    });
    try {
      const parser = new AiSdkSpecParser({
        model: DEFAULT_MODEL,
        accountId: 'acct',
        apiToken: 'tok',
      });
      const res = await parser.parse(RAW);
      expect(res.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalled();
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(String(url)).toBe(
        'https://api.cloudflare.com/client/v4/accounts/acct/ai/run/@cf/deepseek-ai/deepseek-v4.1-flash-1017',
      );
      expect(gatewayIdOf(init?.headers)).toBe('unit-price');
      const body = JSON.parse(String(init?.body)) as { reasoning_effort?: unknown };
      expect(body.reasoning_effort).toBe('none');
    } finally {
      fetchMock.mockRestore();
    }
  });
});
