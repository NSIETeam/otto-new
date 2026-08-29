/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { createMockConfig } from '../utils/test-helpers.js';
import { RpaRunTool } from './rpa-run.js';

describe('RpaRunTool', () => {
  const tool = new RpaRunTool(createMockConfig());
  const workflow = {
    id: 'invoice-check',
    version: 1 as const,
    steps: [{ id: 'open', action: 'web.navigate' as const, args: { url: 'https://example.com' }, sideEffect: 'none' as const }],
  };

  it('accepts a bounded workflow definition', () => {
    expect(tool.validateToolParams({ action: 'start', workflow })).toBeNull();
  });

  it('rejects a secret embedded in workflow arguments', () => {
    expect(tool.validateToolParams({
      action: 'start',
      workflow: { ...workflow, steps: [{ ...workflow.steps[0], args: { password: 'never-store-me' } }] },
    })).toContain('secrets');
  });

  it('accepts semantic desktop inspection but requires approval for interaction', () => {
    expect(tool.validateToolParams({
      action: 'start',
      workflow: {
        id: 'inspect-mail',
        version: 1,
        steps: [{
          id: 'inspect',
          action: 'desktop.inspect',
          args: { appId: 'com.apple.mail' },
          sideEffect: 'none',
        }],
      },
    })).toBeNull();
    expect(tool.validateToolParams({
      action: 'start',
      workflow: {
        id: 'click-mail',
        version: 1,
        steps: [{
          id: 'click',
          action: 'desktop.click',
          args: { appId: 'com.apple.mail', target: { role: 'button', name: '发送' } },
          sideEffect: 'none',
        }],
      },
    })).toContain('explicit approval');
  });

  it('requires an explicit approval identifier', () => {
    expect(tool.validateToolParams({ action: 'approve', run_id: 'run-1' })).toContain('approval_id');
  });

  it('requires confirmation for every state-changing operation', async () => {
    expect(await tool.shouldConfirmExecute({ action: 'start', workflow }, new AbortController().signal)).not.toBe(false);
    expect(await tool.shouldConfirmExecute({ action: 'status', run_id: 'run-1' }, new AbortController().signal)).toBe(false);
  });

  it('loads the optional RPA runtime for a read-only status lookup', async () => {
    const result = await tool.execute({ action: 'status', run_id: 'rpa-00000000-0000-0000-0000-000000000000' }, new AbortController().signal);
    expect(String(result.llmContent)).toContain('"found":false');
  });
});
