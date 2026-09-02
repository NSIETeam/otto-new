/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  EnterpriseParkCarpoolPlaceSuggestion,
  EnterpriseParkCarpoolState,
  EnterpriseParkCarpoolTravelOption,
} from '../../preload/index.js';
import { DialogFrame } from './WorkspaceDialogs.js';

const EMPTY_STATE: EnterpriseParkCarpoolState = {
  capability: 'park_carpool_v1', mapConfigured: false, parkId: '',
  currentIntent: null, matches: [], generatedAt: '',
};

function shanghaiToday(): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function localInputValue(value?: string): string {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return `${shanghaiToday()}T18:30`;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
}

function timeLabel(value: string): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date(value));
}

const MODE_LABEL: Record<EnterpriseParkCarpoolTravelOption, string> = {
  driver: '我有车', rider: '搭车', shared_taxi: '一起叫车',
};

const COMPATIBLE_LABEL: Record<string, string> = {
  current_rides_candidate_vehicle: '你可以搭对方的车',
  candidate_rides_current_vehicle: '对方可以搭你的车',
  shared_taxi: '你们可以一起叫车',
};

function PlacePicker({
  label, hint, query, setQuery, selected, setSelected, disabled,
}: {
  label: string;
  hint: string;
  query: string;
  setQuery(value: string): void;
  selected: EnterpriseParkCarpoolPlaceSuggestion | null;
  setSelected(value: EnterpriseParkCarpoolPlaceSuggestion | null): void;
  disabled: boolean;
}): React.JSX.Element {
  const [results, setResults] = useState<EnterpriseParkCarpoolPlaceSuggestion[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const search = async (): Promise<void> => {
    setSearching(true); setError(''); setSelected(null);
    try {
      const next = await window.otto.enterpriseParkCarpoolSearchPlaces(query, '北京');
      setResults(next);
      if (!next.length) setError('没有找到标准地点，请换一个更明确的地标或地址。');
    } catch (cause) {
      setResults([]);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setSearching(false); }
  };
  return <fieldset className="otto-carpool__place" disabled={disabled}>
    <legend>{label}</legend>
    <p>{hint}</p>
    <div><input value={query} placeholder="搜索小区、地标或地址" onChange={(event) => { setQuery(event.target.value); setSelected(null); }} /><button type="button" disabled={searching || query.trim().length < 2} onClick={() => void search()}>{searching ? '搜索中…' : '搜索'}</button></div>
    {error ? <small role="alert">{error}</small> : null}
    {results.length ? <div className="otto-carpool__places" role="listbox" aria-label={`${label}候选地点`}>
      {results.map((place) => <button key={place.id} type="button" role="option" aria-selected={selected?.id === place.id} className={selected?.id === place.id ? 'is-selected' : ''} onClick={() => { setSelected(place); setQuery(place.label); }}><strong>{place.label}</strong><span>{[place.district, place.address].filter(Boolean).join(' · ') || '标准地点'}</span></button>)}
    </div> : null}
  </fieldset>;
}

export function ParkCarpoolDialog({
  open, onClose,
}: {
  open: boolean;
  onClose(): void;
}): React.JSX.Element | null {
  const [state, setState] = useState<EnterpriseParkCarpoolState>(EMPTY_STATE);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [originQuery, setOriginQuery] = useState('');
  const [destinationQuery, setDestinationQuery] = useState('');
  const [origin, setOrigin] = useState<EnterpriseParkCarpoolPlaceSuggestion | null>(null);
  const [destination, setDestination] = useState<EnterpriseParkCarpoolPlaceSuggestion | null>(null);
  const [departureTime, setDepartureTime] = useState(`${shanghaiToday()}T18:30`);
  const [flexibleMinutes, setFlexibleMinutes] = useState(30);
  const [travelOptions, setTravelOptions] = useState<EnterpriseParkCarpoolTravelOption[]>([]);
  const [confirmStop, setConfirmStop] = useState(false);
  const epochRef = useRef(0);
  const load = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    setLoading(true); setError('');
    try {
      const next = await window.otto.enterpriseParkCarpoolGet();
      if (epoch !== epochRef.current) return;
      setState(next);
      if (next.currentIntent) {
        setOriginQuery(next.currentIntent.origin.label);
        setDestinationQuery(next.currentIntent.destination.label);
        setOrigin({ id: 'current-origin', ...next.currentIntent.origin, address: '', district: '' });
        setDestination({ id: 'current-destination', ...next.currentIntent.destination, address: '', district: '' });
        setDepartureTime(localInputValue(next.currentIntent.departureTime));
        setFlexibleMinutes(next.currentIntent.flexibleMinutes);
        setTravelOptions(next.currentIntent.travelOptions);
      }
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (!open) { epochRef.current += 1; return; }
    void load();
  }, [load, open]);
  const active = state.currentIntent?.status === 'active';
  const canPublish = Boolean(
    state.mapConfigured && origin && destination && travelOptions.length
    && departureTime.startsWith(shanghaiToday()),
  );
  const toggleOption = (option: EnterpriseParkCarpoolTravelOption): void => {
    setTravelOptions((current) => current.includes(option)
      ? current.filter((item) => item !== option)
      : [...current, option]);
  };
  const publish = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!origin || !destination || !canPublish) return;
    setLoading(true); setError('');
    try {
      await window.otto.enterpriseParkCarpoolPublish({
        travelDate: shanghaiToday(),
        origin: { label: origin.label, coordinate: origin.coordinate },
        destination: { label: destination.label, coordinate: destination.coordinate },
        departureTime: `${departureTime}:00+08:00`,
        flexibleMinutes,
        travelOptions,
      });
      setState(await window.otto.enterpriseParkCarpoolRefresh());
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const stop = async (): Promise<void> => {
    if (!state.currentIntent) return;
    setLoading(true); setError('');
    try {
      await window.otto.enterpriseParkCarpoolStop(state.currentIntent.id);
      setState(await window.otto.enterpriseParkCarpoolGet());
      setConfirmStop(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setLoading(false); }
  };
  const sortedMatches = useMemo(() => [...state.matches].sort((a, b) => b.overlapPercent - a.overlapPercent), [state.matches]);
  if (!open) return null;
  return <DialogFrame title="拼车助手" onClose={onClose}>
    <section className="otto-carpool__hero">
      <div><strong>找到与你方向相近的园区伙伴</strong><p>Otto 只提供信息发布、路线匹配和连接提示，不叫车、不收费，也不处理费用分摊。</p></div>
      <span>{active ? '正在寻找' : '尚未发布'}</span>
    </section>
    <p className="otto-carpool__chat-hint">也可以直接在对话框说：“今天 18:30 从宏创园区南门到回龙观，想搭车，前后 30 分钟都可以”。Otto 会补问缺失信息并在发布前确认。</p>
    {!state.mapConfigured && !loading ? <p role="alert" className="otto-workspace-dialog__error">服务器尚未配置高德 Web 服务密钥，地点搜索与路线匹配暂不可用；系统不会生成虚构路线或百分比。</p> : null}
    {error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}
    <form className="otto-carpool__form" onSubmit={(event) => void publish(event)}>
      <PlacePicker label="从哪里出发" hint="优先选择园区出口或公共集合点，不建议填写办公室或地下车库。" query={originQuery} setQuery={setOriginQuery} selected={origin} setSelected={setOrigin} disabled={loading || !state.mapConfigured} />
      <PlacePicker label="要去哪里" hint="请选择标准地点；候选阶段不会展示精确坐标或住宅门牌。" query={destinationQuery} setQuery={setDestinationQuery} selected={destination} setSelected={setDestination} disabled={loading || !state.mapConfigured} />
      <div className="otto-carpool__row"><label><span>计划出发时间</span><input type="datetime-local" min={`${shanghaiToday()}T00:00`} max={`${shanghaiToday()}T23:59`} value={departureTime} onChange={(event) => setDepartureTime(event.target.value)} /></label><label><span>可接受前后</span><select value={flexibleMinutes} onChange={(event) => setFlexibleMinutes(Number(event.target.value))}><option value={10}>10 分钟</option><option value={20}>20 分钟</option><option value={30}>30 分钟</option><option value={45}>45 分钟</option><option value={60}>60 分钟</option></select></label></div>
      <fieldset className="otto-carpool__modes"><legend>你愿意怎么同行（可多选）</legend><div>{(['driver', 'rider', 'shared_taxi'] as const).map((option) => <label key={option}><input type="checkbox" checked={travelOptions.includes(option)} onChange={() => toggleOption(option)} /><strong>{MODE_LABEL[option]}</strong><span>{option === 'driver' ? '可以由我开车并顺路带人' : option === 'rider' ? '搭乘同行伙伴的车' : '匹配后自行协商第三方叫车'}</span></label>)}</div><p>多选表示本次这几种方式都可以。“一起叫车”不会由 Otto 下单或计费。</p></fieldset>
      <p className="otto-carpool__privacy">提交后，你的通勤意向将对同园区且路线、时间符合条件的用户可见。你可以随时修改或停止寻找。</p>
      <div className="otto-carpool__actions"><button type="submit" disabled={!canPublish || loading}>{loading ? '正在规划路线…' : active ? '更新并重新匹配' : '发布并查找同路伙伴'}</button>{active ? <button type="button" className="is-secondary" onClick={() => setConfirmStop(true)}>停止寻找</button> : null}<button type="button" className="is-secondary" disabled={!active || loading} onClick={() => void load()}>刷新结果</button></div>
    </form>
    {confirmStop && state.currentIntent ? <section className="otto-carpool__confirm" role="alertdialog" aria-label="确认停止寻找"><p>停止后，该意向不会再出现在新的匹配结果中。是否确认？</p><div><button type="button" onClick={() => void stop()}>确认停止</button><button type="button" className="is-secondary" onClick={() => setConfirmStop(false)}>取消</button></div></section> : null}
    <section className="otto-carpool__results" aria-live="polite">
      <header><div><h3>同行结果</h3><p>{active ? `找到 ${sortedMatches.length} 个候选，按路线重合度排序` : '发布同行意向后显示结果'}</p></div>{state.currentIntent ? <span>今天 {timeLabel(state.currentIntent.departureTime)} · {state.currentIntent.origin.label} → {state.currentIntent.destination.label}</span> : null}</header>
      {sortedMatches.map((match) => <article key={match.intentId}><div className="otto-carpool__score"><strong>约 {match.overlapPercent}% 同路</strong><span>{match.freshness === 'just_updated' ? '刚刚更新' : match.freshness === 'departing_soon' ? '即将出发' : '仍在寻找'}</span></div><h4>{match.displayName} · {match.organizationName}</h4><p>园区身份已认证 · {timeLabel(match.departureTime)} 出发 · 相差 {match.timeDifferenceMinutes} 分钟</p><p>{match.compatibleModes.map((mode) => COMPATIBLE_LABEL[mode] ?? mode).join('；')}</p><details><summary>为什么匹配</summary><p>{match.explanation}</p><p>路线区域：{match.originArea} → {match.destinationArea}</p></details><footer>阶段一仅展示脱敏匹配结果；陌生人消息请求将在独立沟通能力完成后开放。</footer></article>)}
      {active && !loading && !sortedMatches.length ? <div className="otto-carpool__empty"><strong>暂时没有合适的同行伙伴</strong><p>你的意向已经发布。稍后可刷新结果或修改时间范围。</p></div> : null}
    </section>
  </DialogFrame>;
}
