import { MarketMutation } from '../parkMarketMutation.js';
import { MarketImageViewer } from './MarketImageViewer.js';
import { MarketReportForm } from './MarketReportForm.js';
import { MarketRoles } from './MarketRoles.js';
import { marketRequest } from '../parkMarketApi.js';
import { MarketContactComposer } from './MarketContactCenter.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MarketDraft,
  MarketDraftScope,
} from '../../shared/park-market.js';
import {
  emptyMarketForm,
  marketFormErrors,
  switchMarketSaleMode,
  selectMarketImages,
  moveMarketImage,
  type MarketForm,
} from './ParkMarketModel.js';
import './ParkMarketDialog.css';
type Item = MarketForm & {
  id: string;
  seller?: { nickname: string };
  isOwner?: boolean;
  pendingContacts?: number;
  confirmedAt?: number;
  version: number;
  state: string;
  priceCents: number;
  parkId?: string;
  listedAt: number;
  expiresAt: number;
  cleanedAt?: number | null;
  endedAt?: number | null;
  reservation?: { expectedAt: number | null; note: string } | null;
};
type Settings = {
  parkId: string | null;
  enabled: boolean;
  ready: boolean;
  rules: string;
  contact: string;
  responsibleAccountId: string;
  timezone: string;
  version: number;
  canModerate: boolean;
  canAssign?: boolean;
};
const labels: Record<string, string> = {
  active: '在售',
  reserved: '已预留',
  offline: '已下架',
  sold: '已售出',
  removed: '管理员移除',
  deleted: '已删除',
  unavailable: '商品已不可用',
  electronics: '数码电子',
  office: '办公用品',
  home: '生活家居',
  sports: '运动户外',
  books: '书籍文娱',
  other: '其他',
  unused: '全新未用',
  like_new: '近乎全新',
  used: '正常使用',
  worn: '明显使用痕迹',
  working: '功能正常',
  faulty: '存在故障',
  untested: '未测试',
};
const errors: Record<string, string> = {
  FORBIDDEN: '当前资格、市场状态或发布限制不允许此操作',
  NOT_FOUND: '内容已不可用或你没有查看权限',
  CONFLICT: '记录已更新，请刷新后重试；发送结果不确定时使用原标识重试',
  LIMIT_REACHED: '已达到发布额度或重新上架频率限制，请稍后再试',
  DEPENDENCY_UNAVAILABLE: '市场服务依赖尚未就绪',
  INVALID_INPUT: '请检查必填信息、时间及图片',
  UNAUTHENTICATED: '请重新登录有效账号',
};
const reasonText = (reason: unknown) => {
  const text = reason instanceof Error ? reason.message : String(reason);
  return (
    Object.entries(errors).find(([key]) => text.includes(key))?.[1] ?? text
  );
};
const price = (item: Item) =>
  item.saleMode === 'free'
    ? '免费送'
    : `¥${(item.priceCents / 100).toFixed(2)}`;
function MarketPhoto({
  id,
  draftPosition,
  retry = true,
  onAvailability,
}: {
  id: string;
  draftPosition?: number;
  retry?: boolean;
  onAvailability?: (id: string, available: boolean) => void;
}) {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setSource('');
    setFailed(false);
    onAvailability?.(id, false);
    void marketRequest<{ data: string }>(
      `/images/${id}?thumbnail=true&format=data`,
    )
      .then((value) => {
        if (current) {
          setSource(`data:image/jpeg;base64,${value.data}`);
          onAvailability?.(id, true);
        }
      })
      .catch(() => {
        if (current) setFailed(true);
      });
    return () => {
      current = false;
    };
  }, [id, attempt, onAvailability]);
  return source ? (
    <img
      src={source}
      alt="商品照片"
      onError={() => {
        setSource('');
        setFailed(true);
        onAvailability?.(id, false);
      }}
    />
  ) : (
    <span className="park-market-photo-empty">
      {failed
        ? draftPosition
          ? `草稿文字已保留，第 ${draftPosition} 张图片暂时无法加载；可重试或移除后重新选择`
          : '图片暂时无法加载'
        : '加载图片…'}
      {failed && retry && (
        <button type="button" onClick={() => setAttempt((value) => value + 1)}>
          {draftPosition ? `重试第 ${draftPosition} 张图片` : '重试图片'}
        </button>
      )}
    </span>
  );
}
function formFrom(item: Item): MarketForm {
  return {
    ...(Object.fromEntries(
      Object.keys(emptyMarketForm()).map((key) => [
        key,
        item[key as keyof MarketForm] ??
          emptyMarketForm()[key as keyof MarketForm],
      ]),
    ) as unknown as MarketForm),
    price: (item.priceCents / 100).toFixed(2),
    rememberedPrice: (item.priceCents / 100).toFixed(2),
    imageIds: [...item.imageIds],
  };
}
interface Upload {
  key: string;
  file: File;
  error?: string;
  busy: boolean;
  id?: string;
  phase?: 'waiting' | 'reading' | 'uploading';
  loaded?: number;
  total?: number;
}
export function ParkMarketDialog({
  open,
  accountId,
  draftScope,
  initialView = 'market',
  initialListingId,
  initialError,
  onClose,
}: {
  open: boolean;
  accountId: string;
  draftScope?: MarketDraftScope;
  initialView?: 'market' | 'mine';
  initialListingId?: string;
  initialError?: string;
  onClose(): void;
}) {
  return open ? (
    <MarketContent
      key={JSON.stringify([
        draftScope?.server,
        draftScope?.organization,
        accountId,
        initialListingId ?? '',
      ])}
      draftScope={draftScope}
      initialListingId={initialListingId}
      initialError={initialError}
      initialView={initialView}
      onClose={onClose}
    />
  ) : null;
}
function MarketContent({
  draftScope,
  initialListingId,
  initialError,
  initialView,
  onClose,
}: {
  draftScope?: MarketDraftScope;
  initialView: 'market' | 'mine';
  initialListingId?: string;
  initialError?: string;
  onClose(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const mutation = useRef(new MarketMutation());
  const [view, setView] = useState<
    'market' | 'mine' | 'favorites' | 'form' | 'detail' | 'admin'
  >(initialView);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [ownFilter, setOwnFilter] = useState('all');
  const visibleItems =
    view === 'mine'
      ? items.filter((item) => ownFilter === 'all' || item.state === ownFilter)
      : items;
  const [selected, setSelected] = useState<Item | null>(null);
  const [own, setOwn] = useState(false);
  const [form, setForm] = useState<MarketForm>(emptyMarketForm);
  const [editing, setEditing] = useState<Pick<Item, 'id' | 'version'> | null>(
    null,
  );
  const [drafts, setDrafts] = useState<MarketDraft[]>([]);
  const [draftId, setDraftId] = useState<string>(() => crypto.randomUUID());
  const [sendId, setSendId] = useState<string | null>(null);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [unavailableImages, setUnavailableImages] = useState(new Set<string>());
  const photoAvailability = useCallback((id: string, available: boolean) => {
    setUnavailableImages((previous) => {
      if (previous.has(id) === !available) return previous;
      const next = new Set(previous);
      if (available) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const hasUnavailableImage = form.imageIds.some((id) =>
    unavailableImages.has(id),
  );
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const cancelledUploads = useRef(new Set<string>());
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (view === 'form' && Object.keys(fieldErrors).length)
      dialog.current
        ?.querySelector<HTMLElement>('[aria-invalid="true"]')
        ?.focus();
  }, [fieldErrors, view]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [appliedQuery, setAppliedQuery] = useState('');
  const listCache = useRef(
    new Map<string, { items: Item[]; cursor: string | null; scroll: number }>(),
  );
  const returnView = useRef<'market' | 'mine' | 'favorites'>(initialView);
  const [category, setCategory] = useState('');
  const [free, setFree] = useState(false);
  const [unreserved, setUnreserved] = useState(false);
  const [min, setMin] = useState('');
  const [max, setMax] = useState('');
  const [sort, setSort] = useState('latest');
  const [cursor, setCursor] = useState<string | null>(null);
  const [reserveTime, setReserveTime] = useState('');
  const [reserveNote, setReserveNote] = useState('');
  const [renew, setRenew] = useState(false);
  const [sameItem, setSameItem] = useState(false);
  const [reportMode, setReportMode] = useState<'report' | 'appeal' | null>(
    null,
  );
  const [preview, setPreview] = useState(false);
  const [imageIndex, setImageIndex] = useState<number | null>(null);
  const sequence = useRef(0);
  const mounted = useRef(true);
  const persistQueue = useRef(Promise.resolve());
  const draftsRef = useRef<MarketDraft[]>([]);
  const persistedDrafts = useRef<MarketDraft[]>([]);
  const cursorRef = useRef<string | null>(null);
  const draftIdRef = useRef(draftId);
  draftIdRef.current = draftId;
  const originalDraft = useRef<MarketDraft | null>(null);
  const draftFailure = useRef(false);
  const [draftStatus, setDraftStatus] = useState('');
  const [confirmExit, setConfirmExit] = useState(false);
  const exitAction = useRef<() => void>(onClose);
  useEffect(() => {
    mounted.current = true;
    const cancelled = cancelledUploads.current;
    dialog.current?.showModal();
    const unsubscribe = window.otto.onMarketImageProgress?.((progress) => {
      if (cancelledUploads.current.has(progress.uploadId)) return;
      setUploads((previous) =>
        previous.map((upload) =>
          upload.key === progress.uploadId
            ? {
                ...upload,
                phase: 'uploading',
                loaded: progress.loaded,
                total: progress.total,
              }
            : upload,
        ),
      );
    });
    return () => {
      mounted.current = false;
      unsubscribe?.();
      for (const upload of uploadsRef.current) {
        cancelled.add(upload.key);
        void window.otto
          .enterpriseMarketUploadCancel?.(upload.key)
          .catch(() => undefined);
      }
    };
  }, []);
  useEffect(() => {
    void marketRequest<Settings>('/settings')
      .then((value) => {
        if (mounted.current) setSettings(value);
      })
      .catch((e) => setError(reasonText(e)));
    void window.otto
      .enterpriseMarketDrafts?.()
      .then((value) => {
        if (mounted.current) {
          draftsRef.current = value;
          persistedDrafts.current = value;
          setDrafts(value);
          setDraftLoaded(true);
          if (value.some((draft) => draft.imageLeaseFailed === true))
            setNotice(
              '草稿文字已保留；部分图片续租失败，请打开相应草稿检查或重新选择图片。',
            );
          if (
            value.some(
              (draft) =>
                typeof draft.updatedAt === 'number' &&
                Date.now() - draft.updatedAt > 30 * 86400000,
            )
          )
            setNotice(
              '有超过 30 天未编辑的本机草稿，文字仍已保留；请在我的发布记录中检查图片或自行删除。',
            );
        }
      })
      .catch((e) => setError(reasonText(e)));
  }, []);
  const saveDrafts = useCallback(
    (value: MarketDraft[]) => {
      draftsRef.current = value;
      setDrafts(value);
      setDraftStatus('正在保存到本机…');
      persistQueue.current = persistQueue.current
        .then(async () => {
          if (!window.otto.enterpriseMarketDrafts)
            throw new Error('草稿安全存储不可用');
          await window.otto.enterpriseMarketDrafts(value, draftScope);
          persistedDrafts.current = value;
          draftFailure.current = false;
          if (mounted.current) setDraftStatus('已保存到本机');
        })
        .catch((e) => {
          draftFailure.current = true;
          if (mounted.current) {
            setDraftStatus('草稿保存失败');
            setError(reasonText(e));
          }
        });
      return persistQueue.current;
    },
    [draftScope],
  );
  const saveCurrentDraft = useCallback(() => {
    const draft: MarketDraft = {
      id: draftId,
      form,
      requestId: sendId,
      parkId: settings?.parkId,
      source: editing,
      updatedAt: Date.now(),
    };
    return saveDrafts([
      ...draftsRef.current.filter((d) => d.id !== draftId),
      draft,
    ]);
  }, [draftId, form, sendId, settings?.parkId, editing, saveDrafts]);
  useEffect(() => {
    if (view !== 'form' || !draftLoaded || confirmExit) return;
    const timer = setTimeout(() => {
      void saveCurrentDraft();
      void marketRequest(`/drafts/${draftId}`, 'PUT', {
        imageIds: form.imageIds,
      }).catch(() => {
        if (mounted.current)
          setNotice('文字保存在本机；附件续租失败，请联网后重试');
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [
    form.imageIds,
    draftId,
    view,
    draftLoaded,
    saveCurrentDraft,
    confirmExit,
  ]);
  const currentFormSaved = () =>
    !draftFailure.current &&
    !uploads.length &&
    JSON.stringify(
      persistedDrafts.current.find((draft) => draft.id === draftId)?.form,
    ) === JSON.stringify(form);
  const requestClose = () => {
    exitAction.current = onClose;
    if (view === 'form' && !currentFormSaved()) setConfirmExit(true);
    else onClose();
  };
  const navigate = (next: typeof view) => {
    if (view !== 'form' || currentFormSaved()) {
      setView(next);
      return;
    }
    exitAction.current = () => setView(next);
    setConfirmExit(true);
  };
  const finishExit = () => {
    for (const upload of uploadsRef.current) {
      cancelledUploads.current.add(upload.key);
      void window.otto
        .enterpriseMarketUploadCancel?.(upload.key)
        .catch(() => undefined);
    }
    setConfirmExit(false);
    exitAction.current();
  };
  const listKey = JSON.stringify([
    view,
    appliedQuery,
    category,
    sort,
    free,
    unreserved,
    min,
    max,
  ]);
  const load = useCallback(
    async (more = false) => {
      if (!['market', 'mine', 'favorites'].includes(view)) return;
      const run = ++sequence.current;
      setBusy(true);
      setError('');
      try {
        if (
          view === 'market' &&
          !free &&
          min &&
          max &&
          Number(min) > Number(max)
        )
          throw new Error('最低价不能高于最高价');
        const params = new URLSearchParams({
          query: appliedQuery,
          sort,
          free: String(free),
          unreserved: String(unreserved),
        });
        if (category) params.set('category', category);
        if (!free)
          for (const [key, value] of [
            ['minCents', min],
            ['maxCents', max],
          ])
            if (value) {
              if (!/^\d+(?:\.\d{1,2})?$/.test(value))
                throw new Error('价格最多两位小数');
              params.set(key, String(Math.round(Number(value) * 100)));
            }
        if (more && cursorRef.current) params.set('cursor', cursorRef.current);
        const result = await marketRequest<
          { items: Item[]; nextCursor?: string | null } | Item[]
        >(
          view === 'mine'
            ? '/mine'
            : view === 'favorites'
              ? '/favorites'
              : `/?${params}`,
        );
        if (mounted.current && sequence.current === run) {
          const next = Array.isArray(result) ? result : result.items;
          const combined = more
            ? [...(listCache.current.get(listKey)?.items ?? []), ...next]
            : next;
          const unique = [
            ...new Map(combined.map((item) => [item.id, item])).values(),
          ];
          setItems(unique);
          cursorRef.current = Array.isArray(result)
            ? null
            : (result.nextCursor ?? null);
          setCursor(cursorRef.current);
          listCache.current.set(listKey, {
            items: unique,
            cursor: cursorRef.current,
            scroll: more ? (dialog.current?.scrollTop ?? 0) : 0,
          });
        }
      } catch (e) {
        if (sequence.current === run) setError(reasonText(e));
      } finally {
        if (sequence.current === run) setBusy(false);
      }
    },
    [view, appliedQuery, category, sort, free, unreserved, min, max, listKey],
  );
  useEffect(() => {
    ++sequence.current;
    setBusy(false);
    if (!['market', 'mine', 'favorites'].includes(view)) return;
    const cached = listCache.current.get(listKey);
    if (cached) {
      setItems(cached.items);
      cursorRef.current = cached.cursor;
      setCursor(cached.cursor);
      const frame = requestAnimationFrame(() => {
        if (dialog.current) dialog.current.scrollTop = cached.scroll;
      });
      return () => cancelAnimationFrame(frame);
    }
    setItems([]);
    cursorRef.current = null;
    setCursor(null);
    void load();
  }, [load, listKey, view]);
  const openItem = async (item: Item, isOwn: boolean) => {
    setError('');
    setOwn(isOwn);
    if (view === 'market' || view === 'mine' || view === 'favorites') {
      returnView.current = view;
      const cached = listCache.current.get(listKey);
      if (cached) cached.scroll = dialog.current?.scrollTop ?? 0;
    }
    try {
      const detail = isOwn
        ? item
        : await marketRequest<Item>(`/listings/${item.id}`);
      setSelected(detail);
      setReserveNote(detail.reservation?.note ?? '');
      setReserveTime('');
      setRenew(false);
      setView('detail');
    } catch (e) {
      setError(reasonText(e));
    }
  };
  useEffect(() => {
    if (initialError) setError(initialError);
    if (!initialListingId) return;
    let active = true;
    void marketRequest<Item>(`/listings/${initialListingId}`)
      .then(async (detail) => {
        if (detail.isOwner) {
          const mine = await marketRequest<{ items: Item[] }>('/mine');
          detail = mine.items.find((item) => item.id === detail.id) ?? detail;
        }
        if (!active) return;
        setOwn(detail.isOwner === true || !!detail.parkId);
        setSelected(detail);
        setView('detail');
      })
      .catch(() => {
        if (active) setError('该商品仅限原园区有效成员查看，或商品已不可用');
      });
    return () => {
      active = false;
    };
  }, [initialListingId, initialError]);
  const command = async (
    action: string,
    extra: Record<string, unknown> = {},
  ) => {
    if (!selected) return;
    setBusy(true);
    setError('');
    try {
      const next = await mutation.current.run<Item>(
        `/listings/${selected.id}/${action}`,
        'POST',
        {
          expectedVersion: selected.version,
          ...extra,
        },
      );
      listCache.current.clear();
      setSelected(next);
      setNotice('已保存最新状态，可在我的消息查看咨询记录');
      try {
        const mine = await marketRequest<{ items: Item[] }>('/mine');
        setSelected(mine.items.find((item) => item.id === next.id) ?? next);
      } catch {
        setNotice('状态已保存；完整详情刷新失败，请稍后重新打开记录。');
      }
    } catch (e) {
      setError(reasonText(e));
    } finally {
      setBusy(false);
    }
  };
  const uploadOne = async (upload: Upload) => {
    if (
      !mounted.current ||
      draftIdRef.current !== draftId ||
      cancelledUploads.current.has(upload.key)
    )
      return;
    setUploads((previous) =>
      previous.map((p) =>
        p.key === upload.key
          ? {
              ...p,
              busy: true,
              error: undefined,
              phase: 'reading',
              loaded: 0,
              total: upload.file.size,
            }
          : p,
      ),
    );
    try {
      if (upload.file.size > 20 * 1024 * 1024)
        throw new Error('每张图片不得超过 20 MB');
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取文件，请重新选择'));
        reader.onprogress = (event) =>
          setUploads((previous) =>
            previous.map((p) =>
              p.key === upload.key
                ? { ...p, loaded: event.loaded, total: event.total }
                : p,
            ),
          );
        reader.readAsDataURL(upload.file);
      });
      if (cancelledUploads.current.has(upload.key)) return;
      setUploads((previous) =>
        previous.map((p) =>
          p.key === upload.key
            ? { ...p, phase: 'uploading', loaded: 0, total: upload.file.size }
            : p,
        ),
      );
      const image = await marketRequest<{ id: string }>(
        '/images?draftId=' + draftId,
        'POST',
        undefined,
        data,
        upload.key,
      );
      if (
        !mounted.current ||
        draftIdRef.current !== draftId ||
        cancelledUploads.current.has(upload.key)
      )
        return;
      setForm((previous) => ({
        ...previous,
        imageIds: [...previous.imageIds, image.id],
      }));
      setUploads((previous) => previous.filter((p) => p.key !== upload.key));
    } catch (e) {
      setUploads((previous) =>
        previous.map((p) =>
          p.key === upload.key
            ? {
                ...p,
                busy: false,
                error: cancelledUploads.current.has(upload.key)
                  ? '上传已取消，可重试或移除'
                  : reasonText(e),
              }
            : p,
        ),
      );
    }
  };
  const addFiles = (files: File[]) => {
    const { accepted, rejected } = selectMarketImages(
      files,
      form.imageIds.length + uploads.length,
    );
    if (rejected.length)
      setError(
        `最多 9 张，以下文件未加入：${rejected.map((file) => file.name).join('、')}`,
      );
    const next = accepted.map((file) => ({
      key: crypto.randomUUID(),
      file,
      busy: true,
      phase: 'waiting' as const,
    }));
    setUploads((previous) => [...previous, ...next]);
    for (const upload of next)
      uploadQueue.current = uploadQueue.current.then(() => uploadOne(upload));
  };
  const startForm = (item?: Item, draft?: MarketDraft) => {
    setForm(
      item
        ? formFrom(item)
        : {
            ...emptyMarketForm(),
            ...((draft?.form as Partial<MarketForm>) ?? {}),
          },
    );
    const source = draft?.source as
      { id?: unknown; version?: unknown } | undefined;
    originalDraft.current = draft ?? null;
    setEditing(
      item ??
        (typeof source?.id === 'string' && typeof source.version === 'number'
          ? { id: source.id, version: source.version }
          : null),
    );
    setDraftId(draft?.id ?? crypto.randomUUID());
    setSendId(typeof draft?.requestId === 'string' ? draft.requestId : null);
    setUploads([]);
    setUnavailableImages(new Set());
    setSameItem(false);
    setPreview(false);
    setFieldErrors({});
    setError('');
    setView('form');
  };
  const submit = async () => {
    const validation = marketFormErrors(form);
    setFieldErrors(validation);
    if (
      Object.keys(validation).length ||
      uploads.length ||
      hasUnavailableImage
    ) {
      setError('请先修复表单和图片错误');
      return;
    }
    setBusy(true);
    setError('');
    const requestId = sendId ?? crypto.randomUUID();
    setSendId(requestId);
    {
      const value = [
        ...drafts.filter((d) => d.id !== draftId),
        {
          id: draftId,
          form,
          requestId,
          parkId: settings?.parkId,
          source: editing,
        },
      ];
      saveDrafts(value);
      await persistQueue.current;
      if (draftFailure.current) {
        setBusy(false);
        setSendId(null);
        return;
      }
    }
    try {
      const item = await marketRequest<Item>(
        editing ? `/listings/${editing.id}` : '/listings',
        editing ? 'PUT' : 'POST',
        {
          ...form,
          requestId,
          expectedVersion: editing?.version,
          sameItemConfirmed: sameItem,
        },
      );
      saveDrafts(drafts.filter((d) => d.id !== draftId));
      setSendId(null);
      setSelected(item);
      setOwn(true);
      setView('detail');
      listCache.current.clear();
      returnView.current = 'mine';
      setNotice('发布已保存');
    } catch (e) {
      if (
        /INVALID_INPUT|FORBIDDEN|LIMIT_REACHED|NOT_FOUND|CONFLICT/.test(
          String(e),
        )
      )
        setSendId(null);
      setError(
        `${reasonText(e)}。输入已保留；如网络超时，请点击原提交按钮确认结果。`,
      );
    } finally {
      setBusy(false);
    }
  };
  const update = (key: keyof MarketForm, value: unknown) => {
    setForm((previous) => ({ ...previous, [key]: value }));
    if (!busy) setSendId(null);
  };
  const textField = (
    key: keyof MarketForm,
    label: string,
    multiline = false,
  ) => (
    <label>
      {label}
      {multiline ? (
        <textarea
          value={String(form[key])}
          onChange={(e) => update(key, e.target.value)}
          aria-invalid={!!fieldErrors[key]}
        />
      ) : (
        <input
          value={String(form[key])}
          onChange={(e) => update(key, e.target.value)}
          aria-invalid={!!fieldErrors[key]}
        />
      )}
      {fieldErrors[key] && <small role="alert">{fieldErrors[key]}</small>}
    </label>
  );
  return (
    <dialog
      ref={dialog}
      className="park-market-dialog"
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      aria-labelledby="park-market-title"
    >
      <header>
        <div>
          <h2 id="park-market-title">园区跳蚤市场</h2>
          <p>仅本园区成员可见，交易由双方线下协商</p>
        </div>
        <button type="button" onClick={requestClose} aria-label="关闭跳蚤市场">
          关闭
        </button>
      </header>
      <nav aria-label="市场页面">
        {[
          ['market', '逛市场'],
          ['mine', '我的发布记录'],
          ['favorites', '我的收藏'],
        ].map(([key, label]) => (
          <button
            key={key}
            type="button"
            aria-current={view === key ? 'page' : undefined}
            onClick={() => navigate(key as typeof view)}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          disabled={!settings?.enabled || !settings.ready || view === 'form'}
          onClick={() => startForm()}
        >
          发布闲置
        </button>
        {settings?.canModerate && (
          <button type="button" onClick={() => navigate('admin')}>
            市场管理
          </button>
        )}
      </nav>
      {error && (
        <p className="park-market-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {settings && (!settings.enabled || !settings.ready) && (
        <p role="status">
          {settings.ready ? '园区市场已暂停。' : '市场服务尚未就绪。'}
          本人发布记录仍可管理。
        </p>
      )}
      {view === 'market' && (
        <form
          className="park-market-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (appliedQuery === query.trim()) void load();
            else setAppliedQuery(query.trim());
          }}
        >
          <input
            aria-label="搜索商品"
            placeholder="搜索标题与说明（最多 50 字）"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (!e.target.value) setAppliedQuery('');
            }}
          />
          <select
            aria-label="商品分类"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="">全部分类</option>
            {['electronics', 'office', 'home', 'sports', 'books', 'other'].map(
              (key) => (
                <option key={key} value={key}>
                  {labels[key]}
                </option>
              ),
            )}
          </select>
          <label>
            <input
              type="checkbox"
              checked={free}
              onChange={(e) => {
                setFree(e.target.checked);
                setMin('');
                setMax('');
              }}
            />
            免费送
          </label>
          <label>
            <input
              type="checkbox"
              checked={unreserved}
              onChange={(e) => setUnreserved(e.target.checked)}
            />
            只看未预留
          </label>
          <input
            aria-label="最低价"
            inputMode="decimal"
            placeholder="最低价"
            disabled={free}
            value={min}
            onChange={(e) => setMin(e.target.value)}
          />
          <input
            aria-label="最高价"
            inputMode="decimal"
            placeholder="最高价"
            disabled={free}
            value={max}
            onChange={(e) => setMax(e.target.value)}
          />
          <select
            aria-label="排序"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="latest">最新发布</option>
            <option value="price-asc">价格从低到高</option>
            <option value="price-desc">价格从高到低</option>
          </select>
          <button disabled={busy}>搜索</button>
        </form>
      )}
      {['market', 'mine', 'favorites'].includes(view) && (
        <>
          {view === 'mine' && (
            <nav aria-label="本人记录状态">
              {[
                'all',
                'active',
                'reserved',
                'offline',
                'sold',
                'removed',
                'draft',
              ].map((state) => (
                <button
                  type="button"
                  key={state}
                  aria-pressed={ownFilter === state}
                  onClick={() => setOwnFilter(state)}
                >
                  {state === 'all'
                    ? '全部'
                    : state === 'draft'
                      ? '草稿'
                      : labels[state]}
                  （
                  {state === 'all'
                    ? items.length
                    : state === 'draft'
                      ? drafts.length
                      : items.filter((item) => item.state === state).length}
                  ）
                </button>
              ))}
            </nav>
          )}
          {(view === 'mine'
            ? [
                ...new Set(
                  visibleItems.map((item) => item.parkId ?? '未知园区'),
                ),
              ]
            : ['']
          ).map((parkId) => (
            <section key={parkId}>
              {view === 'mine' && <h3>原园区：{parkId}</h3>}
              <div className="park-market-grid">
                {visibleItems
                  .filter(
                    (item) =>
                      view !== 'mine' || (item.parkId ?? '未知园区') === parkId,
                  )
                  .map((item) => (
                    <button
                      type="button"
                      className="park-market-card"
                      key={item.id}
                      onClick={() => void openItem(item, view === 'mine')}
                    >
                      {item.imageIds?.[0] && (
                        <MarketPhoto id={item.imageIds[0]} retry={false} />
                      )}
                      <strong>{item.title ?? '商品已不可用'}</strong>
                      <span>
                        {item.priceCents !== undefined ? price(item) : ''} ·{' '}
                        {labels[item.state] ?? item.state}
                      </span>
                      {view === 'mine' && <small>原园区：{item.parkId}</small>}
                    </button>
                  ))}
              </div>
            </section>
          ))}
          {!visibleItems.length &&
            !busy &&
            (view !== 'mine' || ownFilter !== 'draft') && (
              <p>
                {view === 'market'
                  ? appliedQuery || category || free || unreserved || min || max
                    ? '没有符合当前搜索与筛选条件的商品，可调整条件后重试。'
                    : '园区还没有在售闲置，可以发布第一件物品。'
                  : '当前分类暂无记录'}
              </p>
            )}
          {busy && <p role="status">正在加载商品…</p>}
          {cursor && (
            <button disabled={busy} onClick={() => void load(true)}>
              加载更多
            </button>
          )}
          {view === 'mine' &&
            (ownFilter === 'all' || ownFilter === 'draft') && (
              <section>
                <h3>本机草稿</h3>
                {drafts.map((draft) => (
                  <div key={draft.id}>
                    <small>
                      原园区：{String(draft.parkId ?? '未选择园区')}
                    </small>
                    <button onClick={() => startForm(undefined, draft)}>
                      {(draft.form as MarketForm | undefined)?.title ||
                        '未命名草稿'}
                    </button>
                    <button
                      onClick={() => {
                        if (window.confirm('删除这份本机草稿？')) {
                          saveDrafts(drafts.filter((d) => d.id !== draft.id));
                          void marketRequest(`/drafts/${draft.id}`, 'PUT', {
                            imageIds: [],
                          }).catch(() => undefined);
                        }
                      }}
                    >
                      删除草稿
                    </button>
                  </div>
                ))}
              </section>
            )}
        </>
      )}
      {view === 'form' && (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (!busy) addFiles(Array.from(e.dataTransfer.files));
          }}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length && !busy) {
              e.preventDefault();
              addFiles(files);
            }
          }}
        >
          <p>
            更换物品请另发一件。请先将手机照片传到电脑，支持选择、拖拽或粘贴图片。
          </p>
          <fieldset disabled={busy || !!sendId} className="park-market-form">
            {textField('title', '标题 *')}
            <label>
              分类 *
              <select
                aria-invalid={!!fieldErrors.category}
                value={form.category}
                onChange={(e) => update('category', e.target.value)}
              >
                <option value="">请选择分类</option>
                {[
                  'electronics',
                  'office',
                  'home',
                  'sports',
                  'books',
                  'other',
                ].map((key) => (
                  <option key={key} value={key}>
                    {labels[key]}
                  </option>
                ))}
              </select>
              {fieldErrors.category}
            </label>
            <label>
              出售方式
              <select
                value={form.saleMode}
                onChange={(e) => {
                  setForm((previous) =>
                    switchMarketSaleMode(
                      previous,
                      e.target.value as 'sale' | 'free',
                    ),
                  );
                  setSendId(null);
                }}
              >
                <option value="sale">出售</option>
                <option value="free">免费送</option>
              </select>
            </label>
            {form.saleMode === 'sale' && (
              <>
                {textField('price', '售价（元）*')}
                <label>
                  <input
                    type="checkbox"
                    checked={form.negotiable}
                    onChange={(e) => update('negotiable', e.target.checked)}
                  />
                  可议价
                </label>
              </>
            )}
            {(['condition', 'functionStatus'] as const).map((key) => (
              <label key={key}>
                {key === 'condition' ? '成色 *' : '功能状态 *'}
                <select
                  aria-invalid={!!fieldErrors[key]}
                  value={form[key]}
                  onChange={(e) => update(key, e.target.value)}
                >
                  <option value="">请选择</option>
                  {(key === 'condition'
                    ? ['unused', 'like_new', 'used', 'worn']
                    : ['working', 'faulty', 'untested']
                  ).map((value) => (
                    <option key={value} value={value}>
                      {labels[value]}
                    </option>
                  ))}
                </select>
                {fieldErrors[key]}
              </label>
            ))}
            {form.functionStatus === 'faulty' &&
              textField('faultDescription', '故障说明 *', true)}
            {textField('description', '物品说明 *', true)}
            {textField('handoverArea', '大致交接区域 *')}
            {textField('handoverTime', '方便交接时间（选填）')}
            <label>
              图片（1–9 张，每张最多 20 MB）
              <input
                type="file"
                aria-invalid={!!fieldErrors.imageIds}
                multiple
                accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
            </label>
            <div className="park-market-photos">
              {form.imageIds.map((id, i) => (
                <div
                  key={id}
                  draggable
                  onDragStart={(event) =>
                    event.dataTransfer.setData(
                      'application/x-otto-market-image',
                      id,
                    )
                  }
                  onDragOver={(event) => {
                    if (
                      event.dataTransfer.types.includes(
                        'application/x-otto-market-image',
                      )
                    )
                      event.preventDefault();
                  }}
                  onDrop={(event) => {
                    const from = event.dataTransfer.getData(
                      'application/x-otto-market-image',
                    );
                    if (from) {
                      event.preventDefault();
                      event.stopPropagation();
                      update(
                        'imageIds',
                        moveMarketImage(form.imageIds, from, id),
                      );
                    }
                  }}
                >
                  <MarketPhoto
                    id={id}
                    draftPosition={i + 1}
                    onAvailability={photoAvailability}
                  />
                  <button
                    type="button"
                    aria-label={`移除第 ${i + 1} 张图片`}
                    onClick={() =>
                      update(
                        'imageIds',
                        form.imageIds.filter((value) => value !== id),
                      )
                    }
                  >
                    移除
                  </button>
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        update('imageIds', [
                          id,
                          ...form.imageIds.filter((value) => value !== id),
                        ])
                      }
                    >
                      设为首图
                    </button>
                  )}
                  {i > 0 && (
                    <button
                      type="button"
                      onClick={() =>
                        update(
                          'imageIds',
                          moveMarketImage(
                            form.imageIds,
                            id,
                            form.imageIds[i - 1],
                          ),
                        )
                      }
                    >
                      前移第 {i + 1} 张
                    </button>
                  )}
                  {i < form.imageIds.length - 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        update(
                          'imageIds',
                          moveMarketImage(
                            form.imageIds,
                            id,
                            form.imageIds[i + 1],
                          ),
                        )
                      }
                    >
                      后移第 {i + 1} 张
                    </button>
                  )}
                </div>
              ))}
            </div>
            {fieldErrors.imageIds && <p role="alert">{fieldErrors.imageIds}</p>}
            {uploads.map((upload) => (
              <p key={upload.key}>
                {upload.file.name}：
                {upload.busy
                  ? upload.phase === 'waiting'
                    ? '等待上传…'
                    : upload.phase === 'reading'
                      ? `读取照片 ${Math.floor((100 * (upload.loaded ?? 0)) / Math.max(1, upload.total ?? 1))}%`
                      : (upload.loaded ?? 0) >= (upload.total ?? 1)
                        ? '上传 100%，正在检查图片…'
                        : `上传 ${Math.floor((100 * (upload.loaded ?? 0)) / Math.max(1, upload.total ?? 1))}%`
                  : upload.error}
                {upload.busy && (
                  <button
                    type="button"
                    aria-label={`取消上传 ${upload.file.name}`}
                    onClick={() => {
                      cancelledUploads.current.add(upload.key);
                      void window.otto
                        .enterpriseMarketUploadCancel?.(upload.key)
                        .catch(() => undefined);
                      setUploads((previous) =>
                        previous.map((p) =>
                          p.key === upload.key
                            ? {
                                ...p,
                                busy: false,
                                error: '上传已取消，可重试或移除',
                              }
                            : p,
                        ),
                      );
                    }}
                  >
                    取消上传
                  </button>
                )}
                {!upload.busy && (
                  <>
                    <button
                      type="button"
                      onClick={() => {
                        cancelledUploads.current.delete(upload.key);
                        void uploadOne(upload);
                      }}
                    >
                      重试此图
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setUploads((previous) =>
                          previous.filter((p) => p.key !== upload.key),
                        )
                      }
                    >
                      移除失败图
                    </button>
                  </>
                )}
              </p>
            ))}
            {editing && (
              <>
                <p>
                  编辑不会更换商品身份或自动通知已约定的人；改价请自行重新确认。
                </p>
                <label>
                  <input
                    type="checkbox"
                    checked={sameItem}
                    onChange={(e) => setSameItem(e.target.checked)}
                  />
                  分类改变或全部换图时，确认仍为同一件物品
                </label>
                <button type="button" onClick={() => startForm()}>
                  更换物品，另建新草稿
                </button>
              </>
            )}
            <button type="button" onClick={() => setPreview(!preview)}>
              预览
            </button>
            {preview && (
              <section>
                <h3>{form.title}</h3>
                <p>{form.saleMode === 'free' ? '免费送' : `¥${form.price}`}</p>
                <p>{form.description}</p>
                <p>{form.faultDescription}</p>
                <p>
                  {form.handoverArea} {form.handoverTime}
                </p>
              </section>
            )}
          </fieldset>
          <button
            type="submit"
            disabled={busy || uploads.length > 0 || hasUnavailableImage}
          >
            {busy
              ? '正在确认保存结果…'
              : sendId
                ? '使用原标识重试 / 确认结果'
                : editing
                  ? '保存编辑'
                  : '正式发布'}
          </button>
        </form>
      )}
      {view === 'detail' && selected && (
        <section>
          <button type="button" onClick={() => setView(returnView.current)}>
            返回列表
          </button>
          <h3>{selected.title ?? '商品已不可用'}</h3>
          {own && selected.endedAt != null && (
            <p>
              {selected.cleanedAt
                ? '详细内容已按保留期限清理；重新发布需补齐文字并上传新图片。'
                : `详细说明和图片将在 ${new Date(selected.endedAt + 180 * 86400000).toLocaleDateString('zh-CN')} 后清理，最小发布记录按平台保留策略处理。`}
            </p>
          )}
          <p>
            {labels[selected.state]}{' '}
            {selected.priceCents !== undefined && price(selected)}
          </p>
          <div className="park-market-photos">
            {selected.imageIds?.map((id, index) => (
              <button
                key={id}
                aria-label={`查看第 ${index + 1} 张照片`}
                onClick={() => setImageIndex(index)}
              >
                <MarketPhoto id={id} retry={false} />
              </button>
            ))}
          </div>
          {selected.seller && (
            <p>
              <span role="img" aria-label="卖家头像">
                ◉
              </span>{' '}
              {selected.seller.nickname} · 同园区成员
            </p>
          )}
          {selected.negotiable && <p>价格可议</p>}
          {selected.listedAt && (
            <p>上架于 {new Date(selected.listedAt).toLocaleString('zh-CN')}</p>
          )}
          {selected.confirmedAt && (
            <p>
              最近确认在售：
              {new Date(selected.confirmedAt).toLocaleString('zh-CN')}
            </p>
          )}
          <p>{selected.description}</p>
          <p>
            {labels[selected.condition]} · {labels[selected.functionStatus]}{' '}
            {selected.faultDescription}
          </p>
          <p>
            {selected.handoverArea} {selected.handoverTime}
          </p>
          {selected.expiresAt && (
            <p>
              有效至 {new Date(selected.expiresAt).toLocaleString('zh-CN')}
              （本机时区）
            </p>
          )}
          {own ? (
            <div className="park-market-actions">
              {['active', 'reserved', 'offline'].includes(selected.state) && (
                <button onClick={() => startForm(selected)}>编辑</button>
              )}
              {['active', 'reserved'].includes(selected.state) && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void command('offline')}
                  >
                    暂时下架
                  </button>
                  <p>
                    下架将结束 {selected.pendingContacts ?? 0}{' '}
                    条待处理咨询，已有聊天不受影响。
                  </p>
                  <button
                    disabled={busy}
                    onClick={() => void command('confirm-active')}
                  >
                    确认仍在售（续期 30 天）
                  </button>
                  <label>
                    预计交接时间
                    <input
                      type="datetime-local"
                      value={reserveTime}
                      onChange={(e) => setReserveTime(e.target.value)}
                    />
                  </label>
                  <label>
                    预留备注（仅本人，最多 200 字）
                    <textarea
                      value={reserveNote}
                      onChange={(e) => setReserveNote(e.target.value)}
                    />
                  </label>
                  <label>
                    <input
                      type="checkbox"
                      checked={renew}
                      onChange={(e) => setRenew(e.target.checked)}
                    />
                    交接跨越有效期时，同意从现在续期 30 天
                  </label>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void command(
                        selected.state === 'reserved'
                          ? 'reservation'
                          : 'reserve',
                        {
                          expectedAt: reserveTime
                            ? new Date(reserveTime).getTime()
                            : null,
                          note: reserveNote,
                          renew,
                        },
                      )
                    }
                  >
                    {selected.state === 'reserved'
                      ? '修改预留时间 / 备注'
                      : '设为预留'}
                  </button>
                  {selected.state === 'reserved' && (
                    <button
                      disabled={busy}
                      onClick={() => void command('cancel-reservation')}
                    >
                      取消预留
                    </button>
                  )}
                </>
              )}
              {['active', 'reserved', 'offline'].includes(selected.state) && (
                <button disabled={busy} onClick={() => void command('sold')}>
                  {selected.saleMode === 'free' ? '标记已送出' : '标记已售出'}
                </button>
              )}
              {selected.state === 'offline' && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void command('restore-offline')}
                  >
                    恢复误下架（24 小时内，原预留不恢复）
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void command('relist')}
                  >
                    正式重新上架
                  </button>
                </>
              )}
              {selected.state === 'sold' && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void command('undo-sold')}
                  >
                    撤销售出（24 小时内，原预留不恢复）
                  </button>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void command('undo-sold', { asOffline: true })
                    }
                  >
                    撤销为已下架
                  </button>
                  <button
                    onClick={() => {
                      startForm();
                      setForm({
                        ...formFrom(selected),
                        imageIds: selected.cleanedAt ? [] : selected.imageIds,
                      });
                    }}
                  >
                    再次发布到新草稿
                  </button>
                </>
              )}
              {['offline', 'sold'].includes(selected.state) && (
                <button
                  disabled={busy}
                  onClick={() => {
                    if (
                      window.confirm(
                        '该发布无法恢复；不会删除对方已有聊天。确认删除？',
                      )
                    )
                      void command('delete');
                  }}
                >
                  删除发布
                </button>
              )}
              {selected.state === 'removed' && (
                <button
                  onClick={() => {
                    if (
                      !window.confirm(
                        '从本人发布列表隐藏这条记录？治理和申诉记录仍会保留。',
                      )
                    )
                      return;
                    void marketRequest(`/listings/${selected.id}/hide`, 'POST')
                      .then(() => {
                        setSelected(null);
                        setView('mine');
                        void load();
                      })
                      .catch((e) => setError(reasonText(e)));
                  }}
                >
                  隐藏本人列表记录
                </button>
              )}
              {selected.state === 'removed' && (
                <button onClick={() => setReportMode('appeal')}>
                  提交申诉
                </button>
              )}
            </div>
          ) : (
            <div className="park-market-actions">
              <button
                type="button"
                onClick={() => {
                  if (!window.otto.enterpriseMarketLink) {
                    setError('请更新客户端后分享');
                    return;
                  }
                  void window.otto
                    .enterpriseMarketLink(selected.id)
                    .then(() => setNotice('链接已复制，仅本园区成员可查看'))
                    .catch((e) => setError(reasonText(e)));
                }}
              >
                分享
              </button>
              {selected.state === 'active' && (
                <MarketContactComposer
                  key={selected.id}
                  listingId={selected.id}
                  version={selected.version}
                />
              )}
              <button
                onClick={() =>
                  void marketRequest(`/favorites/${selected.id}`, 'PUT')
                    .then(() => {
                      listCache.current.clear();
                      setNotice('已收藏');
                    })
                    .catch((e) => setError(reasonText(e)))
                }
              >
                收藏
              </button>
              <button
                onClick={() =>
                  void marketRequest(`/favorites/${selected.id}`, 'DELETE')
                    .then(() => {
                      listCache.current.clear();
                      setNotice('已取消收藏');
                    })
                    .catch((e) => setError(reasonText(e)))
                }
              >
                取消收藏
              </button>
              <button onClick={() => setReportMode('report')}>举报</button>
            </div>
          )}
        </section>
      )}
      {imageIndex !== null && selected?.imageIds?.length && (
        <MarketImageViewer
          imageIds={selected.imageIds}
          initialIndex={imageIndex}
          onClose={() => setImageIndex(null)}
        />
      )}
      {confirmExit && (
        <section role="alertdialog" aria-label="保存草稿并退出">
          <p>保存当前输入后退出？未上传成功的文件下次需要重新选择。</p>
          <button
            onClick={() => {
              void saveCurrentDraft().then(() => {
                if (!draftFailure.current) finishExit();
              });
            }}
          >
            保存草稿并退出
          </button>
          <button onClick={() => setConfirmExit(false)}>继续编辑</button>
          <button
            onClick={() => {
              const remaining = draftsRef.current.filter(
                (d) => d.id !== draftId,
              );
              void saveDrafts(
                originalDraft.current
                  ? [...remaining, originalDraft.current]
                  : remaining,
              ).then(() => {
                if (!draftFailure.current) finishExit();
              });
            }}
          >
            放弃本次更改并退出
          </button>
        </section>
      )}
      {view === 'form' && <p role="status">{draftStatus}</p>}
      {reportMode && selected && (
        <MarketReportForm
          key={`${reportMode}:${selected.id}`}
          listingId={selected.id}
          appeal={reportMode === 'appeal'}
          onClose={() => setReportMode(null)}
          onSubmitted={() => {
            setReportMode(null);
            setNotice('已受理，可在本人记录查看处理结果');
          }}
        />
      )}
      {settings?.canAssign && settings.parkId && (
        <MarketRoles
          parkId={settings.parkId}
          onChanged={() => {
            void marketRequest<Settings>('/settings')
              .then(setSettings)
              .catch((e) => setError(reasonText(e)));
          }}
        />
      )}
      {view === 'admin' && settings?.parkId && (
        <MarketAdmin
          settings={settings}
          onError={setError}
          onSettings={setSettings}
        />
      )}
      {settings?.rules && (
        <footer>
          <details>
            <summary>发布规则与处理联系人</summary>
            <p>{settings.rules}</p>
            <p>{settings.contact}</p>
          </details>
        </footer>
      )}
    </dialog>
  );
}
function MarketAdmin({
  settings,
  onError,
  onSettings,
}: {
  settings: Settings;
  onError(message: string): void;
  onSettings(value: Settings): void;
}) {
  const mutation = useRef(new MarketMutation());
  const [records, setRecords] = useState<{
    reports: Array<Record<string, unknown>>;
    appeals: Array<Record<string, unknown>>;
    restrictions: Array<Record<string, unknown>>;
    audit: Array<Record<string, unknown>>;
  } | null>(null);
  const [form, setForm] = useState(settings);
  const refresh = useCallback(
    () =>
      marketRequest<typeof records>(`/admin/${settings.parkId}`)
        .then(setRecords)
        .catch((e) => onError(reasonText(e))),
    [settings.parkId, onError],
  );
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const decide = async (
    row: Record<string, unknown>,
    kind: 'reports' | 'appeals',
    decision: string,
  ) => {
    const reason = window.prompt('请填写处理原因（2–500 字）');
    if (!reason) return;
    try {
      await mutation.current.run(
        `/${kind}/${row.id}/${kind === 'reports' ? 'decide' : 'resolve'}`,
        'POST',
        {
          expectedVersion: row.version,
          decision,
          reason,
        },
      );
      await refresh();
    } catch (e) {
      onError(reasonText(e));
    }
  };
  return (
    <section>
      <h3>市场管理工作台</h3>
      {(['reports', 'appeals'] as const).map((kind) => (
        <section key={kind}>
          <h4>{kind === 'reports' ? '举报' : '申诉'}</h4>
          {records?.[kind].map((row) => {
            const payload = row.payload as {
              reason?: string;
              description?: string;
              evidenceIds?: string[];
              selectedMessages?: Array<{
                id: string;
                text: string;
                textSource: string;
                senderId: string;
                createdAt: number;
              }>;
              snapshot?: { title?: string };
              decisions?: Array<{
                actorId: string;
                reason: string;
                at: number;
              }>;
            };
            return (
              <article key={String(row.id)}>
                <strong>
                  {payload.snapshot?.title ?? (row.listing_id as string)}
                </strong>
                <p>
                  {payload.reason} {payload.description}
                </p>
                <div className="park-market-photos">
                  {payload.evidenceIds?.map((id) => (
                    <MarketPhoto id={id} key={id} />
                  ))}
                </div>
                {payload.selectedMessages?.map((message) => (
                  <blockquote key={message.id}>
                    <p>{message.text}</p>
                    <small>
                      举报人主动提交的消息文字 ·{' '}
                      {new Date(message.createdAt).toLocaleString()}
                    </small>
                  </blockquote>
                ))}
                {payload.decisions?.map((d, i) => (
                  <p key={i}>
                    {d.actorId} · {new Date(d.at).toLocaleString()} · {d.reason}
                  </p>
                ))}
                <p>
                  {row.state === 'processing'
                    ? '处理中'
                    : row.closed_at
                      ? '已处理'
                      : '待处理'}
                </p>
                {!row.closed_at && (
                  <>
                    {kind === 'reports' && row.state === 'pending' && (
                      <button
                        onClick={() => void decide(row, kind, 'processing')}
                      >
                        开始处理
                      </button>
                    )}
                    <button onClick={() => void decide(row, kind, 'dismiss')}>
                      结案 / 不予恢复
                    </button>
                    <button
                      onClick={() =>
                        void decide(
                          row,
                          kind,
                          kind === 'reports' ? 'remove' : 'restore',
                        )
                      }
                    >
                      {kind === 'reports' ? '移除商品' : '恢复为下架'}
                    </button>
                  </>
                )}
              </article>
            );
          })}
        </section>
      ))}
      <h4>发布限制</h4>
      <button
        onClick={() => {
          const accountId = window.prompt('被限制账号 ID');
          const reason = accountId && window.prompt('限制原因（2–500 字）');
          const end =
            reason &&
            window.prompt('结束时间（例如 2026-10-01T18:00）或输入“永久”');
          if (!accountId || !reason || !end) return;
          void mutation.current
            .run(`/restrictions/${settings.parkId}`, 'POST', {
              accountId,
              reason,
              permanent: end === '永久',
              expiresAt: end === '永久' ? undefined : new Date(end).getTime(),
            })
            .then(refresh)
            .catch((e) => onError(reasonText(e)));
        }}
      >
        设置发布限制
      </button>
      {records?.restrictions.map((row) => (
        <p key={String(row.id)}>
          {String(row.account_id)}：{String(row.reason)}{' '}
          {!row.revoked_at && (
            <button
              onClick={() => {
                const reason = window.prompt('撤销原因');
                if (reason)
                  void mutation.current
                    .run(`/restrictions/${row.id}/revoke`, 'POST', {
                      reason,
                    })
                    .then(refresh)
                    .catch((e) => onError(reasonText(e)));
              }}
            >
              撤销限制
            </button>
          )}
        </p>
      ))}
      <form
        className="park-market-form"
        onSubmit={(e) => {
          e.preventDefault();
          void mutation.current
            .run<Settings>(`/settings/${settings.parkId}`, 'PUT', {
              ...form,
              expectedVersion: settings.version,
            })
            .then((value) => {
              onSettings({ ...settings, ...value });
            })
            .catch((e) => onError(reasonText(e)));
        }}
      >
        <h4>发布规则与责任人</h4>
        <label>
          规则
          <textarea
            value={form.rules}
            onChange={(e) => setForm({ ...form, rules: e.target.value })}
          />
        </label>
        <label>
          处理联系人
          <input
            value={form.contact}
            onChange={(e) => setForm({ ...form, contact: e.target.value })}
          />
        </label>
        <label>
          责任人账号
          <input
            value={form.responsibleAccountId}
            onChange={(e) =>
              setForm({ ...form, responsibleAccountId: e.target.value })
            }
          />
        </label>
        <label>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
          />
          启用市场
        </label>
        <button>保存配置</button>
      </form>
    </section>
  );
}
