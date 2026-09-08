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
  demoMap,
  graphIndex,
  safeWebsite,
  searchEnterprises,
  type SizeMode,
  type StarMapData,
} from '../starMap/model.js';
import type {
  Camera,
  GraphControls,
} from '../starMap/EnterpriseGraphCanvas.js';
import './EnterpriseStarMapView.css';
import { emitStarMapEvent } from '../starMap/telemetry.js';

const Canvas = lazy(() =>
  import('../starMap/EnterpriseGraphCanvas.js').then((module) => ({
    default: module.EnterpriseGraphCanvas,
  })),
);
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
const planned = [
  '供需匹配',
  '上下游',
  '能力互补',
  '共同服务领域',
  '已确认合作',
];
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
  const [source, setSource] = useState(initialSource);
  const [data, setData] = useState<StarMapData | null>(null);
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
  const [listOpen, setListOpen] = useState(() => window.innerWidth < 768);
  const [settings, setSettings] = useState(false);
  const [sizeMode, setSizeMode] = useState<SizeMode>('uniform');
  const [showIndustries, setShowIndustries] = useState(true);
  const [motion, setMotion] = useState<'system' | 'reduce'>('system');
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
    emitStarMapEvent('star_map_open', source);
  }, [source]);
  const frame = useRef<number>();
  const reduced = motion === 'reduce' || systemReduce;
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
          ? structuredClone(demoMap)
          : await window.otto.enterpriseParkStarMap();
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
        setData(null);
        resetExploration();
        setCanEdit(false);
        setEditor(false);
      }
      setError(messageOf(cause));
      emitStarMapEvent('star_map_error', source);
    } finally {
      if (active.current && id === requestId.current) setLoading(false);
    }
  }, [source, resetExploration]);
  useEffect(() => {
    active.current = true;
    void load();
    const focus = () => {
      if (document.visibilityState !== 'hidden' && sourceRef.current === 'real')
        void load();
    };
    const interval = setInterval(focus, 30000);
    const updated = () => {
      if (sourceRef.current === 'real') void load();
    };
    const revoke = () => {
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
      active.current = false;
      // Invalidate the latest request, deliberately not the generation captured at mount.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      ++requestId.current;
      clearInterval(interval);
      unsub?.();
      accountChanged?.();
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
      window.removeEventListener('otto:enterprise-profile-updated', updated);
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [load, resetExploration]);
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
  const preferenceKey =
    source === 'demo'
      ? 'otto:star-map:demo'
      : accountKey
        ? `otto:star-map:${accountKey}`
        : '';
  useEffect(() => {
    if (!preferenceKey) return;
    try {
      const value = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}');
      setSizeMode(value.sizeMode === 'degree' ? 'degree' : 'uniform');
      setMotion(value.motion === 'reduce' ? 'reduce' : 'system');
      setShowIndustries(value.showIndustries !== false);
    } catch {
      /* Defaults survive malformed local preferences. */
    }
  }, [preferenceKey]);
  const savePreferences = (patch: Record<string, unknown>) => {
    if (!preferenceKey) return;
    try {
      localStorage.setItem(
        preferenceKey,
        JSON.stringify({ sizeMode, motion, showIndustries, ...patch }),
      );
    } catch {
      /* Storage is optional. */
    }
  };
  const index = useMemo(
    () =>
      graphIndex(
        data ?? {
          parkId: '',
          parkName: '',
          currentOrganizationId: '',
          generatedAt: '',
          nodes: [],
          edges: [],
        },
      ),
    [data],
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
    emitStarMapEvent('peer_view_open', source);
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
      emitStarMapEvent('website_open', source);
    } catch {
      setNotice('打开链接失败，请重试');
    }
  };
  const copy = async (value: string) => {
    try {
      if (!(await window.otto.writeClipboard(value))) throw new Error('copy');
      setNotice('已复制');
      emitStarMapEvent('public_contact_copy', source);
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
    if (settings) {
      setSettings(false);
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
            value="same_industry"
            onChange={() => undefined}
          >
            <option value="same_industry">同行业</option>
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
                setListOpen(true);
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
        <button
          aria-pressed={listOpen}
          onClick={() => setListOpen((value) => !value)}
        >
          企业列表
        </button>
        <div className="star-toolbar-spacer" />
        {source === 'demo' ? (
          <span className="star-demo-badge">公开资料演示数据</span>
        ) : null}
        <button onClick={switchSource}>
          {source === 'real' ? '北控宏创演示' : '返回真实园区'}
        </button>
        <button
          aria-expanded={settings}
          onClick={() => setSettings((value) => !value)}
        >
          视图设置
        </button>
        <button
          onClick={() => void load()}
          disabled={loading || source === 'demo'}
          aria-label="刷新企业资料"
        >
          {loading ? '更新中…' : '刷新'}
        </button>
      </div>
      {settings ? (
        <div className="star-settings" aria-label="视图设置">
          <label>
            节点大小
            <select
              value={sizeMode}
              onChange={(event) => {
                const value = event.target.value as SizeMode;
                setSizeMode(value);
                savePreferences({ sizeMode: value });
              }}
            >
              <option value="uniform">统一</option>
              <option value="degree">按关联企业数</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={showIndustries}
              onChange={(event) => {
                setShowIndustries(event.target.checked);
                savePreferences({ showIndustries: event.target.checked });
              }}
            />
            显示行业标识
          </label>
          <label>
            动态效果
            <select
              value={motion}
              onChange={(event) => {
                const value = event.target.value as 'system' | 'reduce';
                setMotion(value);
                savePreferences({ motion: value });
              }}
            >
              <option value="system">跟随系统</option>
              <option value="reduce">减少动态效果</option>
            </select>
          </label>
          <small>节点大小表示关联企业数，不代表企业规模或实力。</small>
        </div>
      ) : null}
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
            及同行 · {scope?.size} 家
          </span>
        </div>
      ) : null}
      <div className="star-workspace">
        {listOpen || search.trim() || overCapacity || graphFailed ? (
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
              家企业，超过全图展示容量。请在列表选择企业，再点击“仅看同行”。
            </div>
          ) : scope && scope.size > 300 ? (
            <div className="star-empty">
              该行业有 {scope.size} 家企业，请使用完整同行列表浏览。
            </div>
          ) : (
            <GraphBoundary
              key={`${source}:${data.parkId}:${graphKey}`}
              onFail={() => {
                setGraphFailed(true);
                setListOpen(true);
              }}
            >
              <Suspense
                fallback={<div className="star-empty">正在准备图谱画布…</div>}
              >
                <Canvas
                  ref={canvas}
                  cacheKey={`${source}:${accountKey}:${data.parkId}:same_industry`}
                  index={index}
                  selected={selected}
                  hover={hover}
                  ownId={data.currentOrganizationId}
                  matches={matches}
                  scope={scope}
                  sizeMode={sizeMode}
                  reducedMotion={reduced}
                  showIndustries={showIndustries}
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
            <button onClick={() => canvas.current?.fit()}>适配全图</button>
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
          <div className="star-canvas-caption">
            {scope?.size ?? index.nodes.length} 家企业 · 同行业连接
            {index.groups.some((g) => g.memberOrganizationIds.length > 12)
              ? ' · 密集行业的连线在聚焦企业时显示'
              : ''}
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
                <h4>同行企业 {peers.length} 家</h4>
                <button onClick={onlyPeers}>仅看同行</button>
              </div>
              {!peers.length ? (
                <p className="star-muted">
                  {!detail.primaryIndustryCode
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
