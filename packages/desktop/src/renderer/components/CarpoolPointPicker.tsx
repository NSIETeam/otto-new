/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useState } from 'react';
import type {
  EnterpriseParkCarpoolCoordinate,
  EnterpriseParkCarpoolPlaceSuggestion,
} from '../../preload/index.js';
export function mapPixelCoordinate(
  center: EnterpriseParkCarpoolCoordinate,
  zoom: number,
  dx: number,
  dy: number,
): EnterpriseParkCarpoolCoordinate {
  const scale = 256 * 2 ** zoom;
  const x = ((center.longitude + 180) / 360) * scale;
  const sin = Math.sin((center.latitude * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return {
    longitude: ((x + dx) / scale) * 360 - 180,
    latitude:
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + dy)) / scale))) * 180) /
      Math.PI,
  };
}
export function CarpoolPointPicker({
  place,
  onSelect,
  onClose,
}: {
  place: EnterpriseParkCarpoolPlaceSuggestion;
  onSelect(place: EnterpriseParkCarpoolPlaceSuggestion): void;
  onClose(): void;
}): React.JSX.Element {
  const [center, setCenter] = useState(place.coordinate);
  const [selected, setSelected] = useState(place.coordinate);
  const [zoom, setZoom] = useState(15);
  const [image, setImage] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    setImage('');
    setError('');
    void window.otto
      .enterpriseParkCarpoolMap(center, zoom)
      .then((value) => {
        if (current) setImage(value);
      })
      .catch((cause) => {
        if (current)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      current = false;
    };
  }, [center, zoom]);
  const choose = async () => {
    setBusy(true);
    setError('');
    try {
      onSelect(await window.otto.enterpriseParkCarpoolReverse(selected));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };
  const move = (dx: number, dy: number) => {
    const next = mapPixelCoordinate(center, zoom, dx, dy);
    setCenter(next);
    setSelected(next);
  };
  return (
    <section className="otto-carpool__map-picker" aria-label="地图选点">
      <p>点击地图选点</p>
      {error ? <p role="alert">{error}</p> : null}
      {image ? (
        <div
          role="button"
          aria-label="地图选点，方向键移动，回车确认"
          tabIndex={0}
          style={{ position: 'relative', maxWidth: 600 }}
          onKeyDown={(event) => {
            const directions: Record<string, [number, number]> = {
              ArrowUp: [0, -24],
              ArrowDown: [0, 24],
              ArrowLeft: [-24, 0],
              ArrowRight: [24, 0],
            };
            if (directions[event.key]) {
              event.preventDefault();
              move(...directions[event.key]!);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              void choose();
            }
          }}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            move(
              ((event.clientX - rect.left) / rect.width) * 600 - 300,
              ((event.clientY - rect.top) / rect.height) * 400 - 200,
            );
          }}
        >
          <img
            src={image}
            alt="高德地图选点区域"
            width={600}
            height={400}
            style={{ width: '100%', height: 'auto', display: 'block' }}
          />
          <span
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              color: '#bc2d34',
              fontSize: 28,
              transform: 'translate(-50%,-50%)',
            }}
          >
            ＋
          </span>
        </div>
      ) : !error ? (
        <p role="status">正在加载地图…</p>
      ) : null}
      <div className="otto-carpool__map-toolbar">
        <div className="otto-carpool__map-zoom" role="group" aria-label="地图缩放">
        <button
          type="button"
          aria-label="放大地图" title="放大地图"
          disabled={zoom >= 17}
          onClick={() => setZoom((value) => value + 1)}
        >
          ＋
        </button>
        <button
          type="button"
          aria-label="缩小地图" title="缩小地图"
          disabled={zoom <= 3}
          onClick={() => setZoom((value) => value - 1)}
        >
          −
        </button>
        </div>
        <button
          type="button"
          className="otto-park-demo__primary"
          disabled={busy || !image}
          onClick={() => void choose()}
        >
          确认此地点
        </button>
        <button type="button" onClick={onClose}>
          关闭地图
        </button>
      </div>
    </section>
  );
}
