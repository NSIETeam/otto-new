import { layoutGeneration, readLayout, saveLayout } from './layoutCache.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import ForceGraph2D, {
  type ForceGraphMethods,
  type NodeObject,
} from 'react-force-graph-2d';
import {
  type GraphIndex,
  type SizeMode,
  nodeDiameter,
  shortName,
  visibleEdges,
} from './model.js';

type Point = NodeObject<{ id: string }>;
export interface Camera {
  x: number;
  y: number;
  zoom: number;
}
export interface GraphControls {
  fit(): void;
  locate(id: string): void;
  zoom(factor: number): void;
  camera(): Camera | null;
  restore(camera: Camera): void;
}
export interface GraphMetrics {
  nodes: number;
  physicalLinks: number;
  settleMs: number;
  frameP95Ms: number;
  frames: number;
}
interface Props {
  cacheKey?: string;
  onMetrics?: (metrics: GraphMetrics) => void;
  index: GraphIndex;
  selected: string | null;
  hover: string | null;
  ownId: string;
  matches: Set<string>;
  scope: Set<string> | null;
  sizeMode: SizeMode;
  reducedMotion: boolean;
  showIndustries: boolean;
  onSelect(id: string | null): void;
  onHover(id: string | null): void;
}

export const EnterpriseGraphCanvas = forwardRef<GraphControls, Props>(
  (props, forwardedRef) => {
    const host = useRef<HTMLDivElement>(null);
    const engine = useRef<ForceGraphMethods<Point>>();
    const initialLayout = useRef(
      props.cacheKey
        ? readLayout(
            props.cacheKey,
            new Set(props.index.nodes.map((node) => node.organizationId)),
          )
        : null,
    );
    const generation = useRef(layoutGeneration());
    const cache = useRef(
      new Map<string, Point>(
        initialLayout.current?.positions.map((point) => [
          point.id,
          { ...point },
        ]) ?? [],
      ),
    );
    const [size, setSize] = useState({ width: 900, height: 560 });
    const [palette, setPalette] = useState({
      node: '#62616c',
      text: '#474450',
      line: '#c9c6d2',
      accent: '#8861d8',
    });
    const current = useRef(props);
    current.current = props;
    const dragging = useRef(false);
    const suppressClickUntil = useRef(0);
    const pointerStart = useRef<{ x: number; y: number } | null>(null);
    const didFit = useRef(Boolean(initialLayout.current));
    const metrics = useRef({
      start: performance.now(),
      last: 0,
      intervals: [] as number[],
      frames: 0,
    });
    // Only topology changes restart the physical graph. Hover/selection/search never mutate it.
    const topology = JSON.stringify([
      props.index.nodes.map((node) => node.organizationId),
      props.index.groups,
      props.index.relationMode,
      [...props.index.peers],
    ]);
    const graph = useMemo(() => {
      const { index } = current.current;
      const alive = new Set(index.nodes.map((node) => node.organizationId));
      for (const id of cache.current.keys())
        if (!alive.has(id)) cache.current.delete(id);
      const groupById = new Map(
        index.groups.flatMap((group, i) =>
          group.memberOrganizationIds.map((id) => [id, i] as const),
        ),
      );
      const count = Math.max(1, index.groups.length);
      const nodes = index.nodes.map((profile, i) => {
        let node = cache.current.get(profile.organizationId);
        if (!node) {
          const group = groupById.get(profile.organizationId) ?? count + i;
          const angle = group * 2.399963;
          const radius = 55 * Math.sqrt(group + 1);
          node = {
            id: profile.organizationId,
            x: Math.cos(angle) * radius + (i % 4) * 18,
            y: Math.sin(angle) * radius + Math.floor(i % 7) * 13,
          };
          cache.current.set(node.id, node);
        }
        return node;
      });
      // O(n) physical scaffold; these are layout constraints, never rendered as business evidence.
      let links = index.groups.flatMap((group) =>
        group.memberOrganizationIds.slice(1).map((id, i) => ({
          source: group.memberOrganizationIds[i],
          target: id,
        })),
      );
      if (index.relationMode === 'supply_demand') {
        // A spanning forest retains actual supply connectivity with at most n-1 springs.
        const parents = new Map(nodes.map((node) => [node.id, node.id]));
        const root = (id: string): string => {
          let current = id;
          while (parents.get(current) !== current)
            current = parents.get(current)!;
          return current;
        };
        links = [];
        for (const [id, peers] of index.peers)
          for (const other of peers) {
            const a = root(id);
            const b = root(other);
            if (a !== b) {
              parents.set(a, b);
              links.push({ source: id, target: other });
            }
          }
      }
      return { nodes, links };
    }, [topology]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
      const element = host.current;
      if (!element) return;
      const measure = () =>
        setSize({
          width: Math.max(200, element.clientWidth),
          height: Math.max(280, element.clientHeight),
        });
      measure();
      const activeEngine = engine.current;
      const positions = cache.current;
      const savedGeneration = generation.current;
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      const colors = () => {
        const explicitTheme =
          document.documentElement.dataset.ottoTheme ??
          document.documentElement.getAttribute('data-theme');
        const dark = explicitTheme
          ? explicitTheme === 'dark'
          : document.body.classList.contains('dark') ||
            window.matchMedia('(prefers-color-scheme: dark)').matches;
        setPalette(
          dark
            ? {
                node: '#bab7c6',
                text: '#e2deed',
                line: '#4b455a',
                accent: '#b69aff',
              }
            : {
                node: '#62616c',
                text: '#474450',
                line: '#c9c6d2',
                accent: '#8861d8',
              },
        );
      };
      colors();
      const theme = new MutationObserver(colors);
      theme.observe(document.documentElement, { attributes: true });
      theme.observe(document.body, { attributes: true });
      return () => {
        observer.disconnect();
        theme.disconnect();
        if (props.cacheKey && activeEngine) {
          saveLayout(
            props.cacheKey,
            {
              positions: [...positions.values()].map((node) => ({
                id: node.id,
                x: node.x ?? 0,
                y: node.y ?? 0,
              })),
              camera: { ...activeEngine.centerAt(), zoom: activeEngine.zoom() },
            },
            savedGeneration,
          );
        }
        activeEngine?.pauseAnimation();
      };
    }, [props.cacheKey]);
    useEffect(() => {
      const instance = engine.current;
      if (!instance) return;
      if (initialLayout.current) {
        const camera = initialLayout.current.camera;
        instance.centerAt(camera.x, camera.y, 0);
        instance.zoom(camera.zoom, 0);
        initialLayout.current = null;
      }
      instance.d3Force('charge')?.strength?.(-65);
      instance.d3Force('link')?.distance?.(65);
      // Pairwise repulsion is handled by the engine's spatial tree. Group attraction is linear.
      const cluster = (alpha: number) => {
        if (current.current.index.relationMode === 'supply_demand') return;
        for (let i = 0; i < current.current.index.groups.length; i++) {
          const group = current.current.index.groups[i];
          const angle = i * 2.399963;
          const radius = 80 * Math.sqrt(i + 1);
          for (const id of group.memberOrganizationIds) {
            const node = cache.current.get(id);
            if (!node) continue;
            node.vx =
              (node.vx ?? 0) +
              (Math.cos(angle) * radius - (node.x ?? 0)) * 0.028 * alpha;
            node.vy =
              (node.vy ?? 0) +
              (Math.sin(angle) * radius - (node.y ?? 0)) * 0.028 * alpha;
          }
        }
      };
      // Spatial buckets keep node collision work local instead of comparing every pair.
      instance.d3Force('collision', () => {
        const cells = new Map<string, Point[]>();
        const distance = 24;
        for (const node of graph.nodes) {
          const x = node.x ?? 0;
          const y = node.y ?? 0;
          const gx = Math.floor(x / distance);
          const gy = Math.floor(y / distance);
          for (let dx = -1; dx <= 1; dx++)
            for (let dy = -1; dy <= 1; dy++) {
              for (const other of cells.get(`${gx + dx}:${gy + dy}`) ?? []) {
                const ox = x - (other.x ?? 0);
                const oy = y - (other.y ?? 0);
                const length = Math.hypot(ox, oy);
                if (length >= distance) continue;
                const push = (distance - length) * 0.45;
                const nx = length ? ox / length : 1;
                const ny = length ? oy / length : 0;
                if (node.fx == null) {
                  node.vx = (node.vx ?? 0) + nx * push;
                  node.vy = (node.vy ?? 0) + ny * push;
                }
                if (other.fx == null) {
                  other.vx = (other.vx ?? 0) - nx * push;
                  other.vy = (other.vy ?? 0) - ny * push;
                }
              }
            }
          const key = `${gx}:${gy}`;
          const cell = cells.get(key) ?? [];
          cell.push(node);
          cells.set(key, cell);
        }
      });
      instance.d3Force('industry', cluster);
      instance.resumeAnimation();
      instance.d3ReheatSimulation();
    }, [graph]);

    useImperativeHandle(
      forwardedRef,
      () => ({
        fit() {
          engine.current?.zoomToFit(
            props.reducedMotion ? 0 : 250,
            65,
            (node) => !props.scope || props.scope.has(node.id),
          );
        },
        locate(id) {
          const node = cache.current.get(id);
          if (node)
            engine.current?.centerAt(
              node.x,
              node.y,
              props.reducedMotion ? 0 : 220,
            );
        },
        zoom(factor) {
          const e = engine.current;
          if (e)
            e.zoom(
              Math.max(0.25, Math.min(4, e.zoom() * factor)),
              props.reducedMotion ? 0 : 160,
            );
        },
        camera() {
          const e = engine.current;
          return e ? { ...e.centerAt(), zoom: e.zoom() } : null;
        },
        restore(camera) {
          engine.current?.centerAt(camera.x, camera.y, 0);
          engine.current?.zoom(camera.zoom, 0);
        },
      }),
      [props.scope, props.reducedMotion],
    );

    const directions = useMemo(
      () =>
        new Set(
          (props.index.matches ?? []).map((match) =>
            JSON.stringify([match.providerId, match.consumerId]),
          ),
        ),
      [props.index.matches],
    );
    const focus = props.hover ?? props.selected;
    const related = useMemo(
      () =>
        new Set(focus ? [focus, ...(props.index.peers.get(focus) ?? [])] : []),
      [focus, props.index],
    );
    const edges = useMemo(
      () => visibleEdges(props.index, focus),
      [props.index, focus],
    );
    const isVisible = (id: string) => !props.scope || props.scope.has(id);
    const radius = (id: string, scale: number) =>
      (nodeDiameter(props.index.peers.get(id)?.length ?? 0, props.sizeMode) /
        2 /
        scale) *
      (id === focus ? 1.15 : 1);
    return (
      <div
        ref={host}
        className="enterprise-graph-canvas"
        aria-label="可拖拽缩放的企业关系图。使用企业列表可通过键盘探索。"
        onPointerDownCapture={(event) => {
          pointerStart.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerMoveCapture={(event) => {
          const start = pointerStart.current;
          if (
            start &&
            Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
          )
            suppressClickUntil.current = Date.now() + 200;
        }}
        onPointerUpCapture={() => {
          pointerStart.current = null;
        }}
        onPointerCancel={() => {
          pointerStart.current = null;
        }}
        onWheelCapture={(event) => {
          // Trackpad two-finger scrolling pans; pinch (ctrlKey) and mouse wheel zoom.
          if (
            !event.ctrlKey &&
            event.deltaMode === 0 &&
            (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 45)
          ) {
            const e = engine.current;
            if (!e) return;
            event.preventDefault();
            event.stopPropagation();
            const c = e.centerAt();
            const z = e.zoom();
            e.centerAt(c.x + event.deltaX / z, c.y + event.deltaY / z, 0);
          }
        }}
      >
        <ForceGraph2D
          ref={engine}
          graphData={graph}
          width={size.width}
          height={size.height}
          backgroundColor="transparent"
          nodeId="id"
          nodeLabel={() => ''}
          linkVisibility={false}
          nodeVisibility={(node) => isVisible(node.id)}
          autoPauseRedraw
          minZoom={0.25}
          maxZoom={4}
          warmupTicks={props.reducedMotion ? 150 : 45}
          cooldownTime={props.reducedMotion ? 0 : 2200}
          cooldownTicks={props.reducedMotion ? 0 : 130}
          onEngineStop={() => {
            const measured = metrics.current;
            const sorted = measured.intervals.slice().sort((a, b) => a - b);
            props.onMetrics?.({
              nodes: graph.nodes.length,
              physicalLinks: graph.links.length,
              settleMs: performance.now() - measured.start,
              frameP95Ms: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
              frames: measured.frames,
            });
            if (!didFit.current) {
              engine.current?.zoomToFit(props.reducedMotion ? 0 : 220, 80);
              didFit.current = true;
            }
          }}
          d3AlphaDecay={0.04}
          d3VelocityDecay={0.4}
          onNodeHover={(node) => {
            if (!dragging.current) props.onHover(node?.id ?? null);
          }}
          onNodeClick={(node) => {
            if (Date.now() > suppressClickUntil.current)
              props.onSelect(node.id);
          }}
          onBackgroundClick={() => {
            if (Date.now() > suppressClickUntil.current) props.onSelect(null);
          }}
          onNodeDrag={(node, delta) => {
            dragging.current = true;
            suppressClickUntil.current = Date.now() + 250;
            for (const id of props.index.peers.get(node.id) ?? []) {
              const other = cache.current.get(id);
              if (other) {
                other.vx = (other.vx ?? 0) + delta.x * 0.12;
                other.vy = (other.vy ?? 0) + delta.y * 0.12;
              }
            }
          }}
          onNodeDragEnd={(node) => {
            dragging.current = false;
            node.fx = undefined;
            node.fy = undefined;
            suppressClickUntil.current = Date.now() + 250;
            props.onHover(null);
          }}
          nodePointerAreaPaint={(node, color, ctx, scale) => {
            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(
              node.x ?? 0,
              node.y ?? 0,
              Math.max(12 / scale, radius(node.id, scale)),
              0,
              2 * Math.PI,
            );
            ctx.fill();
          }}
          nodeCanvasObject={(node, ctx, scale) => {
            ctx.globalAlpha = focus && !related.has(node.id) ? 0.17 : 1;
            ctx.fillStyle = node.id === focus ? palette.accent : palette.node;
            ctx.beginPath();
            ctx.arc(
              node.x ?? 0,
              node.y ?? 0,
              radius(node.id, scale),
              0,
              Math.PI * 2,
            );
            ctx.fill();
            if (node.id === props.ownId) {
              ctx.strokeStyle = palette.accent;
              ctx.lineWidth = 1.5 / scale;
              ctx.beginPath();
              ctx.arc(
                node.x ?? 0,
                node.y ?? 0,
                radius(node.id, scale) + 3 / scale,
                0,
                Math.PI * 2,
              );
              ctx.stroke();
            }
            ctx.globalAlpha = 1;
          }}
          onRenderFramePre={(ctx, scale) => {
            const now = performance.now();
            const measured = metrics.current;
            if (measured.last && measured.intervals.length < 300)
              measured.intervals.push(now - measured.last);
            measured.last = now;
            measured.frames++;
            if (props.onMetrics && host.current)
              host.current.dataset.renderFrames = String(measured.frames);
            ctx.lineWidth = (focus ? 1 : 0.65) / scale;
            ctx.strokeStyle = focus ? palette.accent : palette.line;
            ctx.globalAlpha = focus ? 0.65 : 0.5;
            ctx.beginPath();
            for (const [a, b] of edges) {
              if (!isVisible(a) || !isVisible(b)) continue;
              const s = cache.current.get(a);
              const t = cache.current.get(b);
              if (s && t) {
                ctx.moveTo(s.x ?? 0, s.y ?? 0);
                ctx.lineTo(t.x ?? 0, t.y ?? 0);
              }
            }
            ctx.stroke();
            if (props.index.relationMode === 'supply_demand') {
              ctx.fillStyle = focus ? palette.accent : palette.text;
              for (const [a, b] of edges) {
                if (!isVisible(a) || !isVisible(b)) continue;
                for (const [from, to] of [
                  [a, b],
                  [b, a],
                ]) {
                  if (!directions.has(JSON.stringify([from, to]))) continue;
                  const start = cache.current.get(from);
                  const end = cache.current.get(to);
                  if (!start || !end) continue;
                  const dx = (end.x ?? 0) - (start.x ?? 0);
                  const dy = (end.y ?? 0) - (start.y ?? 0);
                  if (Math.hypot(dx, dy) * scale < 25) continue;
                  const angle = Math.atan2(dy, dx);
                  const x = (start.x ?? 0) + dx * 0.65;
                  const y = (start.y ?? 0) + dy * 0.65;
                  ctx.save();
                  ctx.translate(x, y);
                  ctx.rotate(angle);
                  ctx.beginPath();
                  ctx.moveTo(4 / scale, 0);
                  ctx.lineTo(-3 / scale, -2.5 / scale);
                  ctx.lineTo(-3 / scale, 2.5 / scale);
                  ctx.closePath();
                  ctx.fill();
                  ctx.restore();
                }
              }
            }
            ctx.globalAlpha = 1;
          }}
          onRenderFramePost={(ctx, scale) => {
            const boxes: Array<[number, number, number, number]> = graph.nodes
              .filter((node) => isVisible(node.id))
              .map((node) => [
                (node.x ?? 0) - 7 / scale,
                (node.y ?? 0) - 7 / scale,
                14 / scale,
                14 / scale,
              ]);
            const priority = (id: string) =>
              id === props.selected
                ? 6
                : id === props.hover
                  ? 5
                  : id === props.ownId
                    ? 4
                    : props.matches.has(id)
                      ? 3
                      : related.has(id)
                        ? 2
                        : 1;
            const sorted = graph.nodes
              .filter((n) => isVisible(n.id))
              .slice()
              .sort(
                (a, b) =>
                  priority(b.id) - priority(a.id) || a.id.localeCompare(b.id),
              );
            ctx.font = `${11 / scale}px system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            for (const node of sorted) {
              const p = priority(node.id);
              if (graph.nodes.length > 50 && scale < 0.5 && p < 3) continue;
              const profile = props.index.byId.get(node.id);
              if (!profile) continue;
              const text = shortName(
                profile.displayName || profile.organizationName,
              );
              const width = ctx.measureText(text).width;
              const x = node.x ?? 0;
              const y = (node.y ?? 0) + radius(node.id, scale) + 5 / scale;
              const box: [number, number, number, number] = [
                x - width / 2 - 3 / scale,
                y - 2 / scale,
                width + 6 / scale,
                16 / scale,
              ];
              if (
                p < 5 &&
                boxes.some(
                  (b) =>
                    box[0] < b[0] + b[2] &&
                    box[0] + box[2] > b[0] &&
                    box[1] < b[1] + b[3] &&
                    box[1] + box[3] > b[1],
                )
              )
                continue;
              boxes.push(box);
              ctx.globalAlpha = focus && !related.has(node.id) ? 0.18 : 1;
              ctx.fillStyle = p >= 5 ? palette.accent : palette.text;
              ctx.fillText(text, x, y);
            }
            ctx.globalAlpha = 1;
            if (props.showIndustries && !focus) {
              ctx.font = `${10 / scale}px system-ui, sans-serif`;
              ctx.fillStyle = palette.text;
              ctx.globalAlpha = 0.5;
              for (const group of props.index.groups) {
                const members = group.memberOrganizationIds
                  .map((id) => cache.current.get(id))
                  .filter((n): n is Point => Boolean(n) && isVisible(n!.id));
                if (members.length < 2) continue;
                const x =
                  members.reduce((sum, n) => sum + (n.x ?? 0), 0) /
                  members.length;
                const y =
                  Math.min(...members.map((n) => n.y ?? 0)) - 32 / scale;
                ctx.fillText(`${group.name} · ${members.length}`, x, y);
              }
              ctx.globalAlpha = 1;
            }
          }}
        />
        {focus && props.index.byId.get(focus) ? (
          <div className="star-hover-name" role="tooltip">
            {props.index.byId.get(focus)!.organizationName} · 关联{' '}
            {props.index.peers.get(focus)?.length ?? 0} 家企业
          </div>
        ) : null}
      </div>
    );
  },
);

EnterpriseGraphCanvas.displayName = 'EnterpriseGraphCanvas';
