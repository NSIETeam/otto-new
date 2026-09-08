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
  it('unrelated same-tool success and unrelated writes do not clear failed targets', () => {
    const c = new AdaptiveExecutionCoordinator();
    const failed = { toolName: 'run_shell_command', callFingerprint: 'test-a', sideEffect: 'local_write' as const, verification: true, targetPaths: ['/repo/a.ts'] };
    c.observe({ ...failed, message: 'assertion failed' });
    c.recordSuccess({ ...failed, callFingerprint: 'test-b' });
    c.recordSuccess({ toolName: 'replace', callFingerprint: 'write-b', sideEffect: 'local_write', targetPaths: ['/repo/b.ts'] });
    expect(c.reviewAttempt(failed).allowed).toBe(false);
  });
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

  it('enforces the one permitted transient read retry and then blocks the identical path', () => {
    const coordinator = new AdaptiveExecutionCoordinator();
    const attempt = {
      toolName: 'web_search',
      callFingerprint: 'search:official-source',
      sideEffect: 'read_only' as const,
    };

    coordinator.observe({
      ...attempt,
      message: 'ETIMEDOUT while contacting upstream',
    });
    expect(coordinator.reviewAttempt(attempt)).toMatchObject({
      allowed: true,
      disposition: 'retry',
    });

    coordinator.observe({
      ...attempt,
      message: 'ETIMEDOUT while contacting upstream',
    });
    expect(coordinator.reviewAttempt(attempt)).toMatchObject({
      allowed: false,
      disposition: 'blocked',
    });
  });

  it('accepts a changed fingerprint as an auditable strategy change after an input failure', () => {
    const coordinator = new AdaptiveExecutionCoordinator();
    coordinator.observe({
      toolName: 'fetch_url',
      callFingerprint: 'fetch:bad-url',
      message: '400 invalid input',
      sideEffect: 'read_only',
    });

    expect(
      coordinator.reviewAttempt({
        toolName: 'fetch_url',
        callFingerprint: 'fetch:corrected-url',
        sideEffect: 'read_only',
      }),
    ).toMatchObject({ allowed: true, disposition: 'strategy_change' });
    expect(
      coordinator.reviewAttempt({
        toolName: 'fetch_url',
        callFingerprint: 'fetch:bad-url',
        sideEffect: 'read_only',
      }),
    ).toMatchObject({ allowed: false, disposition: 'blocked' });
  });

  it('does not let parameter changes bypass permission or unknown-write reconciliation', () => {
    const coordinator = new AdaptiveExecutionCoordinator();
    coordinator.observe({
      toolName: 'read_enterprise_data',
      callFingerprint: 'enterprise:team-a',
      message: '403 permission denied',
      sideEffect: 'read_only',
    });
    expect(
      coordinator.reviewAttempt({
        toolName: 'read_enterprise_data',
        callFingerprint: 'enterprise:team-b',
        sideEffect: 'read_only',
      }),
    ).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(
      coordinator.reviewAttempt({
        toolName: 'read_public_data',
        callFingerprint: 'public:team-b',
        sideEffect: 'read_only',
      }),
    ).toMatchObject({ allowed: true });

    coordinator.observe({
      toolName: 'send_message',
      callFingerprint: 'send:first',
      message: 'socket closed; outcome unknown',
      sideEffect: 'external_write',
    });
    expect(
      coordinator.reviewAttempt({
        toolName: 'send_message',
        callFingerprint: 'send:changed',
        sideEffect: 'external_write',
      }),
    ).toMatchObject({ allowed: false, disposition: 'blocked' });
    expect(
      coordinator.reviewAttempt({
        toolName: 'publish_notice',
        callFingerprint: 'publish:new',
        sideEffect: 'external_write',
      }),
    ).toMatchObject({ allowed: false, disposition: 'blocked' });
  });

  it('allows an exact verification rerun after a successful local repair', () => {
    const coordinator = new AdaptiveExecutionCoordinator();
    const verification = {
      toolName: 'run_tests',
      callFingerprint: 'tests:login',
      sideEffect: 'read_only' as const,
      verification: true,
      targetPaths: ['/repo/login.ts'],
    };
    coordinator.observe({
      ...verification,
      message: 'assertion failed',
    });
    expect(coordinator.reviewAttempt(verification).allowed).toBe(false);

    coordinator.recordSuccess({
      toolName: 'replace',
      callFingerprint: 'replace:login',
      sideEffect: 'local_write',
      targetPaths: ['/repo/login.ts'],
    });
    expect(coordinator.reviewAttempt(verification)).toMatchObject({
      allowed: true,
      disposition: 'retry',
    });
  });
});
