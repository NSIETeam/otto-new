/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ModelRequestSafetyError } from './modelRequestSafety.js';
import { shouldRetryCustomModel } from './customModelRuntimeHelpers.js';

const requestId = 'otto-model-00000000-0000-4000-8000-000000000030';

describe('custom model retry safety', () => {
  it.each([429, 500])('does not infer replay safety from HTTP %i', (status) => {
    expect(shouldRetryCustomModel(Object.assign(new Error('HTTP failure'), {
      status,
    }))).toBe(false);
  });

  it('does not retry an unknown timeout outcome', () => {
    expect(shouldRetryCustomModel(new ModelRequestSafetyError({
      message: 'response timeout',
      requestId,
      requestState: 'unknown_outcome',
    }))).toBe(false);
  });

  it('retries only an explicitly confirmed not-sent failure', () => {
    expect(shouldRetryCustomModel(new ModelRequestSafetyError({
      message: 'connection was never established',
      requestId,
      requestState: 'not_sent',
    }))).toBe(true);
  });
});
