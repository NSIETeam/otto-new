/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutoSkillCandidateInfo } from 'otto-server';
import type { CentralEnterpriseRole } from '../state/centralEnterpriseIdentity.js';
import { customAgentIconToModuleIcon, type CustomAgentIcon } from '../customAgentIcons.js';
import type { CustomAgentDefinition, CustomAgentDraft } from '../customAgents.js';
import { CustomAgentIconPicker } from './CustomAgentIconPicker.js';
import { ModuleIcon } from './ModuleIcon.js';

function DialogFrame({ title, onClose, children }: {
  title: string; onClose(): void; children: React.ReactNode;
}): React.JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !ref.current) return;
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'));
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    ref.current?.querySelector<HTMLElement>('button')?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus.current && document.contains(previousFocus.current)) previousFocus.current.focus();
    };
  }, []);
  return createPortal(
    <div className="otto-workspace-dialog-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section ref={ref} className="otto-workspace-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header><h2>{title}</h2><button type="button" aria-label={`关闭${title}`} onClick={onClose}>×</button></header>
        <div className="otto-workspace-dialog__body">{children}</div>
      </section>
    </div>, document.body,
  );
}

interface KnowledgeItem {
  id: string; title?: string; department?: string | null; category: string; content: string;
  status?: 'pending_review' | 'active' | 'archived'; confidence: number;
  version?: number; contributor?: string | null; createdAt: string; updatedAt?: string;
  sourceId?: string | null; sourceType?: string; sourceLabel?: string | null;
  evidenceCount?: number; distinctSessionCount?: number; distinctContributorCount?: number;
  verifiedEvidenceCount?: number; lastObservedAt?: string | null; reviewedAt?: string | null;
  reviewDueAt?: string | null; expiresAt?: string | null;
}

interface KnowledgeAdjudication {
  id?: string; acceptedEvidenceIds: string[]; rejectedEvidenceIds: string[];
  rationale: string; adjudicatedBy?: string;
}

interface KnowledgeRevision {
  id: string; version: number; title?: string; category?: string; content: string;
  changedBy?: string | null; changeNote?: string | null; status?: string; createdAt?: string;
  adjudication?: KnowledgeAdjudication;
}

interface KnowledgeEvidence {
  id: string; knowledgeId: string; sourceId: string; content: string; tags: string[];
  contributor: string | null; confidence: number; verified: boolean; impactScore: number;
  impactReasons: string[]; observedAt: string; stance: 'affirmative' | 'negative' | 'neutral';
  contested: boolean;
}

interface KnowledgeCandidate {
  date: string;
  entry: {
    time: string; category: string; action: string; success: boolean; details?: string;
    entryType: 'tool' | 'work_result'; taskTitle?: string;
  };
}

function formatKnowledgeDate(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('zh-CN');
}

export function EnterpriseMemoryDialog({ open, role, onClose }: {
  open: boolean; role?: CentralEnterpriseRole; onClose(): void;
}): React.JSX.Element | null {
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'knowledge' | 'timeline'>('knowledge');
  const [candidates, setCandidates] = useState<KnowledgeCandidate[]>([]);
  const [busyId, setBusyId] = useState('');
  const [editor, setEditor] = useState<{
    id?: string; title: string; category: string; content: string;
    resolveConflict?: boolean; adjudication?: Omit<KnowledgeAdjudication, 'id' | 'adjudicatedBy'>;
  } | null>(null);
  const [revalidation, setRevalidation] = useState<{
    id: string; title: string; rationale: string; validForDays: number;
  } | null>(null);
  const [revisions, setRevisions] = useState<Record<string, KnowledgeRevision[]>>({});
  const [evidence, setEvidence] = useState<Record<string, KnowledgeEvidence[]>>({});
  const [adjudications, setAdjudications] = useState<Record<string, Omit<KnowledgeAdjudication, 'id' | 'adjudicatedBy'>>>({});
  const epochRef = useRef(0);
  const queryRef = useRef('');
  queryRef.current = query;
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    setLoading(true); setError('');
    try {
      const [next, recentWork] = await Promise.all([
        window.otto.enterpriseKnowledgeList({ query: queryRef.current.trim() || undefined, includeReview: true }),
        window.otto.workLogRecent(7).catch(() => []),
      ]);
      if (epoch === epochRef.current) {
        setItems(next);
        setCandidates(recentWork
          .flatMap((day) => day.entries.map((entry) => ({ date: day.date, entry })))
          .filter(({ entry }) => entry.entryType === 'work_result' && entry.success)
          .slice(0, 3));
      }
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setLoading(false); }
  }, []);
  useEffect(() => {
    if (open) void refresh();
    else {
      epochRef.current += 1;
      queryRef.current = '';
      setQuery(''); setItems([]); setLoading(false);
      setEditor(null); setRevalidation(null); setRevisions({}); setEvidence({});
      setAdjudications({}); setError(''); setNotice('');
      setView('knowledge'); setCandidates([]); setBusyId('');
    }
  }, [open, refresh]);
  const requestClose = (): void => {
    if (((editor && (editor.title.trim() || editor.content.trim()))
      || (revalidation && revalidation.rationale.trim())
      || Object.values(adjudications).some((draft) => draft.rationale.trim()
        || draft.acceptedEvidenceIds.length || draft.rejectedEvidenceIds.length))
      && !window.confirm('当前企业知识草稿尚未保存，确定关闭吗？')) return;
    onClose();
  };
  const save = async (): Promise<void> => {
    if (!editor || !editor.title.trim() || !editor.category.trim() || !editor.content.trim()) { setError('请完整填写标题、分类和知识内容。'); return; }
    const epoch = epochRef.current;
    const operationId = editor.id || 'new-knowledge';
    setBusyId(operationId);
    try {
      if (editor.id) await window.otto.enterpriseKnowledgeRevise(editor.id, {
        title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(), confidence: 0.95,
        changeNote: editor.resolveConflict ? '管理员核对证据并裁决冲突' : '管理员在企业记忆弹窗中修订',
        resolveConflict: editor.resolveConflict,
        adjudication: editor.resolveConflict ? editor.adjudication : undefined,
      });
      else await window.otto.enterpriseKnowledgeRecord({ sourceId: `manual:${crypto.randomUUID()}`, title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(), confidence: 0.95, sourceType: 'manual', sourceLabel: '企业管理员手动录入' });
      if (epoch !== epochRef.current) return;
      if (editor.id) {
        setRevisions((current) => { const next = { ...current }; delete next[editor.id!]; return next; });
        setEvidence((current) => { const next = { ...current }; delete next[editor.id!]; return next; });
        setAdjudications((current) => { const next = { ...current }; delete next[editor.id!]; return next; });
      }
      setEditor(null);
      setNotice(editor.resolveConflict ? '冲突已裁决并形成新版本，请再次确认后发布。' : editor.id ? '知识已修订，新版本立即用于后续检索。' : '企业知识已发布。');
      setBusyId(''); await refresh();
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const review = async (id: string, action: 'approve' | 'archive'): Promise<void> => {
    const epoch = epochRef.current;
    setBusyId(id);
    try { await window.otto.enterpriseKnowledgeReview(id, action); if (epoch !== epochRef.current) return; setNotice(action === 'approve' ? '知识已发布，可供 Otto 检索引用。' : '知识已归档。'); setRevisions((current) => { const next = { ...current }; delete next[id]; return next; }); setEvidence((current) => { const next = { ...current }; delete next[id]; return next; }); setBusyId(''); await refresh(); }
    catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const saveRevalidation = async (): Promise<void> => {
    if (!revalidation) return;
    const rationale = revalidation.rationale.trim();
    if (rationale.length < 12) { setError('复核依据至少填写 12 个字。'); return; }
    const epoch = epochRef.current;
    setBusyId(revalidation.id); setError(''); setNotice('');
    try {
      await window.otto.enterpriseKnowledgeRevalidate(revalidation.id, {
        rationale, validForDays: revalidation.validForDays,
      });
      if (epoch !== epochRef.current) return;
      setRevisions((current) => { const next = { ...current }; delete next[revalidation.id]; return next; });
      setRevalidation(null); setNotice('复核记录已留档，知识有效期已更新。'); setBusyId('');
      await refresh();
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const toggleRevisions = async (id: string): Promise<void> => {
    if (revisions[id] !== undefined) { setRevisions((current) => { const next = { ...current }; delete next[id]; return next; }); return; }
    const epoch = epochRef.current;
    setBusyId(id);
    try {
      const loaded = await window.otto.enterpriseKnowledgeRevisions(id);
      if (epoch === epochRef.current) setRevisions((current) => ({ ...current, [id]: loaded }));
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const toggleEvidence = async (id: string): Promise<void> => {
    if (evidence[id] !== undefined) { setEvidence((current) => { const next = { ...current }; delete next[id]; return next; }); return; }
    const epoch = epochRef.current;
    setBusyId(id); setError('');
    try {
      const loaded = await window.otto.enterpriseKnowledgeEvidence(id);
      if (epoch === epochRef.current) setEvidence((current) => ({ ...current, [id]: loaded }));
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const setEvidenceDisposition = (knowledgeId: string, evidenceId: string, disposition: 'accepted' | 'rejected'): void => {
    setAdjudications((current) => {
      const draft = current[knowledgeId] ?? { acceptedEvidenceIds: [], rejectedEvidenceIds: [], rationale: '' };
      const acceptedEvidenceIds = draft.acceptedEvidenceIds.filter((id) => id !== evidenceId);
      const rejectedEvidenceIds = draft.rejectedEvidenceIds.filter((id) => id !== evidenceId);
      const target = disposition === 'accepted' ? acceptedEvidenceIds : rejectedEvidenceIds;
      const selected = disposition === 'accepted' ? draft.acceptedEvidenceIds.includes(evidenceId) : draft.rejectedEvidenceIds.includes(evidenceId);
      if (!selected) target.push(evidenceId);
      return { ...current, [knowledgeId]: { acceptedEvidenceIds, rejectedEvidenceIds, rationale: draft.rationale } };
    });
  };
  const isAdjudicationReady = (id: string): boolean => {
    const contestedEvidence = (evidence[id] ?? []).filter((item) => item.contested);
    const draft = adjudications[id];
    if (!draft || contestedEvidence.length === 0 || draft.rationale.trim().length < 12) return false;
    const classified = new Set([...draft.acceptedEvidenceIds, ...draft.rejectedEvidenceIds]);
    return draft.acceptedEvidenceIds.length > 0 && draft.rejectedEvidenceIds.length > 0
      && contestedEvidence.every((item) => classified.has(item.id));
  };
  useEffect(() => {
    if (!open || view !== 'timeline' || role !== 'company_admin') return;
    const missing = items.filter((item) => item.status !== 'archived' && revisions[item.id] === undefined);
    if (!missing.length) return;
    const epoch = epochRef.current;
    void Promise.all(missing.map(async (item) => ({
      id: item.id,
      loaded: await window.otto.enterpriseKnowledgeRevisions(item.id),
    }))).then((loaded) => {
      if (epoch !== epochRef.current) return;
      setRevisions((current) => ({
        ...current,
        ...Object.fromEntries(loaded.map((entry) => [entry.id, entry.loaded])),
      }));
    }).catch((cause) => {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    });
  }, [items, open, revisions, role, view]);
  const submitCandidate = async ({ date, entry }: KnowledgeCandidate): Promise<void> => {
    const title = (entry.taskTitle || entry.action || '工作成果').trim();
    const sourceId = `work-result:${date}:${entry.time}:${title}`.slice(0, 150);
    const epoch = epochRef.current;
    setBusyId(sourceId); setError(''); setNotice('');
    try {
      const result = await window.otto.enterpriseKnowledgeRecord({
        sourceId, title, category: entry.category || 'work_result',
        content: [title, entry.details].filter(Boolean).join('\n'), confidence: 0.82,
        sourceType: 'work_result', sourceLabel: `${date} ${entry.time} Otto 工作成果`,
      });
      if (epoch !== epochRef.current) return;
      setNotice(result.reviewStatus === 'active' ? '已沉淀为企业知识。'
        : result.status === 'exists' ? '这项成果已经在审核队列中。'
          : '已提交为知识候选，管理员确认后会进入企业知识库。');
      setBusyId('');
      await refresh();
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const timeline = items.filter((item) => !item.status || item.status === 'active')
    .flatMap((item) => (revisions[item.id]?.length ? revisions[item.id] : [{
      id: `current-${item.id}`, version: item.version ?? 1, title: item.title,
      category: item.category, content: item.content, changedBy: item.contributor,
      changeNote: '当前版本', createdAt: item.updatedAt || item.createdAt,
    }]).map((revision) => ({ item, revision })))
    .sort((left, right) => (right.revision.createdAt || '').localeCompare(left.revision.createdAt || ''));
  if (!open) return null;
  return <DialogFrame title="企业记忆" onClose={requestClose}>
    <div role="tablist" aria-label="企业知识与记忆" className="otto-enterprise-memory-switch">
      <button type="button" role="tab" aria-selected={view === 'knowledge'} onClick={() => setView('knowledge')}>企业知识</button>
      <button type="button" role="tab" aria-selected={view === 'timeline'} onClick={() => setView('timeline')}>记忆沿革</button>
    </div>
    <div className="otto-workspace-dialog__toolbar">
      <form onSubmit={(event) => { event.preventDefault(); void refresh(); }}><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索企业知识" placeholder="搜索制度、流程、项目结论"/><button type="submit">搜索</button></form>
      {role === 'company_admin' ? <button type="button" onClick={() => setEditor({ title: '', category: '制度流程', content: '' })}>新增知识</button> : null}
      <button type="button" disabled={loading} onClick={() => void refresh()}>{loading ? '加载中…' : '刷新'}</button>
    </div>
    {view === 'knowledge' && editor ? <form className="otto-workspace-dialog__editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <input aria-label="知识标题" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })}/>
      <input aria-label="知识分类" value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value })}/>
      <textarea aria-label="知识内容" rows={6} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })}/>
      {editor.resolveConflict ? <small>保存后会记录本次证据取舍和裁决依据，并生成待再次确认的新版本。</small> : null}
      <div><button type="button" disabled={Boolean(busyId)} onClick={() => setEditor(null)}>取消</button><button type="submit" disabled={Boolean(busyId)}>{busyId ? '保存中…' : editor.resolveConflict ? '保存裁决版本' : editor.id ? '保存修订' : '发布知识'}</button></div>
    </form> : null}
    {view === 'knowledge' && revalidation ? <form className="otto-workspace-dialog__editor otto-enterprise-memory-revalidation" onSubmit={(event) => { event.preventDefault(); void saveRevalidation(); }}>
      <strong>复核：{revalidation.title}</strong>
      <textarea aria-label="复核依据" rows={4} value={revalidation.rationale} onChange={(event) => setRevalidation({ ...revalidation, rationale: event.target.value })} placeholder="写明核对过的制度原文、负责人确认或最新验证结果"/>
      <label><span>本次确认有效期</span><select aria-label="知识有效期" value={revalidation.validForDays} onChange={(event) => setRevalidation({ ...revalidation, validForDays: Number(event.target.value) })}><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>365 天</option></select></label>
      <small>到期后服务器会停止向成员和 Otto 返回该条知识，必须再次复核。</small>
      <div><button type="button" disabled={Boolean(busyId)} onClick={() => setRevalidation(null)}>取消</button><button type="submit" disabled={Boolean(busyId)}>{busyId ? '保存中…' : '确认复核'}</button></div>
    </form> : null}
    {error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {view === 'knowledge' && candidates.length ? <section className="otto-enterprise-memory-candidates" aria-label="可沉淀的工作成果">
      <strong>最近成果候选</strong><span>提交后先审核，不会静默发布给全公司</span>
      {candidates.map((candidate) => {
        const title = candidate.entry.taskTitle || candidate.entry.action;
        const sourceId = `work-result:${candidate.date}:${candidate.entry.time}:${title}`.slice(0, 150);
        const submitted = items.some((item) => item.sourceId?.endsWith(sourceId));
        return <div key={sourceId}><span><strong>{title}</strong><small>{candidate.date} {candidate.entry.time}</small></span><button type="button" disabled={submitted || busyId === sourceId} onClick={() => void submitCandidate(candidate)}>{submitted ? '已提交' : busyId === sourceId ? '提交中…' : '沉淀'}</button></div>;
      })}
    </section> : null}
    {view === 'timeline' ? <div className="otto-enterprise-memory-timeline" aria-label="企业记忆沿革">{timeline.map(({ item, revision }) => <article key={`${item.id}-${revision.id}`}>
      <time>{formatKnowledgeDate(revision.createdAt)}</time><div><span>{item.department || '全组织'} · {revision.category || item.category} · v{revision.version}</span><strong>{revision.title || item.title || item.category}</strong><p>{revision.content}</p><small>{revision.changedBy || item.contributor || '系统沉淀'} · {revision.changeNote || revision.status || '形成知识'}</small>{revision.adjudication ? <small>裁决依据：{revision.adjudication.rationale} · 采纳 {revision.adjudication.acceptedEvidenceIds.length} 条 · 排除 {revision.adjudication.rejectedEvidenceIds.length} 条</small> : null}</div>
    </article>)}</div> : <div className="otto-workspace-dialog__list otto-enterprise-memory-list">{items.filter((item) => item.status !== 'archived').map((item) => {
      const contested = Boolean(item.sourceLabel?.includes('证据存在冲突'));
      const expiresAt = Date.parse(item.expiresAt || '');
      const reviewDueAt = Date.parse(item.reviewDueAt || '');
      const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
      const reviewDue = !expired && Number.isFinite(reviewDueAt) && reviewDueAt <= Date.now();
      return <article key={item.id} className="otto-enterprise-memory-card">
        <div className="otto-enterprise-memory-card__meta"><span>{item.department || '全组织'}</span><span>{item.category}</span><span>{item.status === 'pending_review' ? '待审核' : '已发布'}</span><span>v{item.version ?? 1}</span><span>{Math.round(item.confidence * 100)}%</span>{expired ? <strong className="is-expired">已过期</strong> : reviewDue ? <strong className="is-review-due">待复核</strong> : null}</div>
        {item.evidenceCount ? <div className="otto-enterprise-memory-card__evidence"><strong>{item.evidenceCount} 条证据</strong><span>{item.distinctSessionCount || 0} 个会话</span><span>{item.distinctContributorCount || 0} 名贡献者</span>{item.verifiedEvidenceCount ? <span>{item.verifiedEvidenceCount} 条已验证</span> : null}{item.lastObservedAt ? <span>最近验证 {formatKnowledgeDate(item.lastObservedAt)}</span> : null}</div> : item.sourceType === 'manual' ? <div className="otto-enterprise-memory-card__evidence"><strong>管理员确认发布</strong></div> : null}
        <h3>{item.title || item.category}</h3><p>{item.content}</p>{item.sourceLabel || item.sourceId ? <div className="otto-enterprise-memory-card__source">来源：{item.sourceLabel || item.sourceId}</div> : null}<small>{item.contributor || '系统沉淀'} · {formatKnowledgeDate(item.updatedAt || item.createdAt)}</small>
        {item.reviewDueAt || item.expiresAt ? <div className="otto-enterprise-memory-card__lifecycle">{item.reviewDueAt ? <span>复核日期 {formatKnowledgeDate(item.reviewDueAt)}</span> : null}{item.expiresAt ? <span>有效期至 {formatKnowledgeDate(item.expiresAt)}</span> : null}</div> : null}
        {role === 'company_admin' ? <footer>
          {item.sourceType === 'auto_capture' || (item.evidenceCount ?? 0) > 0 ? <button type="button" disabled={busyId === item.id} onClick={() => void toggleEvidence(item.id)}>{evidence[item.id] !== undefined ? '收起证据' : '证据'}</button> : null}
          {item.status === 'pending_review' ? <button type="button" disabled={busyId === item.id || contested} title={contested ? '请先修订内容并完成冲突裁决' : undefined} onClick={() => void review(item.id, 'approve')}>{contested ? '先裁决冲突' : '发布'}</button> : null}
          <button type="button" disabled={busyId === item.id || (contested && !isAdjudicationReady(item.id))} title={contested && !isAdjudicationReady(item.id) ? '请先处理全部冲突证据，并填写至少 12 个字的裁决依据' : undefined} onClick={() => setEditor({ id: item.id, title: item.title || item.category, category: item.category, content: item.content, resolveConflict: contested, adjudication: contested ? adjudications[item.id] : undefined })}>{contested ? '审查并裁决' : '修订'}</button>
          {item.status === 'active' && !contested ? <button type="button" disabled={busyId === item.id} onClick={() => { setEditor(null); setRevalidation({ id: item.id, title: item.title || item.category, rationale: '', validForDays: item.sourceType === 'auto_capture' ? 180 : 365 }); }}>复核有效</button> : null}
          <button type="button" disabled={busyId === item.id} onClick={() => void toggleRevisions(item.id)}>{revisions[item.id] !== undefined ? '收起版本' : '版本'}</button><button type="button" disabled={busyId === item.id} onClick={() => void review(item.id, 'archive')}>归档</button>
        </footer> : null}
        {evidence[item.id] !== undefined ? <div className="otto-enterprise-memory-evidence" aria-label="知识证据明细">
          {evidence[item.id].length === 0 ? <div className="otto-enterprise-memory-evidence__empty">此条知识没有可展示的自动提炼证据。</div> : <>{evidence[item.id].map((entry) => <article key={entry.id}>
            <div className="otto-enterprise-memory-evidence__badges"><span>{entry.stance === 'affirmative' ? '肯定 / 要求' : entry.stance === 'negative' ? '否定 / 禁止' : '中性描述'}</span>{entry.contested ? <strong>涉及冲突</strong> : null}<span>{entry.verified ? '已验证' : '未验证'}</span></div>
            <p>{entry.content}</p><small>{entry.contributor || '系统观察'} · {formatKnowledgeDate(entry.observedAt)} · 置信度 {Math.round(entry.confidence * 100)}% · 影响 {Math.round(entry.impactScore * 100)}%</small><small>来源：{entry.sourceId || '来源编号不可用'}</small>{entry.tags.length || entry.impactReasons.length ? <small>{[...entry.tags, ...entry.impactReasons].join(' · ')}</small> : null}
            {contested && entry.contested ? <div className="otto-enterprise-memory-evidence__decision"><button type="button" aria-pressed={adjudications[item.id]?.acceptedEvidenceIds.includes(entry.id) ?? false} onClick={() => setEvidenceDisposition(item.id, entry.id, 'accepted')}>采纳</button><button type="button" aria-pressed={adjudications[item.id]?.rejectedEvidenceIds.includes(entry.id) ?? false} onClick={() => setEvidenceDisposition(item.id, entry.id, 'rejected')}>排除</button></div> : null}
          </article>)}{contested ? <label className="otto-enterprise-memory-evidence__rationale"><span>裁决依据</span><textarea aria-label="裁决依据" rows={3} value={adjudications[item.id]?.rationale ?? ''} onChange={(event) => setAdjudications((current) => ({ ...current, [item.id]: { acceptedEvidenceIds: current[item.id]?.acceptedEvidenceIds ?? [], rejectedEvidenceIds: current[item.id]?.rejectedEvidenceIds ?? [], rationale: event.target.value } }))} placeholder="说明采用哪些正式制度、验证结果或责任人确认作为裁决依据"/><small>已处理 {new Set([...(adjudications[item.id]?.acceptedEvidenceIds ?? []), ...(adjudications[item.id]?.rejectedEvidenceIds ?? [])]).size} / {evidence[item.id].filter((entry) => entry.contested).length} · 必须同时包含采纳和排除结论</small></label> : null}</>}
        </div> : null}
        {revisions[item.id]?.map((revision) => <blockquote key={revision.id}>v{revision.version} · {revision.changedBy || '系统'} · {revision.changeNote || revision.status}<p>{revision.content}</p>{revision.adjudication ? <div className="otto-enterprise-memory-revisions__adjudication"><strong>冲突裁决</strong><p>{revision.adjudication.rationale}</p><small>采纳证据 #{revision.adjudication.acceptedEvidenceIds.join('、#')} · 排除证据 #{revision.adjudication.rejectedEvidenceIds.join('、#')} · {revision.adjudication.adjudicatedBy || '管理员'}</small></div> : null}</blockquote>)}
      </article>;
    })}{!loading && !items.length ? <p>暂无企业知识。</p> : null}</div>}
  </DialogFrame>;
}

export function AutoSkillDialog({ open, candidates, lastAction, onRefresh, onConfirm, onReject, onClose }: {
  open: boolean; candidates: AutoSkillCandidateInfo[];
  lastAction: { kind: 'confirmed' | 'rejected'; candidateId: string; savedPath?: string } | null;
  onRefresh(): void; onConfirm(id: string): void; onReject(id: string): void; onClose(): void;
}): React.JSX.Element | null {
  if (!open) return null;
  return <DialogFrame title="自动 Skill 候选" onClose={onClose}><div className="otto-workspace-dialog__toolbar"><p>从重复工作成果中沉淀可复用流程。</p><button type="button" onClick={onRefresh}>立即分析</button></div>{lastAction?.kind === 'confirmed' ? <p role="status">Skill 已生成{lastAction.savedPath ? `：${lastAction.savedPath}` : ''}</p> : null}<div className="otto-workspace-dialog__list">{candidates.length ? candidates.map((candidate) => <article key={candidate.id}><h3>{candidate.name}</h3><p>{candidate.description}</p><small>{candidate.detectedPattern} · {candidate.occurrenceCount} 次重复</small><footer><button type="button" onClick={() => onConfirm(candidate.id)}>{candidate.recommendation === 'enhance' ? '确认增强' : '确认生成'}</button><button type="button" onClick={() => onReject(candidate.id)}>不再建议</button></footer></article>) : <p>暂无候选。点击“立即分析”扫描最近成果。</p>}</div></DialogFrame>;
}

export function CustomAgentManagerDialog({
  open,
  agents,
  onCreate,
  onDelete,
  onUpdateIcon,
  onClose,
}: {
  open: boolean;
  agents: readonly CustomAgentDefinition[];
  onCreate(draft: CustomAgentDraft): void | Promise<void>;
  onDelete(id: string): void;
  onUpdateIcon(id: string, icon: CustomAgentIcon): void;
  onClose(): void;
}): React.JSX.Element | null {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [icon, setIcon] = useState<CustomAgentIcon | undefined>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) {
      setName('');
      setInstructions('');
      setIcon(undefined);
      setError('');
    }
  }, [open]);
  if (!open) return null;
  return (
    <DialogFrame title="我的专家" onClose={onClose}>
      <form
        className="otto-workspace-dialog__editor otto-custom-agent-editor"
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          void Promise.resolve()
            .then(() => onCreate({ name, instructions, ...(icon ? { icon } : {}) }))
            .then(() => {
              setName('');
              setInstructions('');
              setIcon(undefined);
            })
            .catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)));
        }}
      >
        <input
          aria-label="专家名称"
          maxLength={40}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="例如：招投标助手"
        />
        <div className="otto-custom-agent-editor__icon">
          <span>模块图标</span>
          <CustomAgentIconPicker value={icon} label="模块" onChange={setIcon} />
        </div>
        <textarea
          aria-label="职责说明"
          maxLength={2000}
          rows={4}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="说明职责、交付格式和边界"
        />
        {error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}
        <button type="submit">创建专家</button>
      </form>
      <div className="otto-workspace-dialog__list otto-custom-agent-list">
        {agents.map((agent) => (
          <article key={agent.id}>
            <div className="otto-custom-agent-list__heading">
              <ModuleIcon
                icon={customAgentIconToModuleIcon(agent.icon)}
                label={agent.name}
                size={36}
              />
              <div>
                <h3>{agent.name}</h3>
                <p>{agent.instructions}</p>
              </div>
            </div>
            <footer>
              <CustomAgentIconPicker
                value={agent.icon}
                label={agent.name}
                onChange={(nextIcon) => onUpdateIcon(agent.id, nextIcon)}
              />
              <button
                type="button"
                onClick={() => {
                  if (window.confirm(`删除专家“${agent.name}”？`)) onDelete(agent.id);
                }}
              >
                删除
              </button>
            </footer>
          </article>
        ))}
        {!agents.length ? <p>还没有自定义专家。</p> : null}
      </div>
    </DialogFrame>
  );
}
