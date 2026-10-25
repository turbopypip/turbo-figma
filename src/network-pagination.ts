import { createHmac, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { parseNetworkSelection, type NetworkQuery } from './network.js';

export const RESPONSE_LIMITS = { minBytes: 4096, maxBytes: 150000 } as const;
const secret = randomBytes(32);
export function responseBudget(params: NetworkQuery) {
  if (params.format !== undefined && !['context','debug'].includes(params.format)) throw new Error('Invalid response format');
  const value = params.maxBytes ?? RESPONSE_LIMITS.maxBytes;
  if (!Number.isSafeInteger(value) || value < RESPONSE_LIMITS.minBytes || value > RESPONSE_LIMITS.maxBytes) throw new Error('Invalid response byte limit');
  return value;
}
export function paginationBinding(source: unknown, params: NetworkQuery) {
  const selection = parseNetworkSelection(params.url);
  return createHash('sha256').update(JSON.stringify([source, selection.fileKey, selection.nodeId,
    params.format ?? 'context', params.depth, params.includeHidden, params.maxNodes, responseBudget(params)])).digest('hex');
}
export function makeContinuation(binding: string, offset: number) {
  const payload = Buffer.from(JSON.stringify({ v: 1, binding, offset })).toString('base64url');
  return payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
}
export function continuationOffset(token: string, binding: string) {
  const invalid = () => new Error('Invalid or stale continuation: restart from the first page with the same source and query parameters');
  if (typeof token !== 'string' || token.length > 512 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw invalid();
  const [payload, signature] = token.split('.');
  const expected = createHmac('sha256', secret).update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) throw invalid();
  let value;
  try { value = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw invalid(); }
  if (value.v !== 1 || value.binding !== binding || !Number.isSafeInteger(value.offset) || value.offset < 1) throw invalid();
  return value.offset as number;
}
