/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';

interface RendererRecoveryScreenProps {
  onReload?: () => void;
}

export function RendererRecoveryScreen({
  onReload = () => window.location.reload(),
}: RendererRecoveryScreenProps): React.JSX.Element {
  return (
    <main style={{
      minHeight: '100vh',
      display: 'grid',
      placeItems: 'center',
      padding: 24,
      colorScheme: 'light dark',
      background: 'Canvas',
      color: 'CanvasText',
      fontFamily: 'system-ui, "Microsoft YaHei", sans-serif',
    }}>
      <section role="alert" style={{
        width: 'min(520px, 100%)',
        padding: 28,
        border: '1px solid GrayText',
        borderRadius: 8,
        background: 'Canvas',
        boxShadow: '0 16px 48px rgb(0 0 0 / 12%)',
      }}>
        <h1 style={{ margin: '0 0 12px', fontSize: 24 }}>页面暂时无法显示</h1>
        <p style={{ margin: '0 0 20px', lineHeight: 1.7 }}>
          Otto 已拦截页面异常。请重新加载；如果问题持续，请联系管理员更新客户端或企业服务器。
        </p>
        <button
          type="button"
          onClick={onReload}
          style={{
            padding: '10px 18px',
            border: 0,
            borderRadius: 8,
            background: '#176a4b',
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 700,
          }}
        >重新加载 Otto</button>
      </section>
    </main>
  );
}

interface RendererErrorBoundaryProps {
  children: React.ReactNode;
  onError?: (error: Error, info: React.ErrorInfo) => void;
  onReload?: () => void;
}

export class RendererErrorBoundary extends React.Component<
  RendererErrorBoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[otto-desktop] renderer crashed', error, info);
    this.props.onError?.(error, info);
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    return <RendererRecoveryScreen onReload={this.props.onReload} />;
  }
}
