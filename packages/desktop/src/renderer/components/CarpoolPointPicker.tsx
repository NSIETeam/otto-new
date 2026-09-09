/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useEffect, useRef, useState } from 'react';
import { CarpoolConfirmation } from './CarpoolConfirmation.js';
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
export function CarpoolPointPicker({ place, onSelect, onClose }: {
  place: EnterpriseParkCarpoolPlaceSuggestion;
  onSelect(place: EnterpriseParkCarpoolPlaceSuggestion): void;
  onClose(): void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [preview, setPreview] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let current = true;
    setPreview(''); setFailed(false);
    void window.otto.enterpriseParkCarpoolMap(place.coordinate, 15)
      .then(value => { if (current) setPreview(value); })
      .catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [place.coordinate]);
  return (
    <section className="otto-carpool__map-preview" aria-label="地点地图预览">
      {preview ? <img src={preview} alt="所选地点地图" width={600} height={400} />
        : <span role="status">{failed ? '预览暂不可用，可展开重试' : '正在加载地图…'}</span>}
      <div>
        <button type="button" onClick={() => setExpanded(true)}>展开地图</button>
        <button type="button" onClick={onClose}>关闭地图</button>
      </div>
      {expanded ? (
        <CarpoolConfirmation label="地图选点" role="dialog" className="otto-carpool-map-dialog" onCancel={() => setExpanded(false)}>
          <MapEditor place={place} onSelect={onSelect} onClose={() => { setExpanded(false); onClose(); }} onCancel={() => setExpanded(false)} />
        </CarpoolConfirmation>
      ) : null}
    </section>
  );
}
function MapEditor({
  place,
  onSelect,
  onClose,
  onCancel,
}: {
  place: EnterpriseParkCarpoolPlaceSuggestion;
  onSelect(place: EnterpriseParkCarpoolPlaceSuggestion): void;
  onClose(): void;
  onCancel(): void;
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
  const mounted = useRef(true);
  const choosing = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const choose = async () => {
    if (choosing.current) return;
    choosing.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await window.otto.enterpriseParkCarpoolReverse(selected);
      if (!mounted.current) return;
      onSelect(result);
      onClose();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      choosing.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const move = (dx: number, dy: number) => {
    if (choosing.current) return;
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
          disabled={busy || zoom >= 17}
          onClick={() => setZoom((value) => value + 1)}
        >
          ＋
        </button>
        <button
          type="button"
          aria-label="缩小地图" title="缩小地图"
          disabled={busy || zoom <= 3}
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
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </section>
  );
}
