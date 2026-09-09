import React, { forwardRef, useImperativeHandle } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EnterpriseGraphCanvas } from './EnterpriseGraphCanvas.js';
import { clearLayouts, layoutGeneration, saveLayout } from './layoutCache.js';
import { demoMap, graphIndex } from './model.js';
const mock = vi.hoisted(() => ({
  stop: () => {},
  props: {} as any,
  fit: vi.fn(),
  pause: vi.fn(),
  center: vi.fn(() => ({ x: 12, y: 20 })),
  zoom: vi.fn(() => 1.7),
}));
vi.mock('react-force-graph-2d', () => ({
  default: forwardRef(function Graph(props: { onEngineStop: () => void }, ref) {
    mock.stop = props.onEngineStop;
    mock.props = props;
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
        onSelect={() => {}}
        onHover={() => {}}
      />
    </React.StrictMode>,
  );
  expect(screen.getByRole('status').textContent).toContain('正在准备图谱');
  expect(mock.props.cooldownTicks).toBeGreaterThan(0);
  expect(mock.props.cooldownTime).toBeGreaterThan(0);
  expect(mock.fit).not.toHaveBeenCalled();
  act(() => mock.stop());
  expect(mock.fit).toHaveBeenCalledWith(0, 65);
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

function renderLabels(scale = 1.2, positions: number[][] = []) {
  const text: string[] = [];
  const ctx = {
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    measureText: () => ({ width: 40 }),
    fillText: (value: string, x: number, y: number) => {
      text.push(value);
      positions.push([x, y]);
    },
  };
  mock.props.onRenderFramePost(ctx, scale);
  return text;
}
function mountIsolatedNodes(connected = false, count = 2) {
  const data = {
    ...demoMap,
    nodes: Array.from({ length: count }, (_, i) => ({
      ...demoMap.nodes[i % demoMap.nodes.length],
      organizationId: `test:${i}`,
    })),
  };
  const index = graphIndex(data);
  index.groups = [];
  index.peers = new Map(
    index.nodes.map((n) => [
      n.organizationId,
      connected
        ? index.nodes
            .filter((other) => other !== n)
            .map((other) => other.organizationId)
        : [],
    ]),
  );
  render(
    <EnterpriseGraphCanvas
      index={index}
      selected={null}
      hover={null}
      ownId=""
      matches={new Set()}
      scope={null}
      sizeMode="degree"
      reducedMotion={false}
      onSelect={() => {}}
      onHover={() => {}}
    />,
  );
  const nodes = mock.props.graphData.nodes;
  nodes[0].x = 0;
  nodes[0].y = -127.998;
  nodes[1].x = 200;
  nodes[1].y = 100;
  return nodes;
}
it('keeps isolated labels visible across subpixel motion at fractional zoom', () => {
  const nodes = mountIsolatedNodes();
  for (const y of [-127.998, -127.995, -127.992, 100.001]) {
    nodes[0].y = y;
    expect(renderLabels()).toHaveLength(2);
  }
});
it('preserves label visibility during drag and settling, then resolves real overlap', () => {
  const nodes = mountIsolatedNodes(true);
  nodes[0].y = 0;
  const before = renderLabels();
  expect(before).toHaveLength(2);
  act(() => mock.props.onNodeDrag(nodes[0], { x: 1, y: 0 }));
  nodes[1].x = nodes[0].x;
  nodes[1].y = nodes[0].y;
  expect(renderLabels()).toEqual(before);
  act(() => mock.props.onNodeDragEnd(nodes[0]));
  expect(renderLabels()).toEqual(before);
  act(() => mock.stop());
  expect(renderLabels()).toHaveLength(2);
});

it('always names isolated nodes even when their label areas overlap', () => {
  const nodes = mountIsolatedNodes();
  nodes[1].x = nodes[0].x;
  nodes[1].y = nodes[0].y;
  expect(renderLabels()).toHaveLength(2);
});
it('keeps isolated enterprise names when zoomed out in a large graph', () => {
  const nodes = mountIsolatedNodes(false, 51);
  nodes.forEach((node: any, i: number) => {
    node.x = i * 200;
    node.y = 0;
  });
  expect(renderLabels(0.4)).toHaveLength(51);
});

it('settles the hidden initial layout even when reduced motion is enabled', async () => {
  render(
    <EnterpriseGraphCanvas
      index={graphIndex(demoMap)}
      selected={null}
      hover={null}
      ownId=""
      matches={new Set()}
      scope={null}
      sizeMode="degree"
      reducedMotion
      onSelect={() => {}}
      onHover={() => {}}
    />,
  );
  expect(mock.props.cooldownTicks).toBeGreaterThan(0);
  expect(screen.getByRole('status')).toBeTruthy();
  act(() => mock.stop());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  expect(mock.fit).toHaveBeenCalledWith(0, 65);
  expect(mock.props.cooldownTicks).toBe(0);
});

it('draws every connected company name in a crowded cluster', () => {
  const nodes = mountIsolatedNodes(true, 4);
  nodes.forEach((node: any, i: number) => {
    node.x = i * 4;
    node.y = 0;
  });
  const positions: number[][] = [];
  expect(renderLabels(1.2, positions)).toHaveLength(4);
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const [a, b] = [positions[i], positions[j]];
      expect(
        Math.abs(a[0] - b[0]) >= 40 || Math.abs(a[1] - b[1]) >= 12 / 1.2,
      ).toBe(true);
    }
  }
});
it('never drops connected company labels at low zoom', () => {
  const nodes = mountIsolatedNodes(true, 51);
  nodes.forEach((node: any, i: number) => {
    node.x = i * 200;
    node.y = 0;
  });
  expect(renderLabels(0.4)).toHaveLength(51);
});

it('renders only company names on canvas and shows full name plus industry only during hover', async () => {
  const index = graphIndex(demoMap);
  const company = index.nodes[0];
  const props = {
    index,
    selected: null as string | null,
    hover: null as string | null,
    ownId: '',
    matches: new Set<string>(),
    scope: null,
    sizeMode: 'degree' as const,
    reducedMotion: false,
    onSelect: () => {},
    onHover: () => {},
  };
  const view = render(<EnterpriseGraphCanvas {...props} />);
  expect(renderLabels()).toHaveLength(index.nodes.length);
  act(() => mock.stop());
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  view.rerender(
    <EnterpriseGraphCanvas {...props} hover={company.organizationId} />,
  );
  const tip = screen.getByRole('tooltip');
  expect(tip.textContent).toContain(company.organizationName);
  expect(tip.textContent).toContain(company.primaryIndustryName);
  expect(tip.textContent).not.toContain('关联');
  expect(tip.textContent).not.toContain('家企业');
  view.rerender(
    <EnterpriseGraphCanvas {...props} selected={company.organizationId} />,
  );
  expect(screen.queryByRole('tooltip')).toBeNull();
});
