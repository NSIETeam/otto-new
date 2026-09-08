/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useRef, useState } from 'react';
import { marketRequest } from '../parkMarketApi.js';
export function MarketImageViewer({
  imageIds,
  initialIndex,
  onClose,
}: {
  imageIds: string[];
  initialIndex: number;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [index, setIndex] = useState(
    Math.max(0, Math.min(initialIndex, imageIds.length - 1)),
  );
  const [zoom, setZoom] = useState(1);
  const [source, setSource] = useState('');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    let active = true;
    setSource('');
    setError('');
    setZoom(1);
    void marketRequest<{ data: string }>(
      `/images/${imageIds[index]}?format=data`,
    )
      .then((value) => {
        if (active) setSource(`data:image/jpeg;base64,${value.data}`);
      })
      .catch(() => {
        if (active) setError('图片已失效、无权查看或加载失败');
      });
    return () => {
      active = false;
    };
  }, [index, imageIds, retry]);
  const move = (change: number) =>
    setIndex((current) =>
      Math.max(0, Math.min(imageIds.length - 1, current + change)),
    );
  return (
    <dialog
      ref={dialog}
      className="park-market-image-viewer"
      aria-label="商品图片预览"
      onCancel={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        } else if (event.key === 'ArrowLeft') {
          event.preventDefault();
          move(-1);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          move(1);
        }
      }}
    >
      <header>
        <span aria-live="polite">
          {index + 1} / {imageIds.length}
        </span>
        <button onClick={onClose}>关闭图片</button>
      </header>
      <div className="park-market-image-stage">
        {source ? (
          <img
            src={source}
            alt={`商品第 ${index + 1} 张照片`}
            style={{ transform: `scale(${zoom})` }}
          />
        ) : error ? (
          <p role="alert">
            {error}
            <button onClick={() => setRetry((value) => value + 1)}>重试</button>
          </p>
        ) : (
          <p role="status">正在加载图片…</p>
        )}
      </div>
      <nav aria-label="图片控制">
        <button disabled={index === 0} onClick={() => move(-1)}>
          上一张
        </button>
        <button
          disabled={index === imageIds.length - 1}
          onClick={() => move(1)}
        >
          下一张
        </button>
        <button
          disabled={zoom <= 1}
          onClick={() => setZoom((value) => Math.max(1, value - 0.5))}
        >
          缩小
        </button>
        <button
          disabled={zoom >= 4}
          onClick={() => setZoom((value) => Math.min(4, value + 0.5))}
        >
          放大
        </button>
        <button onClick={() => setZoom(1)}>适应窗口</button>
      </nav>
    </dialog>
  );
}
