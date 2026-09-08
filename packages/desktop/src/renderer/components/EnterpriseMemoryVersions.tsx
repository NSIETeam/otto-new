/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { useState } from 'react';
import './EnterpriseMemoryVersions.css';

interface MemoryContent {
  title?: string;
  category?: string;
  content: string;
}
export interface MemoryRevision extends MemoryContent {
  id: string;
  version: number;
  changedBy?: string | null;
  changeNote?: string | null;
  createdAt?: string;
  status?: string;
  adjudication?: {
    rationale: string;
    acceptedEvidenceIds: string[];
    rejectedEvidenceIds: string[];
    adjudicatedBy?: string;
  };
}

export function MemoryContentComparison({
  before,
  after,
  beforeLabel,
  afterLabel,
}: {
  before: MemoryContent;
  after: MemoryContent;
  beforeLabel: string;
  afterLabel: string;
}): React.JSX.Element {
  const changed = [
    before.title !== after.title ? '标题' : '',
    before.category !== after.category ? '分类' : '',
    before.content !== after.content ? '正文' : '',
  ].filter(Boolean);
  return (
    <section className="otto-memory-comparison" aria-label="记忆内容对比">
      <p>
        <b>
          {changed.length
            ? `${changed.join('、')}有变化`
            : '标题、分类与正文相同'}
        </b>
        。这只是内容差异，不代表新版更准确；请结合来源和适用条件判断。
      </p>
      <div className="otto-memory-comparison__columns">
        {[
          { value: before, label: beforeLabel },
          { value: after, label: afterLabel },
        ].map(({ value, label }) => (
          <article key={label}>
            <h4>{label}</h4>
            <small>{value.category || '未分类'}</small>
            <strong>{value.title || '未命名'}</strong>
            <p>{value.content}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

export function EnterpriseMemoryVersions({
  current,
  revisions,
  canRestore,
  busy,
  onRestore,
}: {
  current: MemoryContent & {
    id: string;
    version?: number;
    department?: string | null;
    status?: string;
  };
  revisions: MemoryRevision[];
  canRestore: boolean;
  busy: boolean;
  onRestore(revision: MemoryRevision, reason: string): void;
}): React.JSX.Element {
  const available = revisions
    .filter(
      (revision) =>
        Number.isSafeInteger(revision.version) &&
        typeof revision.content === 'string',
    )
    .sort((a, b) => b.version - a.version);
  const [selectedId, setSelectedId] = useState('');
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const selected =
    available.find((revision) => revision.id === selectedId) ??
    available.find((revision) => revision.version < (current.version ?? 0)) ??
    available[0];
  const restorable =
    canRestore &&
    selected &&
    selected.version < (current.version ?? 0) &&
    current.status !== 'archived';
  if (!selected)
    return (
      <p>尚无可展示的完整版本快照。不会把缺少正文的历史事件当成可恢复版本。</p>
    );
  return (
    <section className="otto-memory-versions" aria-label="企业记忆版本对比">
      <label>
        选择历史版本
        <select
          aria-label="选择历史版本"
          value={selected.id}
          disabled={busy}
          onChange={(event) => {
            setSelectedId(event.target.value);
            setReason('');
            setConfirmed(false);
          }}
        >
          {available.map((revision) => (
            <option key={revision.id} value={revision.id}>
              v{revision.version} · {revision.changeNote || '版本记录'}
            </option>
          ))}
        </select>
      </label>
      <MemoryContentComparison
        before={selected}
        after={current}
        beforeLabel={`所选历史 v${selected.version}`}
        afterLabel={`当前 v${current.version ?? '未知'}`}
      />
      <p>
        变更记录：{selected.changeNote || '未记录原因'} ·{' '}
        {selected.changedBy || '未记录操作者'}
        {selected.createdAt
          ? ` · ${new Date(selected.createdAt).toLocaleDateString('zh-CN')}`
          : ''}
      </p>
      <small>
        学习依据数量是当前累计记录，不是每个历史版本的验证结果；暂无逐版准确率对照。
      </small>
      {selected.adjudication ? (
        <div>
          <b>本版裁决记录</b>
          <p>{selected.adjudication.rationale}</p>
          <small>
            采纳 #{selected.adjudication.acceptedEvidenceIds.join('、#')}；排除
            #{selected.adjudication.rejectedEvidenceIds.join('、#')}
          </small>
        </div>
      ) : null}
      {restorable ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (confirmed && reason.trim().length >= 12 && !busy)
              onRestore(selected, reason.trim());
          }}
        >
          <p>
            仅恢复标题、分类和正文。保留当前权限范围（
            {current.department || '全组织'}
            ），不恢复旧审核结论和有效期。恢复后生成新版本，管理员重新确认前暂停检索。
          </p>
          <label>
            恢复依据
            <textarea
              aria-label="恢复依据"
              rows={3}
              maxLength={400}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
              placeholder="请写明为什么旧内容更适合当前情况（12–400 字）"
            />
          </label>
          <label className="otto-memory-versions__confirmation">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            我已比较内容，理解恢复后需要重新确认，历史记录仍会保留。
          </label>
          <button
            type="submit"
            disabled={busy || !confirmed || reason.trim().length < 12}
          >
            {busy ? '处理中…' : '恢复为待确认版本'}
          </button>
        </form>
      ) : (
        <p>此版本仅供查阅；当前状态不支持恢复，或需要管理员权限。</p>
      )}
    </section>
  );
}
