import { CarpoolExamples } from './CarpoolExamples.js';
import type { CarpoolMeetingPoint } from 'otto-server';
import { useModuleReadCache } from '../state/ModuleReadProvider.js';
import { CarpoolConfirmation } from './CarpoolConfirmation.js';
import { CarpoolRouteComparison } from './CarpoolRouteComparison.js';
import { CarpoolPointPicker } from './CarpoolPointPicker.js';
import type { CarpoolGroupMatch } from 'otto-server';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { CarpoolRequestComposer } from './CarpoolRequestComposer.js';
import { CarpoolRequestCenter } from './CarpoolRequestCenter.js';
import React, {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  EnterpriseParkCarpoolIntent,
  EnterpriseParkCarpoolPlaceSuggestion,
  EnterpriseParkCarpoolState,
  EnterpriseParkCarpoolTravelOption,
} from '../../preload/index.js';
import { IconCar } from './icons.js';
import { DialogFrame } from './WorkspaceDialogs.js';

const EMPTY_STATE: EnterpriseParkCarpoolState = {
  capability: 'park_carpool_v1',
  mapConfigured: false,
  parkId: '',
  currentIntent: null,
  matches: [],
  generatedAt: '',
};

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}`;
}

function localInputValue(value?: string): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return `${shanghaiToday()}T18:30`;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(value));
}

const MODE_LABEL: Record<EnterpriseParkCarpoolTravelOption, string> = {
  driver: '我有车',
  rider: '搭车',
  shared_taxi: '一起叫车',
};

const COMPATIBLE_LABEL: Record<string, string> = {
  current_rides_candidate_vehicle: '你可以搭对方的车',
  candidate_rides_current_vehicle: '对方可以搭你的车',
  shared_taxi: '你们可以一起叫车',
};

function PlacePicker({
  label,
  query,
  setQuery,
  selected,
  setSelected,
  disabled,
  meetingPoints = [],
  validationError,
}: {
  validationError?: string;
  label: string;
  query: string;
  setQuery(value: string): void;
  selected: EnterpriseParkCarpoolPlaceSuggestion | null;
  setSelected(value: EnterpriseParkCarpoolPlaceSuggestion | null): void;
  disabled: boolean;
  meetingPoints?: CarpoolMeetingPoint[];
}): React.JSX.Element {
  const inputId = useId();
  const revision = useRef(0);
  useEffect(
    () => () => {
      revision.current += 1;
    },
    [],
  );
  const [expanded, setExpanded] = useState(false);
  const [composing, setComposing] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [lookupError, setLookupError] = useState('');
  const [queried, setQueried] = useState(false);
  const [retry, setRetry] = useState(0);
  const suggestions = useRef(new Map<string, { time: number; places: EnterpriseParkCarpoolPlaceSuggestion[] }>());
  const changeQuery = (value: string) => {
    revision.current += 1;
    setResults([]);
    setSearching(false);
    setLocating(false);
    setQuery(value);
    setExpanded(true);
    setHighlight(-1);
    setQueried(false);
    setLookupError('');
    setError('');
    setSelected(null);
  };
  const choosePlace = (place: EnterpriseParkCarpoolPlaceSuggestion) => {
    revision.current += 1;
    setSearching(false);
    setLocating(false);
    setResults([]);
    setExpanded(false);
    setLookupError('');
    setError('');
    setSelected(place);
    setQuery(place.label);
  };
  const [locating, setLocating] = useState(false);
  const [results, setResults] = useState<
    EnterpriseParkCarpoolPlaceSuggestion[]
  >([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const term = query.trim();
    if (disabled || composing || selected || !expanded || term.length < 2) return;
    const request = ++revision.current;
    const cached = suggestions.current.get(term);
    if (cached && Date.now() - cached.time < 30000) {
      setResults(cached.places); setQueried(true); setSearching(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setSearching(true); setLookupError('');
      void window.otto.enterpriseParkCarpoolSearchPlaces(term).then(next => {
        if (request !== revision.current) return;
        suggestions.current.set(term, { time: Date.now(), places: next });
        if (suggestions.current.size > 20) suggestions.current.delete(suggestions.current.keys().next().value!);
        setResults(next); setQueried(true); setHighlight(-1);
      }).catch(cause => {
        if (request !== revision.current) return;
        setResults([]); setLookupError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => { if (request === revision.current) setSearching(false); });
    }, 300);
    return () => { window.clearTimeout(timer); revision.current += 1; };
  }, [query, composing, selected, expanded, disabled, retry]);
  useEffect(() => {
    if (highlight >= 0 && expanded) document.getElementById(`${inputId}-option-${highlight}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [highlight, expanded, inputId]);
  const locate = async () => {
    const request = ++revision.current;
    setLocating(true);
    setError('');
    try {
      await window.otto.enterpriseParkCarpoolLocate();
      const position = await new Promise<GeolocationPosition>(
        (resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, {
            enableHighAccuracy: false,
            timeout: 12000,
            maximumAge: 0,
          }),
      );
      const place = await window.otto.enterpriseParkCarpoolReverse(
        {
          longitude: position.coords.longitude,
          latitude: position.coords.latitude,
        },
        'gps',
      );
      if (request !== revision.current) return;
      choosePlace(place);
    } catch {
      if (request === revision.current)
        setError('无法取得当前位置。你仍可搜索并选择标准地点。');
    } finally {
      if (request === revision.current) setLocating(false);
    }
  };
  return (
    <fieldset className="otto-carpool__place" disabled={disabled}>
      <legend>{label}</legend>
      {meetingPoints.length ? (
        <div className="otto-carpool__meeting-points" aria-label={`${label}公共集合点`}>
          {meetingPoints.map((point) => (
            <button
              key={point.id}
              type="button"
              onClick={() => {
                choosePlace({
                  ...point.place,
                  id: point.id,
                  label: point.name,
                  address: point.place.label,
                  district: '园区公共集合点',
                });
              }}
            >
              {point.name}
            </button>
          ))}
        </div>
      ) : null}
      <div className="otto-carpool__search" onBlur={event => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExpanded(false);
      }}>
        <label className="otto-carpool__search-label" htmlFor={inputId}>{label}搜索</label>
        <input
          id={inputId}
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={expanded && !selected && query.trim().length >= 2}
          aria-controls={`${inputId}-suggestions`}
          aria-activedescendant={highlight >= 0 && expanded && results[highlight] ? `${inputId}-option-${highlight}` : undefined}
          onFocus={() => { if (!selected) setExpanded(true); }}
          onCompositionStart={() => { setComposing(true); revision.current += 1; }}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={event => {
            if (composing || event.nativeEvent.isComposing) return;
            if (event.key === 'Escape' && expanded) { event.preventDefault(); event.stopPropagation(); setExpanded(false); }
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault(); setExpanded(true);
              setHighlight(index => results.length ? (index < 0 ? (event.key === 'ArrowDown' ? 0 : results.length - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length) : -1);
            }
            if (event.key === 'Enter') {
              event.preventDefault();
              if (expanded && highlight >= 0 && results[highlight]) choosePlace(results[highlight]!);
            }
          }}
          aria-label={`${label}搜索`}
          aria-describedby={error || validationError ? `${inputId}-error` : undefined}
          aria-invalid={Boolean(error || validationError)}
          value={query}
          placeholder="搜索小区、地标或地址"
          onChange={(event) => {
            changeQuery(event.target.value);
          }}
        />
        {expanded && !selected && query.trim().length >= 2 ? (
          <div className="otto-carpool__suggestions">
            {searching ? <span role="status">正在查找…</span> : null}
            {lookupError ? <div role="status">地点加载失败 <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button></div> : null}
            {!searching && !lookupError && queried && !results.length ? <span role="status">未找到相关地点</span> : null}
            <div id={`${inputId}-suggestions`} role="listbox" aria-label={`${label}候选地点`}>
              {results.map((place, index) => (
                <button id={`${inputId}-option-${index}`} key={place.id} type="button" role="option" tabIndex={-1}
                  aria-selected={highlight === index}
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => choosePlace(place)}>
                  <strong>{place.label}</strong>
                  <span>{[place.district, place.address].filter(Boolean).join(' · ') || '标准地点'}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div className="otto-carpool__place-tools">
      <button type="button" disabled={locating} onClick={() => void locate()}>
        {locating ? '正在定位…' : '使用当前位置'}
      </button>
      </div>
      {selected ? (
        <CarpoolPointPicker
          place={selected}
          onSelect={choosePlace}
          onClose={() => undefined}
        />
      ) : null}
      {error || validationError ? (
        <small id={`${inputId}-error`} role="alert">
          {error || validationError}
        </small>
      ) : null}
    </fieldset>
  );
}

export function ParkCarpoolDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const cache = useModuleReadCache();
  const [state, setState] = useState<EnterpriseParkCarpoolState>(() => cache.peek<EnterpriseParkCarpoolState>('carpool') ?? EMPTY_STATE);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [page, setPage] = useState<'trip' | 'personal' | 'admin'>('trip');
  const [editing, setEditing] = useState(false);
  const [adminQuery, setAdminQuery] = useState('');
  const [adminPlace, setAdminPlace] = useState<EnterpriseParkCarpoolPlaceSuggestion | null>(null);
  const [loading, setLoading] = useState(false);
  const [validationField, setValidationField] = useState('');
  const [error, setError] = useState('');
  const [originQuery, setOriginQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [origin, setOrigin] =
    useState<EnterpriseParkCarpoolPlaceSuggestion | null>(null);
  const [destination, setDestination] =
    useState<EnterpriseParkCarpoolPlaceSuggestion | null>(null);
  const [departureTime, setDepartureTime] = useState(
    `${shanghaiToday()}T18:30`,
  );
  const [flexibleMinutes, setFlexibleMinutes] = useState(30);
  const [travelOptions, setTravelOptions] = useState<
    EnterpriseParkCarpoolTravelOption[]
  >([]);
  const [confirmStop, setConfirmStop] = useState(false);
  const [filter, setFilter] = useState('all');
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const [confirmClose, setConfirmClose] = useState(false);
  const [newCount, setNewCount] = useState(0);
  const formVersionRef = useRef<number | null>(null);
  const submissionRef = useRef(false);
  const requestRef = useRef({ fingerprint: '', key: '' });
  const epochRef = useRef(0);
  const hydrate = useCallback((intent: EnterpriseParkCarpoolIntent): void => {
    setOriginQuery(intent.origin.label);
    setDestinationQuery(intent.destination.label);
    setOrigin({
      id: 'current-origin',
      ...intent.origin,
      address: '',
      district: '',
    });
    setDestination({
      id: 'current-destination',
      ...intent.destination,
      address: '',
      district: '',
    });
    setDepartureTime(localInputValue(intent.departureTime));
    setFlexibleMinutes(intent.flexibleMinutes);
    setTravelOptions(intent.travelOptions);
    formVersionRef.current = intent.version ?? null;
    setDirty(false);
  }, []);
  const load = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    const cached = cache.peek<EnterpriseParkCarpoolState>('carpool');
    if (cached && stateRef.current === EMPTY_STATE && !dirtyRef.current) {
      setState(cached);
      if (cached.currentIntent) hydrate(cached.currentIntent);
    }
    setLoading(true);
    setError('');
    try {
      const next = await cache.read('carpool', () => window.otto.enterpriseParkCarpoolGet(), 0);
      if (epoch !== epochRef.current) return;
      setState(next);
      if (!dirtyRef.current) {
        formVersionRef.current = next.currentIntent?.version ?? null;
        if (next.currentIntent) hydrate(next.currentIntent);
      }
    } catch (cause) {
      if (epoch === epochRef.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (epoch === epochRef.current) setLoading(false);
    }
  }, [cache, hydrate]);
  useEffect(() => {
    if (!open) {
      epochRef.current += 1;
      return;
    }
    void load();
    void window.otto
      .enterpriseParkCarpoolWorkflowExecute?.({ type: 'record_open' })
      .catch(() => undefined);
  }, [load, open]);
  const active = state.currentIntent?.status === 'active';
  useEffect(() => {
    if (!open || !active) return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      void window.otto
        .enterpriseParkCarpoolRefresh({ filter })
        .then((next) => {
          if (!cancelled)
            setNewCount(
              Math.max(
                0,
                (next.resultPage?.total ?? next.matches.length) -
                  (state.resultPage?.total ?? state.matches.length),
                [...next.matches, ...(next.groupMatches ?? [])].filter(
                  (match) =>
                    ![...state.matches, ...(state.groupMatches ?? [])].some(
                      (old) => old.intentId === match.intentId,
                    ),
                ).length,
              ),
            );
        })
        .catch(() => {
          /* User initiated refresh reports connectivity failures. */
        });
    }, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    open,
    active,
    state.matches,
    state.groupMatches,
    state.resultPage,
    filter,
  ]);
  const refresh = async (
    selectedFilter = filter,
    append = false,
  ): Promise<void> => {
    setLoading(true);
    setError('');
    try {
      const next = await window.otto.enterpriseParkCarpoolRefresh({
        filter: selectedFilter,
        cursor: append ? state.resultPage?.nextCursor : undefined,
      });
      setState((previous) =>
        append
          ? {
              ...next,
              matches: [...previous.matches, ...next.matches],
              groupMatches: [
                ...(previous.groupMatches ?? []),
                ...(next.groupMatches ?? []),
              ],
            }
          : next,
      );
      setNewCount(0);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  const canPublish = Boolean(
    state.mapConfigured &&
    state.availability?.canPublish !== false &&
    origin &&
    destination &&
    travelOptions.length &&
    departureTime.startsWith(shanghaiToday()),
  );
  const toggleOption = (option: EnterpriseParkCarpoolTravelOption): void => {
    setTravelOptions((current) =>
      current.includes(option)
        ? current.filter((item) => item !== option)
        : [...current, option],
    );
  };
  const publish = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (submissionRef.current) return;
    const field = !origin
      ? 'origin'
      : !destination
        ? 'destination'
        : !travelOptions.length
          ? 'options'
          : !canPublish
            ? 'departure'
            : '';
    setValidationField(field);
    if (field) {
      const selector =
        field === 'origin'
          ? '[aria-label="从哪里出发搜索"]'
          : field === 'destination'
            ? '[aria-label="要去哪里搜索"]'
            : field === 'options'
              ? 'input[type="checkbox"]'
              : 'input[type="datetime-local"]';
      event.currentTarget.querySelector<HTMLElement>(selector)?.focus();
      return;
    }
    if (!origin || !destination) return;
    submissionRef.current = true;
    setLoading(true);
    setError('');
    try {
      const payload = {
        travelDate: shanghaiToday(),
        origin: { label: origin.label, coordinate: origin.coordinate },
        destination: {
          label: destination.label,
          coordinate: destination.coordinate,
        },
        departureTime: `${departureTime}:00+08:00`,
        flexibleMinutes,
        travelOptions,
        expectedVersion: formVersionRef.current,
      };
      const fingerprint = JSON.stringify(payload);
      if (requestRef.current.fingerprint !== fingerprint)
        requestRef.current = { fingerprint, key: crypto.randomUUID() };
      const saved = await window.otto.enterpriseParkCarpoolPublish({
        ...payload,
        requestKey: requestRef.current.key,
      });
      setState((current) => ({
        ...current,
        currentIntent: saved,
        matches: [],
      }));
      formVersionRef.current = saved.version ?? null;
      setDirty(false);
      setEditing(false);
      try {
        setState(await window.otto.enterpriseParkCarpoolRefresh());
      } catch (cause) {
        setError(
          `意向已发布，但结果刷新失败：${cause instanceof Error ? cause.message : String(cause)}。请刷新结果，无需重复发布。`,
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      submissionRef.current = false;
      setLoading(false);
    }
  };
  const stop = async (): Promise<void> => {
    if (!state.currentIntent) return;
    setLoading(true);
    setError('');
    try {
      const stopped = await window.otto.enterpriseParkCarpoolStop(
        state.currentIntent.id,
      );
      setState((current) => ({
        ...current,
        currentIntent: stopped,
        matches: [],
      }));
      if (!dirty) hydrate(stopped);
      setConfirmStop(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  const confirm = async (): Promise<void> => {
    if (!state.currentIntent) return;
    setLoading(true);
    setError('');
    try {
      const saved = await window.otto.enterpriseParkCarpoolConfirm(
        state.currentIntent.id,
      );
      if (!dirty) hydrate(saved);
      setState((current) => ({ ...current, currentIntent: saved }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };
  const [requestRevision, setRequestRevision] = useState(0);
  const [stopRequest, setStopRequest] = useState(0);
  const [meetingName, setMeetingName] = useState('');
  const sortedMatches = useMemo(
    () =>
      [...state.matches, ...(state.groupMatches ?? [])]
        .sort(
          (a, b) =>
            Number(a.freshness === 'needs_confirmation') -
              Number(b.freshness === 'needs_confirmation') ||
            b.overlapPercent - a.overlapPercent ||
            a.timeDifferenceMinutes - b.timeDifferenceMinutes ||
            b.commonDistanceMeters - a.commonDistanceMeters,
        )
        .filter(
          (match) =>
            filter === 'all' ||
            match.compatibleModes.includes(
              filter as (typeof match.compatibleModes)[number],
            ),
        ),
    [state.matches, state.groupMatches, filter],
  );
  if (!open) return null;
  return (
    <DialogFrame
      title="拼车助手" size="standard"
      className="otto-carpool-dialog"
      icon={<IconCar size={22} />}
      onClose={() => {
        if (dirty) setConfirmClose(true);
        else onClose();
      }}
    >
      <nav className="otto-carpool__navigation" aria-label="拼车功能">
        {page !== 'trip' ? <button type="button" onClick={() => { setPage('trip'); setStopRequest(0); }}>返回行程</button> : null}
        <button type="button" aria-pressed={page === 'personal'} onClick={() => setPage('personal')}>我的同行</button>
        {state.parkAdmin ? <button type="button" aria-pressed={page === 'admin'} onClick={() => setPage('admin')}>园区管理</button> : null}
      </nav>
      {error ? (
        <p role="alert" className="otto-workspace-dialog__error">
          {error}
          {state === EMPTY_STATE ? <button type="button" disabled={loading} onClick={() => void load()}>重新读取拼车状态</button> : null}
        </p>
      ) : null}
      {page === 'trip' ? <>
      <section className="otto-carpool__hero">
        <strong>本次同行</strong>
        <span>
          {active
            ? state.searchStatus === 'needs_confirmation'
              ? '已暂停对外展示，请确认仍在寻找'
              : state.searchStatus === 'not_accepting'
                ? '已停止接受新匹配'
                : '正在寻找'
            : state.currentIntent?.status === 'paused'
              ? '已停止'
              : state.currentIntent?.status === 'expired'
                ? '已过期'
                : '尚未发布'}
        </span>
      </section>
      {state.availability?.reason && <p role="status">{state.availability.reason}</p>}
      {state !== EMPTY_STATE && !state.mapConfigured && !loading && !error ? (
        <p role="alert" className="otto-workspace-dialog__error">
          地图服务未配置，暂时无法搜索地点或匹配路线。
        </p>
      ) : null}
      {active && !editing && state.currentIntent ? (
        <section className="otto-carpool__trip-summary" aria-label="当前行程">
          <strong>{state.currentIntent.origin.label} → {state.currentIntent.destination.label}</strong>
          <p>{state.currentIntent.travelDate} · {timeLabel(state.currentIntent.departureTime)} · 前后 {state.currentIntent.flexibleMinutes} 分钟 · {state.currentIntent.travelOptions.map(option => MODE_LABEL[option]).join(' / ')}</p>
          <div className="otto-carpool__actions">
            <button type="button" onClick={() => setEditing(true)}>修改行程</button>
            <button type="button" onClick={() => {
              if (state.hasGroup) { setPage('personal'); setStopRequest(value => value + 1); }
              else setConfirmStop(true);
            }}>停止寻找</button>
            <button type="button" disabled={loading} onClick={() => void confirm()}>仍在寻找</button>
            <button type="button" disabled={loading} onClick={() => void refresh()}>刷新结果</button>
          </div>
        </section>
      ) : <form
        onChange={() => setDirty(true)}
        className="otto-carpool__form"
        onSubmit={(event) => void publish(event)}
      >
        <PlacePicker
          validationError={
            validationField === 'origin' && !origin
              ? '请搜索并明确选择出发地点。'
              : undefined
          }
          meetingPoints={state.meetingPoints}
          label="从哪里出发"
          query={originQuery}
          setQuery={setOriginQuery}
          selected={origin}
          setSelected={setOrigin}
          disabled={!state.mapConfigured}
        />
        <PlacePicker
          validationError={
            validationField === 'destination' && !destination
              ? '请搜索并明确选择目的地点。'
              : undefined
          }
          meetingPoints={state.meetingPoints}
          label="要去哪里"
          query={destinationQuery}
          setQuery={setDestinationQuery}
          selected={destination}
          setSelected={setDestination}
          disabled={!state.mapConfigured}
        />
        <div className="otto-carpool__row">
          <label>
            <span>计划出发时间</span>
            <input
              required
              aria-invalid={validationField === 'departure'}
              disabled={loading}
              type="datetime-local"
              min={`${shanghaiToday()}T00:00`}
              max={`${shanghaiToday()}T23:59`}
              value={departureTime}
              onChange={(event) => setDepartureTime(event.target.value)}
            />
          </label>
          <label>
            <span>可接受前后</span>
            <select
              disabled={loading}
              value={flexibleMinutes}
              onChange={(event) =>
                setFlexibleMinutes(Number(event.target.value))
              }
            >
              <option value={10}>10 分钟</option>
              <option value={20}>20 分钟</option>
              <option value={30}>30 分钟</option>
              <option value={45}>45 分钟</option>
              <option value={60}>60 分钟</option>
            </select>
          </label>
        </div>
        <fieldset
          aria-describedby={
            validationField === 'options' ? 'carpool-options-error' : undefined
          }
          disabled={loading}
          className="otto-carpool__modes"
        >
          <legend>你愿意怎么同行（可多选）</legend>
          {validationField === 'options' && !travelOptions.length ? (
            <p id="carpool-options-error" role="alert">
              请至少选择一种同行方式。
            </p>
          ) : null}
          <div>
            {(['driver', 'rider', 'shared_taxi'] as const).map((option) => (
              <label key={option}>
                <input
                  type="checkbox"
                  checked={travelOptions.includes(option)}
                  onChange={() => toggleOption(option)}
                />
                <strong>{MODE_LABEL[option]}</strong>
                <span>
                  {option === 'driver'
                    ? '顺路带人'
                    : option === 'rider'
                      ? '搭乘伙伴的车'
                      : '自行协商叫车'}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="otto-carpool__actions">
          <button type="submit" className="otto-park-demo__primary" disabled={!state.mapConfigured || state.availability?.canPublish === false || loading}>
            {loading
              ? '正在处理…'
              : active
                ? '更新并重新匹配'
                : '发布并查找同路伙伴'}
          </button>
          {active ? (
            <button
              type="button"
              className="is-secondary"
              onClick={() => {
                if (state.hasGroup) { setPage('personal'); setStopRequest((value) => value + 1); }
                else setConfirmStop(true);
              }}
            >
              停止寻找
            </button>
          ) : null}
          {active ? (
            <button
              type="button"
              disabled={loading}
              onClick={() => void confirm()}
            >
              仍在寻找
            </button>
          ) : null}
          {active ? <button
            type="button"
            className="is-secondary"
            disabled={loading}
            onClick={() => void refresh()}
          >
            刷新结果
          </button> : null}
        </div>
      </form>}
      </> : null}
      {state.parkAdmin && page === 'admin' ? (
        <section aria-label="管理园区公共集合点">
          <h3>公共集合点</h3>
          <PlacePicker label="公共地点" query={adminQuery} setQuery={setAdminQuery} selected={adminPlace} setSelected={setAdminPlace} disabled={!state.mapConfigured} />
          <p>
            将所选地点设为公共集合点，地点及坐标全园区可见。请勿添加私人地点。
          </p>
          <label>
            公共集合点名称
            <input
              maxLength={60}
              value={meetingName}
              onChange={(event) => setMeetingName(event.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={!adminPlace || !meetingName.trim()}
            onClick={() => {
              if (!adminPlace) return;
              void window.otto
                .enterpriseParkCarpoolWorkflowExecute({
                  type: 'save_meeting_point',
                  name: meetingName,
                  place: adminPlace,
                })
                .then(() => {
                  setMeetingName('');
                  return refresh();
                })
                .catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : String(cause),
                  ),
                );
            }}
          >
            将所选地点添加为公共集合点
          </button>
          {state.meetingPoints?.map((point) => (
            <p key={point.id}>
              {point.name}
              <button
                type="button"
                onClick={() =>
                  void window.otto
                    .enterpriseParkCarpoolWorkflowExecute({
                      type: 'delete_meeting_point',
                      id: point.id,
                      expectedVersion: point.version,
                    })
                    .then(() => refresh())
                    .catch((cause) =>
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      ),
                    )
                }
              >
                移除集合点
              </button>
              <button
                type="button"
                disabled={!adminPlace || !meetingName.trim()}
                onClick={() => {
                  if (!adminPlace) return;
                  void window.otto
                    .enterpriseParkCarpoolWorkflowExecute({
                      type: 'save_meeting_point',
                      id: point.id,
                      expectedVersion: point.version,
                      name: meetingName,
                      place: adminPlace,
                    })
                    .then(() => refresh())
                    .catch((cause) =>
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      ),
                    );
                }}
              >
                用当前地点与名称更新
              </button>
            </p>
          ))}
        </section>
      ) : null}
      {confirmClose ? (
        <CarpoolConfirmation
          label="尚有未保存修改"
          onCancel={() => setConfirmClose(false)}
        >
          <p>当前修改尚未发布，关闭后将丢弃本次修改。</p>
          <button type="button" onClick={() => setConfirmClose(false)}>
            继续编辑
          </button>
          <button
            type="button"
            onClick={() => {
              if (state.currentIntent) hydrate(state.currentIntent);
              else {
                setOriginQuery(''); setDestinationQuery('');
                setOrigin(null); setDestination(null);
                setDepartureTime(`${shanghaiToday()}T18:30`);
                setFlexibleMinutes(30); setTravelOptions([]);
                formVersionRef.current = null;
              }
              setDirty(false);
              setConfirmClose(false);
              onClose();
            }}
          >
            放弃修改并关闭
          </button>
        </CarpoolConfirmation>
      ) : null}
      {confirmStop && state.currentIntent ? (
        <CarpoolConfirmation
          label="确认停止寻找"
          onCancel={() => setConfirmStop(false)}
        >
          <p>停止后，该意向不会再出现在新的匹配结果中。是否确认？</p>
          <div>
            <button type="button" onClick={() => void stop()}>
              确认停止
            </button>
            <button
              type="button"
              className="is-secondary"
              onClick={() => setConfirmStop(false)}
            >
              取消
            </button>
          </div>
        </CarpoolConfirmation>
      ) : null}
      {page === 'personal' || (page === 'admin' && state.parkAdmin) ? <CarpoolRequestCenter
        key={`${page}-${requestRevision}`}
        mode={page === 'admin' ? 'admin' : 'personal'}
        showCurrentIntent={page === 'personal'}
        stopRequest={page === 'personal' ? stopRequest : 0}
      /> : null}
      {page === 'trip' && active && !editing ? <section className="otto-carpool__results" aria-live="polite">
        {state.failedCandidateCount ? (
          <p role="status">
            有 {state.failedCandidateCount}{' '}
            条候选数据暂时无法处理，其余结果已显示。可稍后刷新重试。
          </p>
        ) : null}
        {newCount > 0 ? (
          <button type="button" onClick={() => void refresh()}>
            发现 {newCount} 个新同行结果，点击刷新
          </button>
        ) : null}
        <label>
          筛选同行方式
          <select
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
              void refresh(event.target.value);
            }}
          >
            <option value="all">全部</option>
            <option value="current_rides_candidate_vehicle">可搭车</option>
            <option value="candidate_rides_current_vehicle">可带人</option>
            <option value="shared_taxi">一起叫车</option>
          </select>
        </label>
        <header>
          <div>
            <h3>同行结果</h3>
            <p>
              {active
                ? `找到 ${state.resultPage?.total ?? sortedMatches.length} 个候选，已显示 ${sortedMatches.length} 个`
                : '发布同行意向后显示结果'}
            </p>
          </div>
          {state.currentIntent ? (
            <span>
              {state.currentIntent.travelDate}{' '}
              {timeLabel(state.currentIntent.departureTime)} ·{' '}
              {state.currentIntent.origin.label} →{' '}
              {state.currentIntent.destination.label}
            </span>
          ) : null}
        </header>
        {sortedMatches.map((match) => (
          <article key={match.intentId}>
            <div className="otto-carpool__score">
              <strong>约 {match.overlapPercent}% 同路</strong>
              <span>
                {match.freshness === 'just_updated'
                  ? '刚刚更新'
                  : match.freshness === 'departing_soon'
                    ? '即将出发'
                    : match.freshness === 'needs_confirmation'
                      ? '等待确认仍在寻找'
                      : match.confirmedAgoMinutes !== undefined
                        ? `${match.confirmedAgoMinutes} 分钟前仍在寻找`
                        : '仍在寻找'}
              </span>
            </div>
            <h4>
              {match.displayName} · {match.organizationName}
            </h4>
            <p>
              {isGroupMatch(match) && !match.inviteToMyGroup
                ? match.memberCount
                : 1}{' '}
              人 · 园区身份已认证 · {timeLabel(match.departureTime)} 出发 · 相差{' '}
              {match.timeDifferenceMinutes} 分钟
            </p>
            {match.sharedDepartureStart && match.sharedDepartureEnd ? (
              <p>
                可共同出发：{timeLabel(match.sharedDepartureStart)}—
                {timeLabel(match.sharedDepartureEnd)}
              </p>
            ) : null}
            <p>
              {isGroupMatch(match)
                ? `${match.travelMode === 'private_vehicle' ? '私家车 · 司机' : '一起叫车 · 协调人'}：${match.driverName ?? match.coordinatorName} · 剩余 ${match.remainingPlaces} 个乘客名额`
                : ''}
            </p>
            <p>
              {match.compatibleModes
                .map((mode) => COMPATIBLE_LABEL[mode] ?? mode)
                .join('；')}
            </p>
            <details>
              <summary>为什么匹配</summary>
              <p>{match.explanation}</p>
              {isGroupMatch(match) ? (
                <>
                  <p>
                    剩余名额 {match.remainingPlaces} · 平均重合{' '}
                    {match.averageOverlapPercent}% · 最低成员{' '}
                    {match.lowestOverlapPercent}% · 最大预计增加{' '}
                    {Math.ceil(match.maximumDetourSeconds / 60)} 分钟
                  </p>
                  <ul>
                    {match.memberOverlaps.map((member, index) => (
                      <li key={index}>
                        {member.displayName}
                        {member.driver ? '（司机）' : ''}：与你约{' '}
                        {member.overlapPercent}% 同路
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              <p>
                路线区域：{match.originArea} → {match.destinationArea}
              </p>
            </details>
            <CarpoolRouteComparison
              intentId={match.intentId}
              groupId={isGroupMatch(match) ? match.groupId : undefined}
            />
            <CarpoolRequestComposer
              capabilities={state.capabilities}
              match={match}
              onSent={() => {
                setState(current => ({...current,
                  matches: current.matches.map(candidate => candidate.intentId === match.intentId ? {...candidate, pendingRequest: 'sent' as const} : candidate),
                  groupMatches: current.groupMatches?.map(candidate => isGroupMatch(match) && candidate.groupId === match.groupId && candidate.intentId === match.intentId ? {...candidate, pendingRequest: 'sent' as const} : candidate),
                }));
                setRequestRevision((value) => value + 1);
              }}
            />
          </article>
        ))}
        {state.resultPage?.nextCursor ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void refresh(filter, true)}
          >
            加载更多同行结果
          </button>
        ) : null}
        {active && !loading && !sortedMatches.length ? (
          <>
            <p className="otto-carpool__empty">暂时没有合适的同行伙伴</p>
            <CarpoolExamples />
          </>
        ) : null}
        {sortedMatches.length > 0 ? <details><summary>体验同行示例</summary><CarpoolExamples /></details> : null}
      </section> : null}
    </DialogFrame>
  );
}

function isGroupMatch(match: { intentId: string }): match is CarpoolGroupMatch {
  return 'groupId' in match;
}
