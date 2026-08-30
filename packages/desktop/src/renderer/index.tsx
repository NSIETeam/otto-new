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
import { startRendererThemeSync } from './themeSync.js';

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 容器');

const root = createRoot(container);
const surface = new URLSearchParams(window.location.search).get('surface');
const desktopPetSurface = surface === 'desktop-pet';

async function mountRenderer(): Promise<void> {
  try {
    await import('./browserPreviewBridge.js');

    if (desktopPetSurface) {
      document.documentElement.dataset.ottoSurface = 'desktop-pet';
      document.body.dataset.ottoSurface = 'desktop-pet';
      const { DesktopPetSurface } = await import('./components/DesktopPetSurface.js');
      root.render(
        <React.StrictMode>
          <RendererErrorBoundary>
            <DesktopPetSurface />
          </RendererErrorBoundary>
        </React.StrictMode>,
      );
      return;
    }

    const [{ App }, { readPetWidgetEnabled }] = await Promise.all([
      import('./App.js'),
      import('./petWidgetPreference.js'),
    ]);
    const desktopPetSync = window.otto?.desktopPetSetEnabled?.(
      readPetWidgetEnabled(),
    );
    void desktopPetSync?.catch(() => {
      // 浏览器预览或旧 preload 不支持独立小宠物窗口时保持主界面可用。
    });
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
startRendererThemeSync();
void mountRenderer();
