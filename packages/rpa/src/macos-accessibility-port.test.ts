/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it, vi } from 'vitest';
import { MacOsAccessibilityPortV1 } from './macos-accessibility-port.js';

describe('MacOsAccessibilityPortV1', () => {
  it('returns a value-free semantic tree and passes user text only as argv', async () => {
    const runAppleScript = vi.fn<(script: string, args: readonly string[]) => Promise<string>>(
      async () => '收件箱\nAXButton\t新建邮件\nAXTextField\t搜索\n',
    );
    const authorizeApp = vi.fn(async () => true);
    const port = new MacOsAccessibilityPortV1({
      platform: 'darwin',
      authorizeApp,
      runAppleScript,
    });

    expect(await port.inspect('com.apple.mail')).toEqual({
      appId: 'com.apple.mail',
      windowTitle: '收件箱',
      redactedTree: [
        { role: 'AXButton', name: '新建邮件' },
        { role: 'AXTextField', name: '搜索' },
      ],
    });
    expect(authorizeApp).toHaveBeenCalledWith({ appId: 'com.apple.mail', action: 'inspect' });
  });

  it('uses a fixed semantic action script and never interpolates target text', async () => {
    const runAppleScript = vi.fn<(script: string, args: readonly string[]) => Promise<string>>(
      async () => 'ok',
    );
    const port = new MacOsAccessibilityPortV1({
      platform: 'darwin',
      authorizeApp: async () => true,
      runAppleScript,
    });
    const hostileName = '发送" & do shell script "bad"';

    await port.click({
      appId: 'com.apple.mail',
      target: { role: 'button', name: hostileName },
      idempotencyKey: 'run:step:1',
    });

    const [script, args] = runAppleScript.mock.calls[0];
    expect(script).not.toContain(hostileName);
    expect(args).toContain(hostileName);
    expect(args).toEqual([
      'com.apple.mail', 'click', 'AXButton', hostileName, '', '',
    ]);
  });

  it('fails closed for unapproved apps, credential targets and screenshots', async () => {
    const port = new MacOsAccessibilityPortV1({
      platform: 'darwin',
      authorizeApp: async ({ appId }) => appId === 'com.example.allowed',
      runAppleScript: async () => 'ok',
    });
    await expect(port.inspect('com.example.denied')).rejects.toThrow('not authorized');
    await expect(port.fill({
      appId: 'com.example.allowed',
      target: { role: 'text-field', name: '密码' },
      value: 'never',
      idempotencyKey: 'one',
    })).rejects.toThrow('credential fields');
    await expect(port.screenshot('com.example.allowed')).rejects.toThrow('disabled');
  });
});
