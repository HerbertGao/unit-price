import { parseProductTrust, type ProductTrust } from '@unit-price/api-client';

export class TrustNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustNotFound';
  }
}

function messageOf(data: unknown): string | undefined {
  if (typeof data !== 'object' || data == null) return undefined;
  if (!('message' in data)) return undefined;
  const message = data.message;
  if (typeof message !== 'string') return undefined;
  const trimmed = message.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Turn a trust HTTP result into a payload, or throw. Non-200 is never parsed. */
export function acceptTrustResponse(statusCode: number, data: unknown): ProductTrust {
  if (statusCode === 404) {
    throw new TrustNotFound(messageOf(data) ?? '榜单里没有这件商品');
  }
  if (statusCode !== 200) {
    throw new Error(`trust ${statusCode}`);
  }
  return parseProductTrust(data);
}
