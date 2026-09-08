/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from 'vitest';
import {
  AdaptiveExecutionCoordinator,
  classifyExecutionFailure,
} from './adaptiveExecution.js';

describe('stage 4 recovery without stale tool-wide locks', () => {
  it('a known process exit does not make an explicitly unknown business outcome known', () => {
    expect(
      classifyExecutionFailure('process exited; outcome unknown', true),
    ).toBe('unknown_side_effect');
    const guard = new AdaptiveExecutionCoordinator();
    expect(
      guard.observe({
        toolName: 'run_shell_command',
        callFingerprint: 'test',
        sideEffect: 'local_write',
        verification: true,
        nativeVerificationFailed: true,
        message: '结果未知',
      }).action,
    ).toBe('reconcile');
  });
  it('does not spend fresh strategy attempts on a successfully executed read alternative', () => {
    const guard = new AdaptiveExecutionCoordinator();
    const attempt = (callFingerprint: string) => ({
      toolName: 'read_file',
      callFingerprint,
      sideEffect: 'read_only' as const,
    });
    guard.observe({ ...attempt('missing'), message: 'not found' });
    expect(guard.reviewAttempt(attempt('valid')).allowed).toBe(true);
    expect(guard.recordSuccess(attempt('valid'))).toEqual([]); // not proof the missing target was resolved
    for (let i = 0; i < 4; i++)
      expect(guard.reviewAttempt(attempt('valid')).allowed).toBe(true);
    expect(guard.reviewAttempt(attempt('missing')).allowed).toBe(false);
    expect(guard.reviewAttempt(attempt('second')).allowed).toBe(true);
    expect(guard.reviewAttempt(attempt('third')).allowed).toBe(false);
  });
  it('does not reuse a read success after another permission denial or a new failure of that same read', () => {
    const guard = new AdaptiveExecutionCoordinator();
    const read = {
      toolName: 'read_file',
      sideEffect: 'read_only' as const,
      callFingerprint: 'valid',
    };
    guard.observe({
      ...read,
      callFingerprint: 'missing',
      message: 'not found',
    });
    guard.reviewAttempt(read);
    guard.recordSuccess(read);
    guard.observe({ ...read, message: 'permission denied' });
    expect(guard.reviewAttempt(read).allowed).toBe(false);
    expect(
      guard.reviewAttempt({ ...read, callFingerprint: 'other' }).allowed,
    ).toBe(false);
  });
  it.each(['local_write', 'external_write'] as const)(
    'a native check failure does not turn assertion text into denial (%s); dispatch still needs normal authorization',
    (sideEffect) => {
      const guard = new AdaptiveExecutionCoordinator();
      const check = {
        toolName: 'run_shell_command',
        callFingerprint: 'test',
        sideEffect,
        verification: true,
        nativeVerificationFailed: true,
        targetPaths: ['/repo/login.ts'],
      };
      expect(
        guard.observe({
          ...check,
          message: 'AssertionError: expected 403 forbidden, got 200',
        }).action,
      ).toBe('switch_strategy');
      expect(guard.reviewAttempt(check).allowed).toBe(false);
      guard.recordSuccess({
        toolName: 'replace',
        callFingerprint: 'repair',
        sideEffect: 'local_write',
        targetPaths: ['/repo/login.ts'],
      });
      expect(guard.reviewAttempt(check).allowed).toBe(true);
      expect(guard.reviewAttempt(check).allowed).toBe(false);
    },
  );
  it('a native process receipt cannot remove unknown external-result reconciliation', () => {
    const guard = new AdaptiveExecutionCoordinator();
    const check = {
      toolName: 'run_shell_command',
      callFingerprint: 'test',
      sideEffect: 'external_write' as const,
      verification: true,
      nativeVerificationFailed: true,
      targetPaths: ['/repo/login.ts'],
    };
    expect(
      guard.observe({ ...check, message: 'connection reset; outcome unknown' })
        .action,
    ).toBe('reconcile');
    guard.recordSuccess({
      toolName: 'replace',
      callFingerprint: 'repair',
      sideEffect: 'local_write',
      targetPaths: ['/repo/login.ts'],
    });
    expect(guard.reviewAttempt(check).allowed).toBe(false);
    expect(
      guard.reviewAttempt({ ...check, callFingerprint: 'different' }).allowed,
    ).toBe(false);
  });
  it('never treats a check name without a native receipt as permission to repair through denial', () => {
    const guard = new AdaptiveExecutionCoordinator();
    const check = {
      toolName: 'run_shell_command',
      callFingerprint: 'test',
      sideEffect: 'local_write' as const,
      verification: true,
      targetPaths: ['/repo/login.ts'],
    };
    expect(
      guard.observe({ ...check, message: '403 permission denied' }).action,
    ).toBe('request_input');
    guard.recordSuccess({
      toolName: 'replace',
      callFingerprint: 'repair',
      sideEffect: 'local_write',
      targetPaths: ['/repo/login.ts'],
    });
    expect(guard.reviewAttempt(check).allowed).toBe(false);
  });
});
