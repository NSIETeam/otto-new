/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer 入口。挂载 App 到 #root。
 *
 * 对照 webview src/index.tsx：那边先 acquireVsCodeApi() 存 window.vscode；
 * 这边的等价物是 preload 注入的 window.otto（见 ../preload/index.ts），
 * renderer 经 ./transport 使用，无需在此初始化。
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  RendererErrorBoundary,
  RendererRecoveryScreen,
} from './components/RendererErrorBoundary.js';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

const root = createRoot(container);

async function mountRenderer(): Promise<void> {
  try {
    await import('./browserPreviewBridge.js');
    const { App } = await import('./App.js');
    root.render(
      <React.StrictMode>
        <RendererErrorBoundary>
          <App />
        </RendererErrorBoundary>
      </React.StrictMode>,
    );
  } catch (error) {
    console.error('[otto-desktop] renderer startup failed', error);
    root.render(<RendererRecoveryScreen />);
  }
}

void mountRenderer();
