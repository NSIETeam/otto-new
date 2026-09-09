import React, { forwardRef, useImperativeHandle } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EnterpriseGraphCanvas } from './EnterpriseGraphCanvas.js';
import { clearLayouts, layoutGeneration, saveLayout } from './layoutCache.js';
import { demoMap, graphIndex } from './model.js';
const mock = vi.hoisted(() => ({
  stop: () => {},
  fit: vi.fn(),
  pause: vi.fn(),
  center: vi.fn(() => ({ x: 12, y: 20 })),
  zoom: vi.fn(() => 1.7),
}));
vi.mock('react-force-graph-2d', () => ({
  default: forwardRef(function Graph(props: { onEngineStop: () => void }, ref) {
    mock.stop = props.onEngineStop;
    useImperativeHandle(ref, () => ({
      zoomToFit: mock.fit,
      centerAt: mock.center,
      zoom: mock.zoom,
      pauseAnimation: mock.pause,
      resumeAnimation: vi.fn(),
      d3ReheatSimulation: vi.fn(),
      d3Force: () => ({ strength: vi.fn(), distance: vi.fn() }),
    }));
    return <div data-testid="force-canvas" />;
  }),
}));
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  clearLayouts();
  mock.center.mockClear();
  mock.zoom.mockClear();
  mock.fit.mockClear();
  mock.pause.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('reveals the initial graph only after an instant fit and never refits on later simulation stops', async () => {
  render(
    <React.StrictMode>
      <EnterpriseGraphCanvas
        index={graphIndex(demoMap)}
        selected={null}
        hover={null}
        ownId=""
        matches={new Set()}
        scope={null}
        sizeMode="degree"
        reducedMotion={false}
        showIndustries
        onSelect={() => {}}
        onHover={() => {}}
      />
    </React.StrictMode>,
  );
  expect(screen.getByRole('status').textContent).toContain('正在准备图谱');
  act(() => mock.stop());
  expect(mock.fit).toHaveBeenCalledWith(0, 80);
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  act(() => mock.stop());
  expect(mock.fit).toHaveBeenCalledTimes(1);
});

it('restores a saved camera before display and skips initial auto-fit', () => {
  saveLayout(
    'reopen',
    {
      positions: demoMap.nodes.map((node, i) => ({
        id: node.organizationId,
        x: i * 20,
        y: 0,
      })),
      camera: { x: 12, y: 20, zoom: 1.7 },
    },
    layoutGeneration(),
  );
  render(
    <EnterpriseGraphCanvas
      cacheKey="reopen"
      index={graphIndex(demoMap)}
      selected={null}
      hover={null}
      ownId=""
      matches={new Set()}
      scope={null}
      sizeMode="degree"
      reducedMotion={false}
      showIndustries
      onSelect={() => {}}
      onHover={() => {}}
    />,
  );
  expect(screen.queryByRole('status')).toBeNull();
  expect(mock.center).toHaveBeenCalledWith(12, 20, 0);
  expect(mock.zoom).toHaveBeenCalledWith(1.7, 0);
  act(() => mock.stop());
  expect(mock.fit).not.toHaveBeenCalled();
});
