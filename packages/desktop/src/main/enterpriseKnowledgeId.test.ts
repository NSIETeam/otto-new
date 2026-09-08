/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import { isEnterpriseKnowledgeId } from './enterpriseKnowledgeId.js';
describe('enterprise knowledge resource ids', () => {
  it.each(['12', 'knowledge-expired', 'eefdbfa2-a43a-4cf6-aac4-98a3be2fdd88'])(
    'accepts supported server ids %s',
    (id) => expect(isEnterpriseKnowledgeId(id)).toBe(true),
  );
  it.each([
    '',
    '../other',
    'one/two',
    '%2f',
    '?q=all',
    'a'.repeat(201),
    null,
    12,
  ])('rejects paths and malformed ids %s', (id) =>
    expect(isEnterpriseKnowledgeId(id)).toBe(false),
  );
});
