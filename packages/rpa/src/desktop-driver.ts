/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { DesktopRpaTargetV1, RpaStepDefinition } from './contracts.js';
import type { RpaDriver } from './ports.js';

export interface DesktopAccessibilitySnapshot {
  appId: string;
  windowTitle: string;
  redactedTree: unknown;
}

export interface DesktopRpaPortV1 {
  inspect(appId: string): Promise<DesktopAccessibilitySnapshot>;
  click(input: { appId: string; target: DesktopRpaTargetV1; idempotencyKey: string }): Promise<unknown>;
  fill(input: { appId: string; target: DesktopRpaTargetV1; value: string; idempotencyKey: string }): Promise<unknown>;
  select(input: { appId: string; target: DesktopRpaTargetV1; option: string; idempotencyKey: string }): Promise<unknown>;
  scroll(input: { appId: string; target?: DesktopRpaTargetV1; direction: 'up' | 'down'; amount: number }): Promise<unknown>;
  wait(input: { appId: string; target: DesktopRpaTargetV1; timeoutMs: number }): Promise<unknown>;
  screenshot(appId: string): Promise<{ bytes: Uint8Array; redactedSummary: string }>;
}

function requiredText(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Desktop RPA ${key} is required.`);
  return value.trim();
}

function target(args: Record<string, unknown>): DesktopRpaTargetV1 {
  const raw = args['target'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Desktop RPA semantic target is required.');
  }
  const value = raw as Record<string, unknown>;
  const allowedKeys = new Set(['role', 'name', 'windowTitle']);
  const unsupportedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unsupportedKey) throw new Error(`Desktop RPA target field is forbidden: ${unsupportedKey}`);
  const role = requiredText(value, 'role');
  const name = requiredText(value, 'name');
  const normalizedRole = role.toLowerCase().replaceAll('_', '-');
  if (['password', 'secure-text-field', 'password-field'].includes(normalizedRole)) {
    throw new Error('Desktop RPA cannot access credential fields.');
  }
  if (/(password|passcode|密码|口令|验证码|token|secret)/iu.test(name)) {
    throw new Error('Desktop RPA cannot access credential fields.');
  }
  const windowTitle = value['windowTitle'];
  if (windowTitle !== undefined && typeof windowTitle !== 'string') {
    throw new Error('Desktop RPA windowTitle must be text.');
  }
  return { role, name, ...(windowTitle ? { windowTitle: windowTitle.trim() } : {}) };
}

function boundedNumber(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = args[key] ?? fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Desktop RPA ${key} must be between ${min} and ${max}.`);
  }
  return value;
}

/** Maps only versioned semantic desktop actions onto the privileged OS port. */
export class DesktopRpaDriverV1 implements RpaDriver {
  constructor(private readonly port: DesktopRpaPortV1) {}

  async execute(input: {
    run: unknown;
    step: RpaStepDefinition;
    idempotencyKey: string;
  }): Promise<{
    output?: unknown;
    artifacts?: ReadonlyArray<{ mediaType: string; bytes: Uint8Array; redactedSummary: string }>;
  }> {
    const { step, idempotencyKey } = input;
    const appId = requiredText(step.args, 'appId');
    switch (step.action) {
      case 'desktop.inspect':
        return { output: await this.port.inspect(appId) };
      case 'desktop.click':
        return { output: await this.port.click({ appId, target: target(step.args), idempotencyKey }) };
      case 'desktop.fill':
        return { output: await this.port.fill({
          appId, target: target(step.args), value: requiredText(step.args, 'value'), idempotencyKey,
        }) };
      case 'desktop.select':
        return { output: await this.port.select({
          appId, target: target(step.args), option: requiredText(step.args, 'option'), idempotencyKey,
        }) };
      case 'desktop.scroll': {
        const direction = step.args['direction'];
        if (direction !== 'up' && direction !== 'down') {
          throw new Error('Desktop RPA direction must be up or down.');
        }
        return { output: await this.port.scroll({
          appId,
          ...(step.args['target'] ? { target: target(step.args) } : {}),
          direction,
          amount: boundedNumber(step.args, 'amount', 1, 1, 10),
        }) };
      }
      case 'desktop.wait':
        return { output: await this.port.wait({
          appId,
          target: target(step.args),
          timeoutMs: boundedNumber(step.args, 'timeoutMs', 10_000, 100, 60_000),
        }) };
      case 'desktop.screenshot': {
        const screenshot = await this.port.screenshot(appId);
        return { artifacts: [{ mediaType: 'image/png', ...screenshot }] };
      }
      default:
        throw new Error(`Desktop driver cannot execute ${step.action}.`);
    }
  }
}
