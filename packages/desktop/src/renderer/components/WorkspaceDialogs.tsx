/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutoSkillCandidateInfo } from 'otto-server';
import type { CentralEnterpriseRole } from '../state/centralEnterpriseIdentity.js';
import { customAgentIconToModuleIcon, type CustomAgentIcon } from '../customAgentIcons.js';
import type { CustomAgentDefinition, CustomAgentDraft } from '../customAgents.js';
import { CustomAgentIconPicker } from './CustomAgentIconPicker.js';
import { ModuleIcon } from './ModuleIcon.js';

export function DialogFrame({ title, onClose, children }: {
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

interface KnowledgeAiProposal {
  rationale: string;
  changes: string[];
  uncertainties: string[];
  usedEvidenceIds: string[];
  modelProvider: string;
}

function formatKnowledgeDate(value: string | null | undefined): string {
  if (!value) return '';
  return new Date(value).toLocaleDateString('zh-CN');
}

function knowledgeSourceLabel(sourceType?: string): string {
  if (sourceType === 'auto_capture') return 'Otto 自动学习';
  if (sourceType === 'manual') return '管理员补充';
  if (sourceType === 'document') return '企业文档';
  if (sourceType === 'work_result' || sourceType === 'task_log') return '工作过程自动提炼';
  if (sourceType === 'offboarding') return '离职交接';
  return '企业工作中形成';
}

function knowledgeReliabilityLabel(confidence: number): string {
  if (confidence >= 0.9) return '可信度很高';
  if (confidence >= 0.75) return '可信度较高';
  if (confidence >= 0.6) return '仍在学习';
  return '需要更多验证';
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
  const [busyId, setBusyId] = useState('');
  const [editor, setEditor] = useState<{
    id?: string; title: string; category: string; content: string; confidence?: number;
    resolveConflict?: boolean; adjudication?: Omit<KnowledgeAdjudication, 'id' | 'adjudicatedBy'>;
    aiProposal?: KnowledgeAiProposal;
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
      const next = await window.otto.enterpriseKnowledgeList({
        query: queryRef.current.trim() || undefined,
        includeReview: true,
      });
      if (epoch === epochRef.current) {
        setItems(next);
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
      setView('knowledge'); setBusyId('');
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
        title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(),
        confidence: editor.confidence ?? 0.95,
        changeNote: editor.resolveConflict
          ? '管理员核对证据并裁决冲突'
          : editor.aiProposal
            ? `管理员确认 AI 深化建议：${editor.aiProposal.rationale}`.slice(0, 500)
            : '管理员在企业记忆弹窗中修订',
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
      setNotice(editor.resolveConflict
        ? '冲突已裁决并形成新版本，请再次确认后发布。'
        : editor.aiProposal
          ? '深化后的新版本已形成，Otto 会在后续相关工作中使用。'
          : editor.id ? '知识已修订，新版本立即用于后续检索。' : '企业知识已发布。');
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
  const deepenKnowledge = async (item: KnowledgeItem): Promise<void> => {
    const epoch = epochRef.current;
    setBusyId(item.id); setError(''); setNotice('');
    try {
      const loaded = evidence[item.id] ?? await window.otto.enterpriseKnowledgeEvidence(item.id);
      if (epoch !== epochRef.current) return;
      setEvidence((current) => ({ ...current, [item.id]: loaded }));
      const proposal = await window.otto.enterpriseKnowledgeAnalyze({
        id: item.id,
        title: item.title || item.category,
        category: item.category,
        content: item.content,
        confidence: item.confidence,
        evidence: loaded.map((entry) => ({
          id: entry.id,
          content: entry.content,
          verified: entry.verified,
          contested: entry.contested,
          confidence: entry.confidence,
          observedAt: entry.observedAt,
        })),
      });
      if (epoch !== epochRef.current) return;
      if (!proposal.shouldUpdate) {
        setNotice(`AI 已检查：${proposal.rationale || '现有内容已经能够准确概括当前证据，暂不需要形成新版本。'}`);
        return;
      }
      setRevalidation(null);
      setEditor({
        id: item.id,
        title: proposal.title,
        category: proposal.category,
        content: proposal.content,
        confidence: proposal.confidence,
        aiProposal: {
          rationale: proposal.rationale,
          changes: proposal.changes,
          uncertainties: proposal.uncertainties,
          usedEvidenceIds: proposal.usedEvidenceIds,
          modelProvider: proposal.modelProvider,
        },
      });
      setNotice('AI 已结合最新证据生成深化建议。请管理员检查后再应用。');
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const deleteKnowledge = async (item: KnowledgeItem): Promise<void> => {
    const title = item.title || item.category;
    if (!window.confirm(`永久删除“${title}”吗？\n\n此操作会同时删除版本记录和自动学习证据，无法撤销；Otto 之后不会再调用它。`)) return;
    const epoch = epochRef.current;
    setBusyId(item.id); setError(''); setNotice('');
    try {
      await window.otto.enterpriseKnowledgeDelete(item.id);
      if (epoch !== epochRef.current) return;
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      setRevisions((current) => { const next = { ...current }; delete next[item.id]; return next; });
      setEvidence((current) => { const next = { ...current }; delete next[item.id]; return next; });
      setNotice(`已永久删除“${title}”，Otto 不会再调用这条记忆。`);
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setBusyId(''); }
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
  const timeline = items.filter((item) => !item.status || item.status === 'active')
    .flatMap((item) => (revisions[item.id]?.length ? revisions[item.id] : [{
      id: `current-${item.id}`, version: item.version ?? 1, title: item.title,
      category: item.category, content: item.content, changedBy: item.contributor,
      changeNote: '当前版本', createdAt: item.updatedAt || item.createdAt,
    }]).map((revision) => ({ item, revision })))
    .sort((left, right) => (right.revision.createdAt || '').localeCompare(left.revision.createdAt || ''));
  const visibleItems = items.filter((item) => item.status !== 'archived');
  const activeCount = visibleItems.filter((item) => !item.status || item.status === 'active').length;
  const pendingCount = visibleItems.filter((item) => item.status === 'pending_review').length;
  const automaticallyLearnedCount = visibleItems.filter((item) => item.sourceType === 'auto_capture').length;
  if (!open) return null;
  return <DialogFrame title="企业记忆" onClose={requestClose}>
    <section className="otto-enterprise-memory-hero" aria-label="企业记忆工作方式">
      <div className="otto-enterprise-memory-hero__copy">
        <span className="otto-enterprise-memory-hero__eyebrow">自动学习已开启</span>
        <h3>Otto 正在学习这家企业怎样工作</h3>
        <p>完成对话和工作后，Otto 会自动识别稳定的制度、偏好、决定与解决方法。普通闲聊、敏感凭据和低可信内容不会进入企业记忆。</p>
        <p>已经确认的记忆会在相关问题中自动调用；遇到更多证据时会提高可信度，也可以交给 AI 重新归纳，再由管理员确认新版本。</p>
      </div>
      <div className="otto-enterprise-memory-hero__stats" aria-label="企业记忆概况">
        <div><strong>{activeCount}</strong><span>Otto 已掌握</span></div>
        <div><strong>{pendingCount}</strong><span>待管理员确认</span></div>
        <div><strong>{automaticallyLearnedCount}</strong><span>自动学习形成</span></div>
      </div>
    </section>
    <div role="tablist" aria-label="企业知识与记忆" className="otto-enterprise-memory-switch">
      <button type="button" role="tab" aria-selected={view === 'knowledge'} onClick={() => setView('knowledge')}>已掌握与待确认</button>
      <button type="button" role="tab" aria-selected={view === 'timeline'} onClick={() => setView('timeline')}>如何变得更准确</button>
    </div>
    <div className="otto-workspace-dialog__toolbar">
      <form onSubmit={(event) => { event.preventDefault(); void refresh(); }}><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索企业知识" placeholder="搜索制度、流程、项目结论"/><button type="submit">搜索</button></form>
      {role === 'company_admin' ? <button type="button" onClick={() => setEditor({ title: '', category: '制度流程', content: '' })}>手动补充</button> : null}
      <button type="button" disabled={loading} onClick={() => void refresh()}>{loading ? '加载中…' : '刷新'}</button>
    </div>
    {view === 'knowledge' && editor ? <form className="otto-workspace-dialog__editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {editor.aiProposal ? <section className="otto-enterprise-memory-ai-proposal" aria-label="AI 深化建议">
        <span>AI 深化建议 · 尚未保存</span>
        <strong>{editor.aiProposal.rationale}</strong>
        {editor.aiProposal.changes.length ? <ul>{editor.aiProposal.changes.map((change) => <li key={change}>{change}</li>)}</ul> : null}
        {editor.aiProposal.uncertainties.length ? <div><b>仍需人工判断</b><ul>{editor.aiProposal.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
        <small>依据 {editor.aiProposal.usedEvidenceIds.length} 条企业证据 · {editor.aiProposal.modelProvider}。请检查下方内容，管理员保存后才会形成新版本。</small>
      </section> : null}
      <input aria-label="知识标题" value={editor.title} onChange={(event) => setEditor({ ...editor, title: event.target.value })}/>
      <input aria-label="知识分类" value={editor.category} onChange={(event) => setEditor({ ...editor, category: event.target.value })}/>
      <textarea aria-label="知识内容" rows={6} value={editor.content} onChange={(event) => setEditor({ ...editor, content: event.target.value })}/>
      {editor.resolveConflict ? <small>保存后会记录本次证据取舍和裁决依据，并生成待再次确认的新版本。</small> : null}
      <div><button type="button" disabled={Boolean(busyId)} onClick={() => setEditor(null)}>取消</button><button type="submit" disabled={Boolean(busyId)}>{busyId ? '保存中…' : editor.resolveConflict ? '保存裁决版本' : editor.aiProposal ? '应用并形成新版本' : editor.id ? '保存修订' : '发布知识'}</button></div>
    </form> : null}
    {view === 'knowledge' && revalidation ? <form className="otto-workspace-dialog__editor otto-enterprise-memory-revalidation" onSubmit={(event) => { event.preventDefault(); void saveRevalidation(); }}>
      <strong>复核：{revalidation.title}</strong>
      <textarea aria-label="复核依据" rows={4} value={revalidation.rationale} onChange={(event) => setRevalidation({ ...revalidation, rationale: event.target.value })} placeholder="写明核对过的制度原文、负责人确认或最新验证结果"/>
      <label><span>本次确认有效期</span><select aria-label="知识有效期" value={revalidation.validForDays} onChange={(event) => setRevalidation({ ...revalidation, validForDays: Number(event.target.value) })}><option value={90}>90 天</option><option value={180}>180 天</option><option value={365}>365 天</option></select></label>
      <small>到期后服务器会停止向成员和 Otto 返回该条知识，必须再次复核。</small>
      <div><button type="button" disabled={Boolean(busyId)} onClick={() => setRevalidation(null)}>取消</button><button type="submit" disabled={Boolean(busyId)}>{busyId ? '保存中…' : '确认复核'}</button></div>
    </form> : null}
    {error ? <p role="alert" className="otto-workspace-dialog__error">{error}</p> : null}{notice ? <p role="status">{notice}</p> : null}
    {view === 'timeline' ? <div className="otto-enterprise-memory-timeline" aria-label="企业记忆沿革">{timeline.map(({ item, revision }) => <article key={`${item.id}-${revision.id}`}>
      <time>{formatKnowledgeDate(revision.createdAt)}</time><div><span>{item.department || '全组织'} · {revision.category || item.category} · v{revision.version}</span><strong>{revision.title || item.title || item.category}</strong><p>{revision.content}</p><small>{revision.changedBy || item.contributor || '系统沉淀'} · {revision.changeNote || revision.status || '形成知识'}</small>{revision.adjudication ? <small>裁决依据：{revision.adjudication.rationale} · 采纳 {revision.adjudication.acceptedEvidenceIds.length} 条 · 排除 {revision.adjudication.rejectedEvidenceIds.length} 条</small> : null}</div>
    </article>)}</div> : <div className="otto-workspace-dialog__list otto-enterprise-memory-list">{visibleItems.map((item) => {
      const contested = Boolean(item.sourceLabel?.includes('证据存在冲突'));
      const expiresAt = Date.parse(item.expiresAt || '');
      const reviewDueAt = Date.parse(item.reviewDueAt || '');
      const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
      const reviewDue = !expired && Number.isFinite(reviewDueAt) && reviewDueAt <= Date.now();
      return <article key={item.id} className="otto-enterprise-memory-card">
        <div className="otto-enterprise-memory-card__meta"><span>{item.department || '全组织'}</span><span>{item.category}</span><strong>{item.status === 'pending_review' ? '待你确认' : '对话中已启用'}</strong><span>{knowledgeSourceLabel(item.sourceType)}</span>{expired ? <strong className="is-expired">已过期</strong> : reviewDue ? <strong className="is-review-due">待复核</strong> : null}</div>
        {item.evidenceCount ? <div className="otto-enterprise-memory-card__evidence"><strong>已被 {item.evidenceCount} 次工作验证</strong><span>{item.distinctSessionCount || 0} 个独立会话</span><span>{item.distinctContributorCount || 0} 名贡献者</span>{item.verifiedEvidenceCount ? <span>{item.verifiedEvidenceCount} 次明确确认</span> : null}{item.lastObservedAt ? <span>最近学习 {formatKnowledgeDate(item.lastObservedAt)}</span> : null}</div> : item.sourceType === 'manual' ? <div className="otto-enterprise-memory-card__evidence"><strong>由管理员直接确认</strong></div> : null}
        <h3>{item.title || item.category}</h3><p>{item.content}</p><div className="otto-enterprise-memory-card__usage">{item.status === 'pending_review' ? '确认后，Otto 才会在相关对话和工作中自动使用。' : '遇到相关问题时，Otto 会自动参考这条企业记忆。'}</div><small>{knowledgeReliabilityLabel(item.confidence)} · 已深化 {Math.max(0, (item.version ?? 1) - 1)} 次 · {item.contributor || 'Otto 自动学习'} · {formatKnowledgeDate(item.updatedAt || item.createdAt)}</small>
        {item.reviewDueAt || item.expiresAt ? <div className="otto-enterprise-memory-card__lifecycle">{item.reviewDueAt ? <span>复核日期 {formatKnowledgeDate(item.reviewDueAt)}</span> : null}{item.expiresAt ? <span>有效期至 {formatKnowledgeDate(item.expiresAt)}</span> : null}</div> : null}
        {role === 'company_admin' ? <footer>
          {item.sourceType === 'auto_capture' || (item.evidenceCount ?? 0) > 0 ? <button type="button" disabled={busyId === item.id} onClick={() => void toggleEvidence(item.id)}>{evidence[item.id] !== undefined ? '收起学习依据' : '查看学习依据'}</button> : null}
          {item.status === 'pending_review' ? <button type="button" disabled={busyId === item.id || contested} title={contested ? '请先修订内容并完成冲突裁决' : undefined} onClick={() => void review(item.id, 'approve')}>{contested ? '先裁决冲突' : '确认并让 Otto 使用'}</button> : null}
          <button type="button" disabled={busyId === item.id || contested} title={contested ? '请先完成人工冲突裁决' : '让大模型结合全部学习依据重新归纳，保存前仍需管理员确认'} onClick={() => void deepenKnowledge(item)}>{busyId === item.id ? '分析中…' : 'AI 深化'}</button>
          <button type="button" disabled={busyId === item.id || (contested && !isAdjudicationReady(item.id))} title={contested && !isAdjudicationReady(item.id) ? '请先处理全部冲突证据，并填写至少 12 个字的裁决依据' : undefined} onClick={() => setEditor({ id: item.id, title: item.title || item.category, category: item.category, content: item.content, resolveConflict: contested, adjudication: contested ? adjudications[item.id] : undefined })}>{contested ? '审查并裁决' : '人工修改'}</button>
          {item.status === 'active' && !contested ? <button type="button" disabled={busyId === item.id} onClick={() => { setEditor(null); setRevalidation({ id: item.id, title: item.title || item.category, rationale: '', validForDays: item.sourceType === 'auto_capture' ? 180 : 365 }); }}>仍然有效</button> : null}
          <button type="button" disabled={busyId === item.id} onClick={() => void toggleRevisions(item.id)}>{revisions[item.id] !== undefined ? '收起变化' : '查看变化'}</button><button type="button" disabled={busyId === item.id} onClick={() => void review(item.id, 'archive')}>停止使用</button><button className="otto-enterprise-memory-delete" type="button" disabled={busyId === item.id} onClick={() => void deleteKnowledge(item)}>永久删除</button>
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
  return <DialogFrame title="Skill 草稿与候选" onClose={onClose}><div className="otto-workspace-dialog__toolbar"><p>主动需求和重复工作都会先进入隔离草稿区，检查通过并由你确认后才安装。</p><button type="button" onClick={onRefresh}>立即分析</button></div>{lastAction?.kind === 'confirmed' ? <p role="status">Skill 已确认安装{lastAction.savedPath ? `：${lastAction.savedPath}` : ''}</p> : null}<div className="otto-workspace-dialog__list">{candidates.length ? candidates.map((candidate) => {
    const ready = candidate.draft?.validationPassed === true && candidate.draft.packageReady === true;
    return <article key={candidate.id} aria-label={`${candidate.name} Skill 草稿`}>
      <h3>{candidate.name}</h3>
      <p>{candidate.description}</p>
      <small>{candidate.source === 'proactive' ? '主动需求' : '自动发现'} · {candidate.detectedPattern}{candidate.source === 'automatic' ? ` · ${candidate.occurrenceCount} 次重复` : ''}</small>
      {candidate.draft ? <div className="otto-auto-skill-draft-audit">
        <p><strong>{ready ? '检查通过，等待确认' : '检查未通过，禁止安装'}</strong>{candidate.draft.packageRelativePath ? ` · 已打包 ${candidate.draft.packageRelativePath}` : ''}</p>
        <details><summary>文件变更（{candidate.draft.risk.fileChanges.length}）</summary><ul>{candidate.draft.risk.fileChanges.map((change) => <li key={change}>{change}</li>)}</ul></details>
        <details><summary>权限（{candidate.draft.risk.permissions.length}）</summary>{candidate.draft.risk.permissions.length ? <ul>{candidate.draft.risk.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul> : <p>未发现额外权限。</p>}</details>
        <details><summary>安全风险（{candidate.draft.risk.securityRisks.length}）</summary>{candidate.draft.risk.securityRisks.length ? <ul>{candidate.draft.risk.securityRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>未发现脚本或高风险行为。</p>}</details>
        <details><summary>测试与校验（{candidate.draft.tests.length}）</summary><ul>{candidate.draft.tests.map((test) => <li key={test.name}>{test.status === 'passed' ? '通过' : test.status === 'failed' ? '失败' : '需人工确认'} · {test.name}：{test.detail}</li>)}</ul>{candidate.draft.validationErrors.map((error) => <p role="alert" key={error}>{error}</p>)}</details>
        {candidate.draft.risk.executionBlocked ? <p role="note">此草稿包含脚本：生成、打包和安装均不会执行；以后首次执行仍需单独授权。</p> : null}
      </div> : <p role="alert">旧候选尚未生成受控草稿；确认时会先完成校验和打包。</p>}
      <footer><button type="button" disabled={candidate.draft ? !ready : false} onClick={() => onConfirm(candidate.id)}>{candidate.recommendation === 'enhance' ? '确认增强并安装' : '确认安装'}</button><button type="button" onClick={() => onReject(candidate.id)}>拒绝草稿</button></footer>
    </article>;
  }) : <p>暂无草稿或候选。点击“立即分析”扫描最近成果；也可以直接让 Otto 创建一个 Skill。</p>}</div></DialogFrame>;
}

export function CustomAgentManagerDialog({
  open,
  agents,
  onGenerate,
  onCreate,
  onDelete,
  onUpdateIcon,
  onClose,
}: {
  open: boolean;
  agents: readonly CustomAgentDefinition[];
  onGenerate(requirement: string): void | Promise<void>;
  onCreate(draft: CustomAgentDraft): void | Promise<void>;
  onDelete(id: string): void;
  onUpdateIcon(id: string, icon: CustomAgentIcon): void;
  onClose(): void;
}): React.JSX.Element | null {
  const [requirement, setRequirement] = useState('');
  const [generating, setGenerating] = useState(false);
  const [generationStatus, setGenerationStatus] = useState('');
  const [generationError, setGenerationError] = useState('');
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [icon, setIcon] = useState<CustomAgentIcon | undefined>();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) {
      setRequirement('');
      setGenerating(false);
      setGenerationStatus('');
      setGenerationError('');
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
        className="otto-workspace-dialog__editor otto-custom-agent-generator"
        aria-label="一句话生成专家"
        aria-busy={generating}
        onSubmit={(event) => {
          event.preventDefault();
          const requested = requirement.trim();
          if (!requested || generating) return;
          setGenerationError('');
          setGenerationStatus('');
          setGenerating(true);
          void Promise.resolve()
            .then(() => onGenerate(requested))
            .then(() => {
              setRequirement('');
              setGenerationStatus('专家已生成并加入“我的专家”，现在可以直接运行。');
            })
            .catch((cause) => setGenerationError(cause instanceof Error ? cause.message : String(cause)))
            .finally(() => setGenerating(false));
        }}
      >
        <div className="otto-custom-agent-generator__heading">
          <div><h3>一句话生成专家</h3><p>Otto 会生成名称、职责、工作步骤和输出规范，并立即保存到下方列表。</p></div>
        </div>
        <textarea
          aria-label="一句话专家需求"
          maxLength={1000}
          rows={3}
          value={requirement}
          disabled={generating}
          onChange={(event) => setRequirement(event.target.value)}
          placeholder="例如：帮我审查合同风险，标出条款位置并给出修改建议"
        />
        <button type="submit" disabled={generating || !requirement.trim()}>
          {generating ? '正在生成…' : '生成并加入我的专家'}
        </button>
        {generationError ? <p role="alert" className="otto-workspace-dialog__error">{generationError}</p> : null}
        {generationStatus ? <p role="status">{generationStatus}</p> : null}
      </form>
      <div className="otto-custom-agent-divider" role="separator"><span>或者手动创建</span></div>
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
      {agents.length ? (
        <p className="otto-custom-agent-list__hint">删除后，该专家会同时从所有功能组移除。</p>
      ) : null}
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
                className="otto-custom-agent-list__delete"
                aria-label={`删除专家 ${agent.name}`}
                onClick={() => {
                  if (window.confirm(
                    `永久删除专家“${agent.name}”？删除后会同时从所有功能组移除。`,
                  )) onDelete(agent.id);
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
