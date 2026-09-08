import { expect, it } from 'vitest';
import { AdaptiveExecutionCoordinator } from './adaptiveExecution.js';
it('records native bounded alternatives and rejection reasons without copying error secrets', () => {
  const guard = new AdaptiveExecutionCoordinator();
  const decision = guard.observe({
    toolName: 'web_search',
    callFingerprint: 'a',
    sideEffect: 'read_only',
    message: 'timeout token=secret',
  });
  expect(decision.alternatives).toHaveLength(3);
  expect(decision.alternatives?.filter((c) => c.selected)).toHaveLength(1);
  expect(decision.alternatives?.find((c) => c.selected)?.action).toBe(
    'retry_once',
  );
  expect(JSON.stringify(decision.alternatives)).not.toContain('secret');
  expect(
    decision.alternatives?.every((c) => c.acceptance === 'unchanged'),
  ).toBe(true);
});
it('never selects replay of an ambiguous write and retains the reconciliation gate across a changed proposal', () => {
  const guard = new AdaptiveExecutionCoordinator();
  const decision = guard.observe({
    toolName: 'send_message',
    callFingerprint: 'a',
    sideEffect: 'external_write',
    message: 'timeout',
  });
  expect(decision.alternatives?.find((c) => c.selected)?.action).toBe(
    'reconcile',
  );
  expect(
    guard.reviewAttempt({
      toolName: 'publish_notice',
      callFingerprint: 'b',
      sideEffect: 'external_write',
    }).allowed,
  ).toBe(false);
});
it('bounds changed-parameter attempts per failed capability rather than accepting endless cosmetic replans', () => {
  const guard = new AdaptiveExecutionCoordinator();
  guard.observe({
    toolName: 'fetch_url',
    callFingerprint: 'a',
    sideEffect: 'read_only',
    message: 'invalid input',
  });
  const attempt = (id: string) =>
    guard.reviewAttempt({
      toolName: 'fetch_url',
      callFingerprint: id,
      sideEffect: 'read_only',
    });
  expect(attempt('b').allowed).toBe(true);
  expect(attempt('c').allowed).toBe(true);
  expect(attempt('d').allowed).toBe(false);
});
