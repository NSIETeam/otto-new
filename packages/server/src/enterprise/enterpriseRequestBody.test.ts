import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readEnterpriseRequestBody } from './enterpriseRequestBody.js';
describe('enterprise buffered request body', () => {
  it('reads a complete but unconsumed body after asynchronous authentication', async () => {
    const stream = Object.assign(new PassThrough(), { complete: true });
    stream.end(JSON.stringify({ action: 'configure', enabled: false }));
    expect(await readEnterpriseRequestBody(stream as unknown as IncomingMessage)).toEqual({ action: 'configure', enabled: false });
  });
  it('drains oversized input without accumulating or accepting it', async () => {
    const stream = new PassThrough();
    stream.end('{"tooLarge":"' + 'x'.repeat(100) + '"}');
    expect(await readEnterpriseRequestBody(stream as unknown as IncomingMessage, 16)).toEqual({});
  });
  it('rejects broken streams without hanging', async () => {
    const stream = new PassThrough();
    const result = readEnterpriseRequestBody(stream as unknown as IncomingMessage);
    const assertion = expect(result).rejects.toThrow('connection reset');
    stream.destroy(new Error('connection reset'));
    await assertion;
  });
});
