/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useState } from 'react';
import type { CarpoolRoutePreview } from 'otto-server';
export function CarpoolRouteComparison({
  intentId,
  groupId,
}: {
  intentId: string;
  groupId?: string;
}): React.JSX.Element {
  const [preview, setPreview] = useState<CarpoolRoutePreview | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="脱敏路线对比">
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError('');
          void window.otto
            .enterpriseParkCarpoolRoutePreview(intentId, groupId)
            .then(setPreview)
            .catch((cause) =>
              setError(cause instanceof Error ? cause.message : String(cause)),
            )
            .finally(() => setBusy(false));
        }}
      >
        {busy ? '正在读取路线…' : preview ? '刷新路线对比' : '查看路线对比'}
      </button>
      {error ? <p role="alert">{error}</p> : null}
      {preview ? (
        <>
          <p>{preview.explanation}</p>
          {preview.segments.length ? (
            <svg
              viewBox="0 0 600 400"
              role="img"
              aria-label="已隐藏所有住宅端点的同行路线示意"
              style={{ width: '100%', maxHeight: 360, background: '#f6f8fb' }}
            >
              {preview.segments.map((segment, index) => (
                <polyline
                  key={index}
                  points={segment.points
                    .map((point) => `${point.x},${point.y}`)
                    .join(' ')}
                  fill="none"
                  stroke={
                    segment.coverage === 'all'
                      ? '#175d48'
                      : segment.coverage === 'partial'
                        ? '#76b4a0'
                        : '#80858c'
                  }
                  strokeWidth={segment.shared ? 5 : 3}
                  strokeDasharray={
                    segment.coverage === 'partial' ? '8 5' : undefined
                  }
                />
              ))}
              {preview.divergences.map((point, index) => (
                <circle
                  key={index}
                  cx={point.x}
                  cy={point.y}
                  r={5}
                  fill="#542a77"
                />
              ))}
            </svg>
          ) : null}
          <p>
            深色实线：双方或全员共同方向；浅色虚线：部分成员共同方向；灰色：单独路段；紫色圆点：分岔位置。图形为粗化示意，不用于导航。
          </p>
          <button type="button" onClick={() => setPreview(null)}>
            收起路线
          </button>
        </>
      ) : null}
    </section>
  );
}
