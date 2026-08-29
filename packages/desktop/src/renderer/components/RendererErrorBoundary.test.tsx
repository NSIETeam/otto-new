/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RendererErrorBoundary } from './RendererErrorBoundary.js';

function BrokenPage(): React.JSX.Element {
  throw new Error('render failed');
}

describe('RendererErrorBoundary', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('正常渲染子页面', () => {
    render(
      <RendererErrorBoundary>
        <p>Otto 已就绪</p>
      </RendererErrorBoundary>,
    );

    expect(screen.getByText('Otto 已就绪')).toBeTruthy();
  });

  it('渲染异常时记录错误并提供可执行的恢复入口', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const onError = vi.fn();
    const onReload = vi.fn();

    render(
      <RendererErrorBoundary onError={onError} onReload={onReload}>
        <BrokenPage />
      </RendererErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByRole('heading', { name: '页面暂时无法显示' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '重新加载 Otto' }));
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      '[otto-desktop] renderer crashed',
      expect.any(Error),
      expect.any(Object),
    );
  });
});
