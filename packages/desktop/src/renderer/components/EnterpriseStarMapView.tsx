import { supplyDemo } from '../starMap/supplyDemo.js';
import { RecurringTaskRegistry } from 'otto-core/recurring-tasks';
import { useModuleReadCache } from '../state/ModuleReadProvider.js';
import { loadStarMapCanvas } from '../starMap/loadCanvas.js';
import { EnterpriseList } from '../starMap/EnterpriseList.js';
import { clearLayouts } from '../starMap/layoutCache.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, {
  Component,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { EnterprisePublicProfilePanel } from './EnterprisePublicProfilePanel.js';
import {
  accessDenied,
  graphIndex,
  safeWebsite,
  searchEnterprises,
  type RelationMode,
  type StarMapData,
} from '../starMap/model.js';
import type {
  Camera,
  GraphControls,
} from '../starMap/EnterpriseGraphCanvas.js';
import './EnterpriseStarMapView.css';
import { emitStarMapEvent } from '../starMap/telemetry.js';

const Canvas = lazy(loadStarMapCanvas);
class GraphBoundary extends Component<
  { children: React.ReactNode; onFail: () => void },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onFail();
  }
  render() {
    return this.state.failed ? (
      <div className="star-empty">
        画布暂不可用，请使用企业列表，或点击重试画布。
      </div>
    ) : (
      this.props.children
    );
  }
}
const planned = ['上下游', '能力互补', '共同服务领域', '已确认合作'];
const messageOf = (error: unknown) =>
  String(error instanceof Error ? error.message : error)
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '');

export function EnterpriseStarMapView({
  onBack,
  initialSource = 'real',
}: {
  onBack: () => void;
  initialSource?: 'real' | 'demo';
}): React.JSX.Element {
  const cache = useModuleReadCache();
  const [source, setSource] = useState(initialSource);
  const [relation, setRelation] = useState<RelationMode>('same_industry');
  const relationRef = useRef(relation);
  relationRef.current = relation;
  const [closedNeeds, setClosedNeeds] = useState<Set<string>>(new Set());
  const [data, setData] = useState<StarMapData | null>(() =>
    initialSource === 'real'
      ? (cache.peek<StarMapData>('star-map') ?? null)
      : null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [offline, setOffline] = useState(() => !navigator.onLine);
  useEffect(() => {
    const lost = () => setOffline(true);
    const restored = () => setOffline(false);
    window.addEventListener('offline', lost);
    window.addEventListener('online', restored);
    return () => {
      window.removeEventListener('offline', lost);
      window.removeEventListener('online', restored);
    };
  }, []);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [localRoot, setLocalRoot] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [systemReduce, setSystemReduce] = useState(
    () =>
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  );
  const [graphKey, setGraphKey] = useState(0);
  const [graphFailed, setGraphFailed] = useState(false);
  const [canEdit, setCanEdit] = useState(false);
  const [accountKey, setAccountKey] = useState('');
  const [editor, setEditor] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [resultFocus, setResultFocus] = useState(-1);
  const resultsId = React.useId();
  const canvas = useRef<GraphControls>(null);
  const beforeLocal = useRef<Camera | null>(null);
  const requestId = useRef(0);
  const active = useRef(true);
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const previousIdentity = useRef('');
  const modal = useRef<HTMLDivElement>(null);
  const editorTrigger = useRef<HTMLButtonElement>(null);
  const detailTitle = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (selected) detailTitle.current?.focus({ preventScroll: true });
  }, [selected]);
  useEffect(() => {
    emitStarMapEvent('star_map_open', source, relation);
  }, [source, relation]);
  const frame = useRef<number>();
  const schedule = useCallback((fn: () => void) => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(fn);
  }, []);
  const resetExploration = useCallback(() => {
    clearLayouts();
    setSelected(null);
    setHover(null);
    setLocalRoot(null);
    setQuery('');
    setSearch('');
    beforeLocal.current = null;
    setGraphKey((key) => key + 1);
  }, []);
  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError('');
    try {
      if (source === 'real' && window.otto.enterpriseSession) {
        const session = await window.otto.enterpriseSession();
        if (!active.current || id !== requestId.current) return;
        const identity = session.account
          ? `${session.serverUrl}:${session.account.id}:${session.account.organizationId}`
          : '';
        if (previousIdentity.current && previousIdentity.current !== identity) {
          cache.remove('star-map');
          setData(null);
          resetExploration();
        }
        previousIdentity.current = identity;
        setAccountKey(identity);
        setCanEdit(session.account?.isAdmin === true);
        if (!session.account)
          throw new Error('[STAR_MAP_ACCESS_DENIED] 请登录后查看园区企业');
      }
      const next: StarMapData =
        source === 'demo'
          ? structuredClone(supplyDemo)
          : await cache.read(
              'star-map',
              () => window.otto.enterpriseParkStarMap(),
              0,
            );
      if (!active.current || id !== requestId.current) return;
      if (next.dataSource === 'demo' && source === 'real') {
        setSource('demo');
        return;
      }
      setData((previous) => {
        if (previous && previous.parkId !== next.parkId) resetExploration();
        return next;
      });
      setSelected((current) => {
        if (
          current &&
          !next.nodes.some(
            (node) => node.organizationId === current && node.isPublic,
          )
        ) {
          setNotice('该企业资料已不可查看');
          return null;
        }
        return current;
      });
      setHover((current) =>
        current &&
        next.nodes.some(
          (node) => node.organizationId === current && node.isPublic,
        )
          ? current
          : null,
      );
      setLocalRoot((current) =>
        current &&
        next.nodes.some(
          (node) => node.organizationId === current && node.isPublic,
        )
          ? current
          : null,
      );
    } catch (cause) {
      if (!active.current || id !== requestId.current) return;
      if (accessDenied(cause)) {
        cache.remove('star-map');
        setData(null);
        resetExploration();
        setCanEdit(false);
        setEditor(false);
      }
      setError(messageOf(cause));
      emitStarMapEvent('star_map_error', source, relationRef.current);
    } finally {
      if (active.current && id === requestId.current) setLoading(false);
    }
  }, [cache, source, resetExploration]);
  useEffect(() => {
    active.current = true;
    let current = true;
    void load();
    const focus = async () => {
      if (current && document.visibilityState !== 'hidden' && sourceRef.current === 'real')
        await load();
    };
    const stop = source === 'real' ? new RecurringTaskRegistry().register({
      name: 'desktop.enterprise-star-map',
      source: 'packages/desktop/src/renderer/components/EnterpriseStarMapView.tsx',
      intervalMs: 30_000,
      estimatedCostUsdPerRun: 0,
      getInputVersion: () => String(Date.now()),
      run: focus,
    }) : undefined;
    const updated = () => {
      if (sourceRef.current === 'real') void load();
    };
    const revoke = () => {
      cache.remove('star-map');
      ++requestId.current;
      setData(null);
      resetExploration();
      setEditor(false);
      setCanEdit(false);
      setAccountKey('');
      setLoading(false);
      setError('登录状态已失效，请重新登录');
    };
    const unsub = window.otto.onEnterpriseSessionInvalidated?.(revoke);
    const accountChanged = window.otto.onEnterpriseAccountUpdated?.(() => {
      cache.remove('star-map');
      if (sourceRef.current === 'real') {
        ++requestId.current;
        setData(null);
        resetExploration();
        void load();
      }
    });
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    window.addEventListener('otto:enterprise-profile-updated', updated);
    return () => {
      current = false;
      active.current = false;
      // Invalidate the latest request, deliberately not the generation captured at mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++requestId.current;
      stop?.();
      unsub?.();
      accountChanged?.();
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
      window.removeEventListener('otto:enterprise-profile-updated', updated);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [cache, load, resetExploration, source]);
  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(query);
      setResultFocus(-1);
    }, 200);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const media = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!media) return;
    const update = () => setSystemReduce(media.matches);
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);
  const isSupplyDemo = source === 'demo' && data?.parkId === supplyDemo.parkId;
  const activeData = useMemo(
    () =>
      !data || !isSupplyDemo
        ? data
        : {
            ...data,
            nodes: data.nodes.map((node) => ({
              ...node,
              demoCooperationNeeds: (node.demoCooperationNeeds ?? []).filter(
                (need) =>
                  !closedNeeds.has(JSON.stringify([node.organizationId, need])),
              ),
            })),
          },
    [data, isSupplyDemo, closedNeeds],
  );
  const index = useMemo(
    () =>
      graphIndex(
        activeData ?? {
          parkId: '',
          parkName: '',
          currentOrganizationId: '',
          generatedAt: '',
          nodes: [],
          edges: [],
        },
        relation,
      ),
    [activeData, relation],
  );
  const scope = useMemo(
    () =>
      localRoot
        ? new Set([localRoot, ...(index.peers.get(localRoot) ?? [])])
        : null,
    [localRoot, index],
  );
  const results = useMemo(
    () => searchEnterprises(index.nodes, search),
    [index, search],
  );
  const displayed = useMemo(
    () =>
      search.trim()
        ? results
        : scope
          ? index.nodes.filter((node) => scope.has(node.organizationId))
          : index.nodes,
    [search, results, scope, index.nodes],
  );
  const matches = useMemo(
    () =>
      new Set(search.trim() ? results.map((node) => node.organizationId) : []),
    [results, search],
  );
  const detail = selected ? index.byId.get(selected) : undefined;
  const own = data?.currentOrganizationId
    ? index.byId.get(data.currentOrganizationId)
    : undefined;
  const peers = detail
    ? (index.peers.get(detail.organizationId) ?? [])
        .map((id) => index.byId.get(id)!)
        .filter(Boolean)
        .sort((a, b) =>
          a.organizationName.localeCompare(b.organizationName, 'zh-CN'),
        )
    : [];
  const overCapacity = index.nodes.length > 300 && !scope;
  const returnFull = () => {
    setLocalRoot(null);
    const camera = beforeLocal.current;
    beforeLocal.current = null;
    schedule(() => {
      if (camera) canvas.current?.restore(camera);
    });
  };
  const select = (id: string | null, locate = false) => {
    setSelected(id);
    if (id)
      emitStarMapEvent(
        locate && search.trim()
          ? 'search_result_selected'
          : 'enterprise_detail_open',
        source,
        relation,
      );
    setNotice('');
    if (id && scope && !scope.has(id)) {
      setLocalRoot(null);
      beforeLocal.current = null;
      setNotice('已返回全图');
    }
    if (locate && id) schedule(() => canvas.current?.locate(id));
  };
  const onlyPeers = () => {
    if (!selected) return;
    emitStarMapEvent('peer_view_open', source, relation);
    if (!localRoot) beforeLocal.current = canvas.current?.camera() ?? null;
    setLocalRoot(selected);
    schedule(() => canvas.current?.fit());
  };
  const switchSource = () => {
    ++requestId.current;
    setData(null);
    resetExploration();
    setEditor(false);
    setNotice('');
    setClosedNeeds(new Set());
    setSource(source === 'real' ? 'demo' : 'real');
  };
  const closeEditor = () => {
    if (dirty && !window.confirm('有未保存的企业资料，放弃修改？')) return;
    setEditor(false);
    setDirty(false);
    schedule(() => editorTrigger.current?.focus());
  };
  useEffect(() => {
    if (editor) modal.current?.querySelector<HTMLElement>('button')?.focus();
  }, [editor]);
  const openWebsite = async (value: string | undefined) => {
    const url = safeWebsite(value);
    if (!url) return;
    try {
      await window.otto.openExternal(url);
      emitStarMapEvent('website_open', source, relation);
    } catch {
      setNotice('打开链接失败，请重试');
    }
  };
  const copy = async (value: string) => {
    try {
      if (!(await window.otto.writeClipboard(value))) throw new Error('copy');
      setNotice('已复制');
      emitStarMapEvent('public_contact_copy', source, relation);
    } catch {
      setNotice('复制失败，请重试');
    }
  };
  const onEscape = (event: React.KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.stopPropagation();
    if (editor) {
      closeEditor();
      return;
    }
    if (query) {
      setQuery('');
      return;
    }
    if (selected) {
      setSelected(null);
      return;
    }
    if (localRoot) returnFull();
  };
  return (
    <section
      className="enterprise-star"
      aria-label="企业星链图"
      onKeyDown={onEscape}
    >
      <header className="star-header">
        <div className="star-heading">
          <button
            className="star-back"
            onClick={onBack}
            aria-label="返回园区服务"
          >
            ←
          </button>
          <div>
            <span className="star-eyebrow">园区 · 企业发现</span>
            <h2>{data?.parkName ?? '企业星链图'}</h2>
          </div>
        </div>
        <label className="star-relation">
          连接方式
          <select
            aria-label="连接方式"
            value={relation}
            onChange={(event) => {
              setRelation(event.target.value as RelationMode);
              emitStarMapEvent(
                'relation_mode_changed',
                source,
                event.target.value as RelationMode,
              );
              setLocalRoot(null);
              setHover(null);
              beforeLocal.current = null;
              setNotice('连接方式已切换，节点大小按当前模式的关联企业数计算。');
            }}
          >
            <option value="same_industry">同行业</option>
            <option value="supply_demand">供需匹配</option>
            {planned.map((name) => (
              <option key={name} disabled>
                {name} · 规划中
              </option>
            ))}
          </select>
        </label>
      </header>
      <div className="star-toolbar">
        <div className="star-search">
          <span aria-hidden="true">⌕</span>
          <input
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={Boolean(search.trim())}
            aria-controls={search.trim() ? resultsId : undefined}
            aria-activedescendant={
              search.trim() && resultFocus >= 0
                ? `${resultsId}-${resultFocus}`
                : undefined
            }
            aria-label="搜索企业名称或业务"
            placeholder="搜索企业名称或业务"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                const next = Math.max(
                  0,
                  Math.min(
                    results.length - 1,
                    resultFocus + (event.key === 'ArrowDown' ? 1 : -1),
                  ),
                );
                setResultFocus(next);
                schedule(() =>
                  document
                    .getElementById(`${resultsId}-${next}`)
                    ?.scrollIntoView?.({ block: 'nearest' }),
                );
              }
              if (event.key === 'Enter' && search.trim() && results.length) {
                event.preventDefault();
                select(
                  results[Math.max(0, resultFocus)]?.organizationId ??
                    results[0].organizationId,
                  true,
                );
              }
            }}
          />
          {query ? (
            <button aria-label="清空搜索" onClick={() => setQuery('')}>
              ×
            </button>
          ) : null}
        </div>
        <div className="star-toolbar-spacer" />
        {source === 'demo' ? (
          <span className="star-demo-badge">公开资料演示数据 · 供需为模拟</span>
        ) : null}
        <button onClick={switchSource}>
          {source === 'real' ? '体验演示' : '返回真实园区'}
        </button>
      </div>
      {error ? (
        <div className="star-feedback" role="alert">
          {data ? '更新失败，显示上次加载内容。 ' : ''}
          {error}
          <button onClick={() => void load()} disabled={loading}>
            重试
          </button>
        </div>
      ) : null}
      {offline && source === 'real' ? (
        <div className="star-own-notice" role="status">
          当前离线，展示上次加载的资料；联网后自动刷新。
        </div>
      ) : null}
      {relation === 'supply_demand' ? (
        <div className="star-own-notice">
          {isSupplyDemo
            ? '按模拟供给与需求匹配，仅用于体验。'
            : '按公开产品与有效需求的词条匹配。'}
          箭头从提供方指向需求方，表示潜在机会，不代表已合作。点击企业查看供需方向与具体条目。
          {isSupplyDemo
            ? ' 可在详情中演示完成或恢复需求。'
            : ' 在企业资料中维护产品与服务、合作需求；已完成需求请移除并保存。'}
        </div>
      ) : null}
      {notice ? (
        <div className="star-feedback" role="status">
          {notice}
        </div>
      ) : null}
      {source === 'real' && data && !own ? (
        <div className="star-own-notice">
          本企业尚未进入星链图。
          {canEdit ? (
            <button ref={editorTrigger} onClick={() => setEditor(true)}>
              完善企业资料
            </button>
          ) : (
            <span>请联系企业资料管理员完善并公开资料。</span>
          )}
        </div>
      ) : null}
      {localRoot ? (
        <div className="star-scope">
          <button onClick={returnFull}>← 返回全图</button>
          <span>
            仅看{' '}
            {index.byId.get(localRoot)?.displayName ||
              index.byId.get(localRoot)?.organizationName}{' '}
            及{relation === 'supply_demand' ? '供需关联企业' : '同行'} ·{' '}
            {scope?.size} 家
          </span>
        </div>
      ) : null}
      <div className="star-workspace">
        {search.trim() || overCapacity || graphFailed ? (
          <aside className="star-list" aria-label="企业列表">
            <div className="star-list-title">
              <strong>{search.trim() ? '搜索整个园区' : '企业列表'}</strong>
              <span>{displayed.length} 家</span>
            </div>
            {displayed.length === 0 ? (
              <p className="star-muted">
                未找到相关企业，试试企业名称或其他业务关键词。
              </p>
            ) : null}
            <EnterpriseList
              nodes={displayed}
              id={resultsId}
              selected={selected}
              activeIndex={resultFocus}
              onActiveIndex={setResultFocus}
              onSelect={(id) => select(id, true)}
              ownId={data?.currentOrganizationId ?? ''}
            />
          </aside>
        ) : null}
        <div className="star-graph-region">
          {!data ? (
            <div className="star-empty">
              {loading
                ? '正在加载企业…'
                : error
                  ? '暂时无法显示企业资料'
                  : '暂无企业资料'}
            </div>
          ) : index.nodes.length === 0 ? (
            <div className="star-empty">园区暂无已公开资料的企业</div>
          ) : overCapacity ? (
            <div className="star-empty">
              当前共 {index.nodes.length}{' '}
              家企业，超过全图展示容量。请在列表选择企业，再点击“
              {relation === 'supply_demand' ? '仅看供需关联' : '仅看同行'}”。
            </div>
          ) : scope && scope.size > 300 ? (
            <div className="star-empty">
              当前范围有 {scope.size} 家企业，请使用完整企业列表浏览。
            </div>
          ) : (
            <GraphBoundary
              key={`${source}:${data.parkId}:${graphKey}`}
              onFail={() => {
                setGraphFailed(true);
              }}
            >
              <Suspense
                fallback={<div className="star-empty">正在准备图谱画布…</div>}
              >
                <Canvas
                  ref={canvas}
                  cacheKey={`${source}:${accountKey}:${data.parkId}:${relation}`}
                  index={index}
                  selected={selected}
                  hover={hover}
                  ownId={data.currentOrganizationId}
                  matches={matches}
                  scope={scope}
                  sizeMode="degree"
                  reducedMotion={systemReduce}
                  onSelect={select}
                  onHover={setHover}
                />
              </Suspense>
            </GraphBoundary>
          )}
          {graphFailed ? (
            <button
              className="star-retry-canvas"
              onClick={() => {
                setGraphFailed(false);
                setGraphKey((key) => key + 1);
              }}
            >
              重试画布
            </button>
          ) : null}
          <div className="star-canvas-controls">
            <button
              onClick={() => canvas.current?.zoom(1.25)}
              aria-label="放大"
            >
              ＋
            </button>
            <button onClick={() => canvas.current?.zoom(0.8)} aria-label="缩小">
              −
            </button>
            <button
              className="star-fit-control"
              onClick={() => canvas.current?.fit()}
              aria-label="适配全图"
              title="适配全图"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M8 3H3v5M16 3h5v5M21 16v5h-5M8 21H3v-5" />
                <rect x="8" y="8" width="8" height="8" rx="1" />
              </svg>
            </button>
            <button
              disabled={!own}
              title={
                !own
                  ? source === 'demo'
                    ? '演示未设置本企业'
                    : '本企业尚未公开或不在可见数据中'
                  : undefined
              }
              onClick={() => own && select(own.organizationId, true)}
            >
              回到本企业
            </button>
          </div>
        </div>
        {detail ? (
          <aside className="star-detail" aria-label="企业资料">
            <button
              className="star-close"
              aria-label="关闭企业资料"
              onClick={() => setSelected(null)}
            >
              ×
            </button>
            <span className="star-eyebrow">
              {detail.organizationId === data?.currentOrganizationId
                ? '本企业'
                : '企业资料'}
            </span>
            <h3 ref={detailTitle} tabIndex={-1}>
              {detail.organizationName}
            </h3>
            <div className="star-industry-pill">
              {detail.primaryIndustryName || '行业待完善'}
            </div>
            {source === 'demo' ? (
              <p className="star-source-note">公开资料整理 · 行业为调研分类</p>
            ) : detail.primaryIndustryCode &&
              !detail.industryConfirmedByCompany ? (
              <p>行业待确认</p>
            ) : null}
            <p className="star-summary">
              {detail.summary || '暂未填写企业介绍'}
            </p>
            {(
              ['productsServices', 'capabilities', 'cooperationNeeds'] as const
            ).map((key, i) =>
              detail[key].length ? (
                <section key={key}>
                  <h4>{['产品与服务', '公开能力', '公开合作需求'][i]}</h4>
                  <ul>
                    {detail[key].map((text) => (
                      <li key={text}>{text}</li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
            {isSupplyDemo ? (
              <section>
                <h4>模拟供给与需求</h4>
                <p>
                  以下供需条目仅为演示设定，不代表该企业真实业务或采购意向。
                </p>
                <p>
                  模拟供给：{detail.demoProductsServices?.join('、') || '无'}
                </p>
                <p className="star-muted">
                  仅影响本次虚拟演示，重新进入演示恢复初始需求。
                </p>
                {data?.nodes
                  .find((node) => node.organizationId === detail.organizationId)
                  ?.demoCooperationNeeds?.map((need) => {
                    const key = JSON.stringify([detail.organizationId, need]);
                    const closed = closedNeeds.has(key);
                    return (
                      <p key={need}>
                        {need} · {closed ? '已完成' : '进行中'}{' '}
                        <button
                          aria-label={`演示${closed ? '恢复' : '完成'}需求：${need}`}
                          onClick={() =>
                            setClosedNeeds((current) => {
                              const next = new Set(current);
                              if (closed) next.delete(key);
                              else next.add(key);
                              return next;
                            })
                          }
                        >
                          {closed ? '恢复需求' : '标记已完成'}
                        </button>
                      </p>
                    );
                  })}
              </section>
            ) : null}
            {relation === 'supply_demand' ? (
              <section>
                {(['incoming', 'outgoing'] as const).map((direction) => {
                  const matches = (index.matches ?? []).filter(
                    (match) =>
                      (direction === 'incoming'
                        ? match.consumerId
                        : match.providerId) === detail.organizationId,
                  );
                  return (
                    <section key={direction}>
                      <h4>
                        {direction === 'incoming'
                          ? '谁能满足我的需求'
                          : '谁可能需要我'}
                      </h4>
                      {matches.length ? (
                        matches.map((match, i) => {
                          const other =
                            direction === 'incoming'
                              ? match.providerId
                              : match.consumerId;
                          return (
                            <p key={`${other}:${i}`}>
                              <button onClick={() => select(other, true)}>
                                {index.byId.get(other)?.organizationName}
                              </button>{' '}
                              {direction === 'incoming' ? '提供' : '需要'}「
                              {direction === 'incoming'
                                ? match.product
                                : match.need}
                              」
                            </p>
                          );
                        })
                      ) : (
                        <p className="star-muted">暂无匹配</p>
                      )}
                    </section>
                  );
                })}
              </section>
            ) : null}
            {detail.officeAddress ? (
              <section>
                <h4>
                  {{
                    production: '生产地址',
                    registered: '登记住所',
                    park_only: '园区位置',
                  }[detail.addressType ?? ''] ?? '联系地址'}
                </h4>
                <p>{detail.officeAddress}</p>
              </section>
            ) : null}
            <section>
              <h4>公开联系渠道</h4>
              {safeWebsite(detail.website) ? (
                <button onClick={() => void openWebsite(detail.website)}>
                  访问企业官网 ↗
                </button>
              ) : null}
              {detail.publicContact ? (
                <>
                  <p className="star-contact">{detail.publicContact}</p>
                  <button onClick={() => void copy(detail.publicContact)}>
                    复制联系方式
                  </button>
                </>
              ) : (
                <p className="star-muted">暂未公开联系方式</p>
              )}
            </section>
            <section>
              <div className="star-peer-heading">
                <h4>
                  {relation === 'supply_demand' ? '供需关联企业' : '同行企业'}{' '}
                  {peers.length} 家
                </h4>
                <button onClick={onlyPeers}>
                  {relation === 'supply_demand' ? '仅看供需关联' : '仅看同行'}
                </button>
              </div>
              {!peers.length ? (
                <p className="star-muted">
                  {relation === 'supply_demand'
                    ? '暂无明确的有效供需匹配；可完善具体产品与需求。'
                    : !detail.primaryIndustryCode
                      ? '主营行业待完善'
                      : source === 'real' && !detail.industryConfirmedByCompany
                        ? '主营行业待确认'
                        : '暂未发现其他同行'}
                </p>
              ) : (
                <div className="star-peers">
                  {peers.map((node) => (
                    <button
                      key={node.organizationId}
                      onClick={() => select(node.organizationId, true)}
                    >
                      {node.organizationName}
                      <span aria-hidden="true">↗</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
            {source === 'real' &&
            detail.organizationId === data?.currentOrganizationId &&
            canEdit ? (
              <button ref={editorTrigger} onClick={() => setEditor(true)}>
                完善主营行业与企业资料
              </button>
            ) : null}
            {source === 'demo' ? (
              <details className="star-provenance">
                <summary>资料来源与核查说明</summary>
                <p>核查日期：{detail.retrievedAt || '未提供'}</p>
                {safeWebsite(detail.parkSourceUrl) ? (
                  <button
                    onClick={() => void openWebsite(detail.parkSourceUrl)}
                  >
                    查看园区关系来源 ↗
                  </button>
                ) : null}
                {safeWebsite(detail.profileSourceUrl) ? (
                  <button
                    onClick={() => void openWebsite(detail.profileSourceUrl)}
                  >
                    查看业务来源 ↗
                  </button>
                ) : null}
                <p>{detail.notes || '公开地址不等于今日租赁在驻确认。'}</p>
              </details>
            ) : null}
          </aside>
        ) : null}
      </div>
      {editor ? (
        <div className="star-editor-overlay">
          <div
            ref={modal}
            className="star-editor"
            role="dialog"
            aria-modal="true"
            aria-label="维护企业资料"
            onKeyDown={(event) => {
              if (event.key === 'Tab') {
                const elements = Array.from(
                  modal.current?.querySelectorAll<HTMLElement>(
                    'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled)',
                  ) ?? [],
                );
                const first = elements[0];
                const last = elements[elements.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last?.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first?.focus();
                }
              }
            }}
          >
            <button onClick={closeEditor}>关闭资料维护</button>
            <EnterprisePublicProfilePanel
              canEdit={canEdit}
              onDirtyChange={setDirty}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
