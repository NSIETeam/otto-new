/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React from 'react';
import type { RecruitmentGatewaySearchResult, RecruitmentSourceRuntimeView } from '../../preload/index.js';

export function RecruitmentSourceResults({ result, sources, busy, onImport, onClose }: {
  result: RecruitmentGatewaySearchResult;
  sources: readonly RecruitmentSourceRuntimeView[];
  busy: boolean;
  onImport(canonicalId: string, sourceId: string): void;
  onClose(): void;
}): React.JSX.Element {
  return <section className="otto-recruitment-source-results" aria-label="自动寻才结果">
    <header><div><strong>本次找到 {result.candidates.length} 位候选人</strong>
      <span>以下是来源摘要，获取完整材料后才能进行全文分析。</span></div>
      <button type="button" disabled={busy} onClick={onClose}>收起结果</button></header>
    <p>服务器临时检索结果保留 24 小时，到期需重新检索。已正式入档的候选人资料不受影响。</p>
    {result.sources.filter((source) => source.message).map((source) => <p role="status" key={source.sourceId}>{source.label}：{source.message}</p>)}
    {result.sources.some((source) => source.status !== 'ok') ? <p role="status">部分来源检索未完成：{result.sources.filter((source) => source.status !== 'ok').map((source) => source.label).join('、')}。当前列表不代表所有来源的完整结果。</p> : null}
    {result.sources.some((source) => source.nextCursor) ? <p>来源还有后续结果，本次仅显示已获取的一批候选人。</p> : null}
    <div>{result.candidates.map((candidate, index) => <article key={candidate.canonicalId}>
      <div><strong><span>{index + 1}. </span><span>{candidate.displayName}</span></strong><span>{candidate.headline ?? '岗位信息待补充'}</span>
        <small>{candidate.location ?? '地点待补充'} · {candidate.sources.map((source) => source.sourceLabel).join('、')} · 仅来源摘要</small></div>
      <div>{candidate.sources.map((source) => <button key={`${source.sourceId}:${source.sourceRecordId}`} type="button"
        disabled={busy || !sources.find((entry) => entry.id === source.sourceId)?.materialReadable}
        onClick={() => onImport(candidate.canonicalId, source.sourceId)}>
        {candidate.sources.length > 1 ? `从${source.sourceLabel}获取材料并分析` : '获取材料并分析'}
      </button>)}
        {candidate.sources.find((source) => source.profileUrl?.startsWith('https://'))?.profileUrl ? <button type="button" onClick={() => void window.otto.openExternal(candidate.sources.find((source) => source.profileUrl?.startsWith('https://'))!.profileUrl!)}>查看来源</button> : null}
        {!candidate.sources.some((source) => sources.find((entry) => entry.id === source.sourceId)?.materialReadable) ? <small>连接器尚未开放材料读取，可手动导入完整简历。</small> : null}
      </div>
    </article>)}</div>
    {result.candidates.length === 0 ? <p>已授权来源未返回候选人。可以调整岗位描述后再次检索，或继续手动导入材料。</p> : <p>也可以在对话中说“分析找到的第 1 位候选人”。分析前请确认材料授权。</p>}
  </section>;
}
