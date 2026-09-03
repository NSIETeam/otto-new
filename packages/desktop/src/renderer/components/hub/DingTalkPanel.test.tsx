/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DINGTALK_DEVELOPER_URL, DingTalkPanel } from './DingTalkPanel.js';

describe('DingTalkPanel', () => {
  beforeEach(() => {
    window.otto = { openExternal: vi.fn(async () => undefined) } as unknown as typeof window.otto;
  });

  it('offers official QR pairing first and keeps manual setup secondary', async () => {
    render(<DingTalkPanel />);
    expect(screen.getByText('生成钉钉连接二维码')).toBeTruthy();
    fireEvent.click(screen.getByText('打开钉钉开发者后台'));
    await waitFor(() => expect(window.otto.openExternal).toHaveBeenCalledWith(DINGTALK_DEVELOPER_URL));
  });
});
