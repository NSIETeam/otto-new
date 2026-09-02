/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AdaptiveExecutionCoordinator,
  classifyExecutionFailure,
} from './adaptiveExecution.js';

describe('AdaptiveExecutionCoordinator', () => {
  it('retries a transient read once, then requires a different strategy', () => {
    const coordinator = new AdaptiveExecutionCoordinator();
    const first = coordinator.observe({
      toolName: 'web_search',
      callFingerprint: 'search:official-source',
      message: 'ETIMEDOUT while contacting upstream',
      sideEffect: 'read_only',
    });
    const second = coordinator.observe({
      toolName: 'web_search',
      callFingerprint: 'search:official-source',
      message: 'ETIMEDOUT while contacting upstream',
      sideEffect: 'read_only',
    });

    expect(first).toMatchObject({
      category: 'transient',
      action: 'retry_once',
      attempt: 1,
      replanRequired: false,
    });
    expect(second).toMatchObject({
      category: 'transient',
      action: 'switch_strategy',
      attempt: 2,
      replanRequired: true,
    });
    expect(second.guidance).not.toContain('ETIMEDOUT');
  });

  it('never retries permission failures or an unknown external-write outcome', () => {
    const coordinator = new AdaptiveExecutionCoordinator();
    const permission = coordinator.observe({
      toolName: 'read_enterprise_data',
      callFingerprint: 'enterprise:private',
      message: '403 permission denied',
      sideEffect: 'read_only',
    });
    const ambiguousWrite = coordinator.observe({
      toolName: 'send_message',
      callFingerprint: 'send:candidate',
      message: 'socket closed; outcome unknown',
      sideEffect: 'external_write',
    });

    expect(permission).toMatchObject({
      action: 'request_input',
      retryAllowed: false,
    });
    expect(ambiguousWrite).toMatchObject({
      category: 'unknown_side_effect',
      action: 'reconcile',
      retryAllowed: false,
      replanRequired: true,
    });
  });

  it('classifies stale state, invalid input and context overflow separately', () => {
    expect(classifyExecutionFailure('409 revision conflict')).toBe(
      'stale_state',
    );
    expect(
      classifyExecutionFailure('schema validation failed: required field'),
    ).toBe('invalid_input');
    expect(classifyExecutionFailure('maximum context length exceeded')).toBe(
      'context_overflow',
    );
  });

  it('builds bounded model guidance that preserves completed work and forbids blind repetition', () => {
    const coordinator = new AdaptiveExecutionCoordinator();
    const decision = coordinator.observe({
      toolName: 'replace',
      callFingerprint: 'replace:stale-file',
      message: '409 revision conflict at D:/secret/customer.txt?token=private',
      sideEffect: 'local_write',
    });
    const directive = coordinator.buildDirective([decision], ['read_file']);

    expect(directive).toContain('Preserve completed work');
    expect(directive).toContain('revise the remaining plan');
    expect(directive).toContain('Do not repeat an identical failed call');
    expect(directive).toContain('read_file');
    expect(directive).not.toContain('customer.txt');
    expect(directive.length).toBeLessThan(1200);
  });
});
