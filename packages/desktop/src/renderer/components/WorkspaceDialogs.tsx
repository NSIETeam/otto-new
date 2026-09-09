import { useModuleReadCache } from '../state/ModuleReadProvider.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AutoSkillCandidateInfo, InstalledSkillReleases, SkillRollbackInput, SkillAcceptanceInput } from 'otto-server';
import type { CentralEnterpriseRole } from '../state/centralEnterpriseIdentity.js';
import { customAgentIconToModuleIcon, type CustomAgentIcon } from '../customAgentIcons.js';
import type { CustomAgentDefinition, CustomAgentDraft } from '../customAgents.js';
import {
  buildEnterpriseMemoryHealth,
  enterpriseMemoryUsageScenarios,
  enterpriseMemoryUseStatus,
  type EnterpriseMemoryHealthNode,
  type EnterpriseMemoryHealthStatus,
} from '../enterpriseMemoryHealth.js';
import { CustomAgentIconPicker } from './CustomAgentIconPicker.js';
import { ModuleIcon } from './ModuleIcon.js';
import { SkillFunctionCard, SkillVersionPanel } from './SkillVersionPanel.js';
import { EnterpriseMemoryVersions, MemoryContentComparison } from './EnterpriseMemoryVersions.js';

export function DialogFrame({ title, onClose, children, size = 'standard', className = '', icon, subtitle }: {
  title: string; onClose(): void; children: React.ReactNode; size?: 'compact' | 'standard' | 'wide';
  className?: string; icon?: React.ReactNode; subtitle?: string;
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
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex]:not([tabindex="-1"])'));
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
      <section ref={ref} className={`otto-workspace-dialog otto-workspace-dialog--${size} ${className}`} role="dialog" aria-modal="true" aria-label={title}>
        <header>{icon || subtitle ? <div className="otto-workspace-dialog__heading">{icon ? <span className="otto-workspace-dialog__icon" aria-hidden="true">{icon}</span> : null}<div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div></div> : <h2>{title}</h2>}<button type="button" aria-label={`关闭${title}`} onClick={onClose}>×</button></header>
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
  evidenceGraph?: Array<{
    claim: string;
    status: 'supported' | 'partially_supported' | 'contested' | 'unverified';
    evidenceIds: string[];
    explanation: string;
    gaps: string[];
    nextQuestion: string;
  }>;
  applicableScenarios?: string[];
  riskIfWrong?: string;
  nextQuestion?: string;
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

function knowledgeHealthLabel(status: EnterpriseMemoryHealthStatus): string {
  if (status === 'trusted') return '有确认记录';
  if (status === 'learning') return '继续学习';
  if (status === 'needs_review') return '等待确认';
  if (status === 'conflicted') return '存在冲突';
  return '已经过期';
}

function evidenceClaimStatusLabel(status: NonNullable<KnowledgeAiProposal['evidenceGraph']>[number]['status']): string {
  if (status === 'supported') return '有证据支持';
  if (status === 'partially_supported') return '部分支持';
  if (status === 'contested') return '证据冲突';
  return '尚未验证';
}

export function EnterpriseMemoryDialog({ open, role, onClose }: {
  open: boolean; role?: CentralEnterpriseRole; onClose(): void;
}): React.JSX.Element | null {
  const cache = useModuleReadCache();
  const [items, setItems] = useState<KnowledgeItem[]>([]);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<'overview' | 'questions' | 'knowledge' | 'timeline'>('overview');
  const [busyId, setBusyId] = useState('');
  const [editor, setEditor] = useState<{
    id?: string; baseVersion?: number; original?: KnowledgeItem; title: string; category: string; content: string; confidence?: number;
    resolveConflict?: boolean; adjudication?: Omit<KnowledgeAdjudication, 'id' | 'adjudicatedBy'>;
    aiProposal?: KnowledgeAiProposal;
  } | null>(null);
  const [revalidation, setRevalidation] = useState<{
    id: string; title: string; rationale: string; validForDays: number;
  } | null>(null);
  const [revisions, setRevisions] = useState<Record<string, KnowledgeRevision[]>>({});
  const [evidence, setEvidence] = useState<Record<string, KnowledgeEvidence[]>>({});
  const [aiInsights, setAiInsights] = useState<Record<string, KnowledgeAiProposal>>({});
  const [adjudications, setAdjudications] = useState<Record<string, Omit<KnowledgeAdjudication, 'id' | 'adjudicatedBy'>>>({});
  const epochRef = useRef(0);
  const queryRef = useRef('');
  queryRef.current = query;
  const refresh = useCallback(async (): Promise<void> => {
    const epoch = ++epochRef.current;
    setLoading(true); setError('');
    try {
      const query = queryRef.current.trim();
      const key = `knowledge:${query}`;
      const cached = cache.peek<KnowledgeItem[]>(key);
      if (cached) setItems(cached);
      const next = await cache.read(key, () => window.otto.enterpriseKnowledgeList({
        query: query || undefined,
        includeReview: true,
      }), 0);
      if (epoch === epochRef.current && cache.isCurrent(key, next)) {
        setItems(next); setRevisions({}); setEvidence({}); setAiInsights({});
      }
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setLoading(false); }
  }, [cache]);
  useEffect(() => {
    if (open) void refresh();
    else {
      epochRef.current += 1;
      cache.invalidate(`knowledge:${queryRef.current.trim()}`);
      setLoading(false);
      setEditor(null); setRevalidation(null); setRevisions({}); setEvidence({});
      setAdjudications({}); setAiInsights({}); setError(''); setNotice('');
      setBusyId('');
    }
  }, [cache, open, refresh]);
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
      const saved = editor.id ? await window.otto.enterpriseKnowledgeRevise(editor.id, {
        expectedVersion: editor.baseVersion,
        title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(),
        confidence: editor.original?.confidence,
        changeNote: editor.resolveConflict
          ? '管理员核对证据并裁决冲突'
          : editor.aiProposal
            ? `管理员确认 AI 深化建议：${editor.aiProposal.rationale}`.slice(0, 500)
            : '管理员在企业记忆弹窗中修订',
        resolveConflict: editor.resolveConflict,
        adjudication: editor.resolveConflict ? editor.adjudication : undefined,
      }) : await window.otto.enterpriseKnowledgeRecord({ sourceId: `manual:${crypto.randomUUID()}`, title: editor.title.trim(), category: editor.category.trim(), content: editor.content.trim(), confidence: 0.95, sourceType: 'manual', sourceLabel: '企业管理员手动录入' });
      cache.removePrefix('knowledge:');
      if (epoch !== epochRef.current) return;
      if (editor.id) {
        setRevisions((current) => { const next = { ...current }; delete next[editor.id!]; return next; });
        setEvidence((current) => { const next = { ...current }; delete next[editor.id!]; return next; });
        setAdjudications((current) => { const next = { ...current }; delete next[editor.id!]; return next; });
        setAiInsights((current) => { const next = { ...current }; delete next[editor.id!]; return next; });
      }
      setEditor(null);
      setNotice(editor.id
        ? `内容已保存。${enterpriseMemoryUseStatus(saved as KnowledgeItem)}`
        : '补充内容已保存，请查看下方审核状态。');
      setBusyId(''); await refresh();
    } catch (cause) { if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const review = async (id: string, action: 'approve' | 'archive'): Promise<void> => {
    const epoch = epochRef.current;
    setBusyId(id);
    try { await window.otto.enterpriseKnowledgeReview(id, action, undefined, items.find((item) => item.id === id)?.version); cache.removePrefix('knowledge:'); if (epoch !== epochRef.current) return; setNotice(action === 'approve' ? '知识已发布，可供 Otto 检索引用。' : '知识已归档。'); setRevisions((current) => { const next = { ...current }; delete next[id]; return next; }); setEvidence((current) => { const next = { ...current }; delete next[id]; return next; }); setBusyId(''); await refresh(); }
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
      cache.removePrefix('knowledge:');
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
      const insight: KnowledgeAiProposal = {
        rationale: proposal.rationale,
        changes: proposal.changes,
        uncertainties: proposal.uncertainties,
        usedEvidenceIds: proposal.usedEvidenceIds,
        modelProvider: proposal.modelProvider,
        evidenceGraph: proposal.evidenceGraph,
        applicableScenarios: proposal.applicableScenarios,
        riskIfWrong: proposal.riskIfWrong,
        nextQuestion: proposal.nextQuestion,
      };
      setAiInsights((current) => ({ ...current, [item.id]: insight }));
      if (!proposal.shouldUpdate) {
        setNotice(`AI 已检查：${proposal.rationale || '现有内容已经能够准确概括当前证据，暂不需要形成新版本。'}`);
        return;
      }
      setRevalidation(null);
      setEditor({
        id: item.id,
        baseVersion: item.version,
        original: item,
        title: proposal.title,
        category: proposal.category,
        content: proposal.content,
        confidence: proposal.confidence,
        aiProposal: insight,
      });
      setView('knowledge');
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
      cache.removePrefix('knowledge:');
      setItems((current) => current.filter((entry) => entry.id !== item.id));
      if (epoch !== epochRef.current) return;
      setRevisions((current) => { const next = { ...current }; delete next[item.id]; return next; });
      setEvidence((current) => { const next = { ...current }; delete next[item.id]; return next; });
      setAiInsights((current) => { const next = { ...current }; delete next[item.id]; return next; });
      setNotice(`已永久删除“${title}”，Otto 不会再调用这条记忆。`);
    } catch (cause) {
      if (epoch === epochRef.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (epoch === epochRef.current) setBusyId(''); }
  };
  const restoreKnowledge = async (item: KnowledgeItem, revision: KnowledgeRevision, reason: string): Promise<void> => {
    if (role !== 'company_admin' || busyId || !item.version) return;
    const epoch = epochRef.current;
    setBusyId(item.id); setError(''); setNotice('');
    try {
      const saved = await window.otto.enterpriseKnowledgeRevise(item.id, {
        expectedVersion: item.version, restoreVersion: revision.version,
        title: revision.title || item.title || item.category, category: revision.category || item.category,
        content: revision.content, changeNote: reason,
      });
      if (epoch !== epochRef.current) return;
      setEditor(null); setRevalidation(null); setRevisions({}); setAiInsights({});
      setNotice(saved.status === 'pending_review'
        ? `已恢复为 v${saved.version}，待管理员重新确认；历史版本仍保留，暂不进入成员检索。`
        : `服务端返回的状态与预期不同，请刷新核对：${enterpriseMemoryUseStatus(saved)}`);
      setBusyId(''); await refresh();
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
    const missing = items.filter((item) => revisions[item.id] === undefined);
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
  const timeline = items.flatMap((item) => (revisions[item.id]?.length ? revisions[item.id] : [{
      id: `current-${item.id}`, version: item.version ?? 1, title: item.title,
      category: item.category, content: item.content, changedBy: item.contributor,
      changeNote: '当前版本', createdAt: item.updatedAt || item.createdAt,
    }]).map((revision) => ({ item, revision })))
    .sort((left, right) => (right.revision.createdAt || '').localeCompare(left.revision.createdAt || ''));
  const visibleItems = items.filter((item) => item.status !== 'archived');
  const activeCount = visibleItems.filter((item) => item.status === 'active' && !item.sourceLabel?.includes('证据存在冲突') && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now())).length;
  const pendingCount = visibleItems.filter((item) => item.status === 'pending_review').length;
  const automaticallyLearnedCount = visibleItems.filter((item) => item.sourceType === 'auto_capture').length;
  const memoryHealth = useMemo(() => buildEnterpriseMemoryHealth(visibleItems), [visibleItems]);
  const openHealthNode = (node: EnterpriseMemoryHealthNode): void => {
    setView('knowledge');
    const item = visibleItems.find((entry) => entry.id === node.id);
    if (item && (node.status === 'conflicted' || node.status === 'learning')
      && evidence[item.id] === undefined) void toggleEvidence(item.id);
  };
  if (!open) return null;
  return <DialogFrame title="企业记忆" onClose={requestClose}>
    <section className="otto-enterprise-memory-hero" aria-label="企业记忆工作方式">
      <div className="otto-enterprise-memory-hero__copy">
        <span className="otto-enterprise-memory-hero__eyebrow">从工作中积累，按依据使用</span>
        <h3>Otto 正在学习这家企业怎样工作</h3>
        <p>企业知识功能开启时，完成对话和工作后，Otto 会自动识别制度、偏好、决定与解决方法，过滤常见闲聊和敏感凭据，先积累观察记录。自动提炼不等于事实已验证。</p>
        <p>已经确认且未过期的记忆，可按部门权限供相关对话和任务参考。新证据继续积累，冲突或过期时提示复核。管理者可以修改、停止使用、删除，并比较或恢复历史内容。</p>
      </div>
      <div className="otto-enterprise-memory-hero__stats" aria-label="企业记忆概况">
        <div><strong>{activeCount}</strong><span>当前可供检索</span></div>
        <div><strong>{pendingCount}</strong><span>待管理员确认</span></div>
        <div><strong>{automaticallyLearnedCount}</strong><span>自动学习形成</span></div>
        <div><strong>{memoryHealth.counts.conflicted + memoryHealth.counts.expired}</strong><span>冲突或已过期</span></div>
      </div>
    </section>
    <div role="tablist" aria-label="企业知识与记忆" className="otto-enterprise-memory-switch">
      <button type="button" role="tab" aria-selected={view === 'overview'} onClick={() => setView('overview')}>记忆地图</button>
      <button type="button" role="tab" aria-selected={view === 'questions'} onClick={() => setView('questions')}>下一步确认</button>
      <button type="button" role="tab" aria-selected={view === 'knowledge'} onClick={() => setView('knowledge')}>已掌握与待确认</button>
      <button type="button" role="tab" aria-selected={view === 'timeline'} onClick={() => setView('timeline')}>版本与变更记录</button>
    </div>
    <div className="otto-workspace-dialog__toolbar">
      <form onSubmit={(event) => { event.preventDefault(); void refresh(); }}><input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜索企业知识" placeholder="搜索制度、流程、项目结论"/><button type="submit">搜索</button></form>
      {role === 'company_admin' ? <button type="button" onClick={() => { setView('knowledge'); setEditor({ title: '', category: '制度流程', content: '' }); }}>手动补充</button> : null}
      <button type="button" disabled={loading} onClick={() => void refresh()}>{loading ? '加载中…' : '刷新'}</button>
    </div>
    {view === 'knowledge' && editor ? <form className="otto-workspace-dialog__editor" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      {editor.aiProposal ? <section className="otto-enterprise-memory-ai-proposal" aria-label="AI 深化建议">
        <span>AI 深化建议 · 基于 v{editor.baseVersion ?? '未知'} · 尚未保存</span><p>以下理由是模型建议，不是验证报告。保存前请比较实际内容，核对引用与适用范围。</p>
        <strong>{editor.aiProposal.rationale}</strong>
        {editor.aiProposal.changes.length ? <ul>{editor.aiProposal.changes.map((change) => <li key={change}>{change}</li>)}</ul> : null}
        {editor.aiProposal.uncertainties.length ? <div><b>仍需人工判断</b><ul>{editor.aiProposal.uncertainties.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
        {editor.aiProposal.evidenceGraph?.length ? <div className="otto-enterprise-memory-ai-graph"><b>主张—证据图谱</b>{editor.aiProposal.evidenceGraph.map((node) => <article key={`${node.claim}-${node.status}`} className={`is-${node.status}`}><header><strong>{node.claim}</strong><span>{evidenceClaimStatusLabel(node.status)}</span></header><small>模型判断 · 引用证据 #{node.evidenceIds.join('、#') || '无'}；请在下方学习依据中核对原文</small>{node.explanation ? <p>{node.explanation}</p> : null}{node.gaps.length ? <small>缺口：{node.gaps.join('；')}</small> : null}{node.nextQuestion ? <small>建议确认：{node.nextQuestion}</small> : null}</article>)}</div> : null}
        {editor.aiProposal.applicableScenarios?.length ? <div><b>模型建议适用场景（未经逐项验证）</b><ul>{editor.aiProposal.applicableScenarios.map((item) => <li key={item}>{item}</li>)}</ul></div> : null}
        {editor.aiProposal.riskIfWrong ? <small><b>如果记错：</b>{editor.aiProposal.riskIfWrong}</small> : null}
        {editor.aiProposal.nextQuestion ? <div className="otto-enterprise-memory-ai-next"><span>下一条最值得确认的问题</span><strong>{editor.aiProposal.nextQuestion}</strong></div> : null}
        <small>依据 {editor.aiProposal.usedEvidenceIds.length} 条企业证据 · {editor.aiProposal.modelProvider}。请检查下方内容，管理员保存后才会形成新版本。</small>
      </section> : null}
      {editor.original ? <MemoryContentComparison before={editor.original} after={editor} beforeLabel={`编辑前 v${editor.baseVersion ?? '未知'}`} afterLabel="待保存内容" /> : null}
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
    {view === 'overview' ? <section className="otto-enterprise-memory-map" aria-label="企业记忆地图">
      <header className="otto-enterprise-memory-map__summary"><div><span>企业记忆依据概览</span><h3>记住什么，凭什么使用</h3><p>展示实际记录与待确认事项，不用分数保证准确率。适用场景是建议，不代表已验证或实际调用。</p></div><div className="otto-enterprise-memory-map__counts"><article className="is-trusted"><strong>{memoryHealth.counts.trusted}</strong><span>有确认记录</span></article><article className="is-learning"><strong>{memoryHealth.counts.learning}</strong><span>继续学习</span></article><article className="is-needs_review"><strong>{memoryHealth.counts.needs_review}</strong><span>等待确认</span></article><article className="is-conflicted"><strong>{memoryHealth.counts.conflicted}</strong><span>存在冲突</span></article><article className="is-expired"><strong>{memoryHealth.counts.expired}</strong><span>已经过期</span></article></div></header>
      {memoryHealth.nextAction ? <article className={`otto-enterprise-memory-next is-${memoryHealth.nextAction.status}`}><span>优先核对</span><h3>{memoryHealth.nextAction.question}</h3><p>{memoryHealth.nextAction.reasons.join(' · ')}</p>{role === 'company_admin' ? <button type="button" onClick={() => openHealthNode(memoryHealth.nextAction!)}>{memoryHealth.nextAction.actionLabel}</button> : null}</article> : <article className="otto-enterprise-memory-next is-trusted"><span>当前状态</span><h3>当前没有排队的复核事项</h3><p>这不代表所有结论均已验证。请在真实工作中核对来源，条件变化时及时修订。</p></article>}
      <div className="otto-enterprise-memory-map__nodes">{memoryHealth.nodes.map((node) => <article key={node.id} className={`is-${node.status}`}><header><div><span>{node.category}</span><h3>{node.title}</h3></div><strong>{knowledgeHealthLabel(node.status)}</strong></header><p>{node.reasons.join(' · ')}</p><div className="otto-enterprise-memory-map__usage"><b>{node.useStatus}</b>{node.usageScenarios.map((scenario) => <span key={scenario}>{scenario}</span>)}</div>{role === 'company_admin' ? <button type="button" onClick={() => openHealthNode(node)}>{node.actionLabel}</button> : null}</article>)}{!loading && !memoryHealth.nodes.length ? <p>暂无企业知识。完成真实工作后，Otto 会自动形成待确认候选。</p> : null}</div>
    </section> : null}
    {view === 'questions' ? <section className="otto-enterprise-memory-questions" aria-label="企业记忆待确认问题"><header><span>动态确认队列</span><h3>只处理最影响后续工作的记忆缺口</h3><p>冲突、过期和待发布优先；有确认记录的内容仍可随时复核。</p></header>{memoryHealth.nodes.filter((node) => node.priority > 0).map((node, index) => <article key={node.id} className={`is-${node.status}`}><span>{String(index + 1).padStart(2, '0')}</span><div><header><strong>{node.title}</strong><b>{knowledgeHealthLabel(node.status)}</b></header><h4>{node.question}</h4><p>{node.reasons.join(' · ')}</p><small>可能调用：{node.usageScenarios.join('、')}</small>{role === 'company_admin' ? <button type="button" onClick={() => openHealthNode(node)}>{node.actionLabel}</button> : null}</div></article>)}{!memoryHealth.nodes.some((node) => node.priority > 0) ? <p>当前没有需要人工处理的记忆问题。</p> : null}</section> : null}
    {view === 'timeline' ? <div className="otto-enterprise-memory-timeline" aria-label="企业记忆沿革">{timeline.map(({ item, revision }) => <article key={`${item.id}-${revision.id}`}>
      <time>{formatKnowledgeDate(revision.createdAt)}</time><div><span>{item.department || '全组织'} · {revision.category || item.category} · v{revision.version}</span><strong>{revision.title || item.title || item.category}</strong><p>{revision.content}</p><small>{revision.changedBy || item.contributor || '系统沉淀'} · {revision.changeNote || revision.status || '形成知识'}</small>{revision.adjudication ? <small>裁决依据：{revision.adjudication.rationale} · 采纳 {revision.adjudication.acceptedEvidenceIds.length} 条 · 排除 {revision.adjudication.rejectedEvidenceIds.length} 条</small> : null}</div>
    </article>)}</div> : null}
    {view === 'knowledge' ? <div className="otto-workspace-dialog__list otto-enterprise-memory-list">{visibleItems.map((item) => {
      const contested = Boolean(item.sourceLabel?.includes('证据存在冲突'));
      const expiresAt = Date.parse(item.expiresAt || '');
      const reviewDueAt = Date.parse(item.reviewDueAt || '');
      const expired = Number.isFinite(expiresAt) && expiresAt <= Date.now();
      const reviewDue = !expired && Number.isFinite(reviewDueAt) && reviewDueAt <= Date.now();
      return <article key={item.id} className="otto-enterprise-memory-card">
        <div className="otto-enterprise-memory-card__meta"><span>{item.department || '全组织'}</span><span>{item.category}</span><strong>{enterpriseMemoryUseStatus(item)}</strong><span>{knowledgeSourceLabel(item.sourceType)}</span>{expired ? <strong className="is-expired">已过期</strong> : reviewDue ? <strong className="is-review-due">待复核</strong> : null}</div>
        {item.evidenceCount ? <div className="otto-enterprise-memory-card__evidence"><strong>累计 {item.evidenceCount} 条观察记录</strong><span>{item.distinctSessionCount || 0} 个来源会话</span><span>{item.distinctContributorCount || 0} 名贡献者</span>{item.verifiedEvidenceCount ? <span>{item.verifiedEvidenceCount} 条标记为已验证</span> : null}{item.lastObservedAt ? <span>最近学习 {formatKnowledgeDate(item.lastObservedAt)}</span> : null}</div> : item.sourceType === 'manual' ? <div className="otto-enterprise-memory-card__evidence"><strong>手工补充内容，请结合审核记录核对</strong></div> : null}
        <h3>{item.title || item.category}</h3><p>{item.content}</p><div className="otto-enterprise-memory-card__usage"><b>建议适用场景（不代表已验证）</b>{enterpriseMemoryUsageScenarios(item).map((scenario) => <span key={scenario}>{scenario}</span>)}</div><small>当前 v{item.version ?? '未知'} · 版本增加不代表准确率提高 · {item.contributor || 'Otto 自动学习'} · {formatKnowledgeDate(item.updatedAt || item.createdAt)}</small>
        {item.reviewDueAt || item.expiresAt ? <div className="otto-enterprise-memory-card__lifecycle">{item.reviewDueAt ? <span>复核日期 {formatKnowledgeDate(item.reviewDueAt)}</span> : null}{item.expiresAt ? <span>有效期至 {formatKnowledgeDate(item.expiresAt)}</span> : null}</div> : null}
        {role === 'company_admin' ? <footer>
          {item.sourceType === 'auto_capture' || (item.evidenceCount ?? 0) > 0 ? <button type="button" disabled={Boolean(busyId)} onClick={() => void toggleEvidence(item.id)}>{evidence[item.id] !== undefined ? '收起学习依据' : '查看学习依据'}</button> : null}
          {item.status === 'pending_review' ? <button type="button" disabled={Boolean(busyId) || contested} title={contested ? '请先修订内容并完成冲突裁决' : undefined} onClick={() => void review(item.id, 'approve')}>{contested ? '先裁决冲突' : '确认并让 Otto 使用'}</button> : null}
          <button type="button" disabled={Boolean(busyId) || contested} title={contested ? '请先完成人工冲突裁决' : '让大模型结合学习依据提出建议，保存前仍需管理员确认；分析有条数和长度限制'} onClick={() => void deepenKnowledge(item)}>{busyId === item.id ? '处理中…' : 'AI 深化'}</button>
          <button type="button" disabled={Boolean(busyId) || (contested && !isAdjudicationReady(item.id))} title={contested && !isAdjudicationReady(item.id) ? '请先处理全部冲突证据，并填写至少 12 个字的裁决依据' : undefined} onClick={() => setEditor({ id: item.id, baseVersion: item.version, original: item, title: item.title || item.category, category: item.category, content: item.content, resolveConflict: contested, adjudication: contested ? adjudications[item.id] : undefined })}>{contested ? '审查并裁决' : '人工修改'}</button>
          {item.status === 'active' && !contested ? <button type="button" disabled={Boolean(busyId)} onClick={() => { setEditor(null); setRevalidation({ id: item.id, title: item.title || item.category, rationale: '', validForDays: item.sourceType === 'auto_capture' ? 180 : 365 }); }}>仍然有效</button> : null}
          <button type="button" disabled={Boolean(busyId)} onClick={() => void toggleRevisions(item.id)}>{revisions[item.id] !== undefined ? '收起变化' : '查看变化'}</button><button type="button" disabled={Boolean(busyId)} onClick={() => void review(item.id, 'archive')}>停止使用</button><button className="otto-enterprise-memory-delete" type="button" disabled={Boolean(busyId)} onClick={() => void deleteKnowledge(item)}>永久删除</button>
        </footer> : null}
        {aiInsights[item.id] && editor?.id !== item.id ? <section className="otto-enterprise-memory-insight" aria-label={`${item.title || item.category} 智能体检`}><header><div><span>AI 智能体检</span><strong>{aiInsights[item.id].rationale}</strong></div><small>{aiInsights[item.id].modelProvider}</small></header>{aiInsights[item.id].evidenceGraph?.length ? <div className="otto-enterprise-memory-ai-graph">{aiInsights[item.id].evidenceGraph!.map((node) => <article key={`${node.claim}-${node.status}`} className={`is-${node.status}`}><header><strong>{node.claim}</strong><span>{evidenceClaimStatusLabel(node.status)}</span></header><small>模型判断 · 引用证据 #{node.evidenceIds.join('、#') || '无'}；请在下方学习依据中核对原文</small>{node.explanation ? <p>{node.explanation}</p> : null}{node.gaps.length ? <small>缺口：{node.gaps.join('；')}</small> : null}</article>)}</div> : null}{aiInsights[item.id].applicableScenarios?.length ? <p><b>模型建议适用工作：</b>{aiInsights[item.id].applicableScenarios!.join('、')}</p> : null}{aiInsights[item.id].riskIfWrong ? <p><b>如果记错：</b>{aiInsights[item.id].riskIfWrong}</p> : null}{aiInsights[item.id].nextQuestion ? <div className="otto-enterprise-memory-ai-next"><span>下一条最值得确认的问题</span><strong>{aiInsights[item.id].nextQuestion}</strong></div> : null}<small>本次仅分析，没有自动修改企业记忆；形成新版本仍需管理员保存。</small></section> : null}
        {evidence[item.id] !== undefined ? <div className="otto-enterprise-memory-evidence" aria-label="知识证据明细">
          {evidence[item.id].length === 0 ? <div className="otto-enterprise-memory-evidence__empty">此条知识没有可展示的自动提炼证据。</div> : <>{evidence[item.id].map((entry) => <article key={entry.id}>
            <div className="otto-enterprise-memory-evidence__badges"><span>{entry.stance === 'affirmative' ? '肯定 / 要求' : entry.stance === 'negative' ? '否定 / 禁止' : '中性描述'}</span>{entry.contested ? <strong>涉及冲突</strong> : null}<span>{entry.verified ? '来源记录标记为已验证，仍需核对原文' : '未验证观察'}</span></div>
            <p>{entry.content}</p><small>{entry.contributor || '系统观察'} · {formatKnowledgeDate(entry.observedAt)}</small><small>证据 #{entry.id} · 来源：{entry.sourceId || '来源编号不可用'}</small>{entry.tags.length || entry.impactReasons.length ? <small>{[...entry.tags, ...entry.impactReasons].join(' · ')}</small> : null}
            {contested && entry.contested ? <div className="otto-enterprise-memory-evidence__decision"><button type="button" aria-pressed={adjudications[item.id]?.acceptedEvidenceIds.includes(entry.id) ?? false} onClick={() => setEvidenceDisposition(item.id, entry.id, 'accepted')}>采纳</button><button type="button" aria-pressed={adjudications[item.id]?.rejectedEvidenceIds.includes(entry.id) ?? false} onClick={() => setEvidenceDisposition(item.id, entry.id, 'rejected')}>排除</button></div> : null}
          </article>)}{contested ? <label className="otto-enterprise-memory-evidence__rationale"><span>裁决依据</span><textarea aria-label="裁决依据" rows={3} value={adjudications[item.id]?.rationale ?? ''} onChange={(event) => setAdjudications((current) => ({ ...current, [item.id]: { acceptedEvidenceIds: current[item.id]?.acceptedEvidenceIds ?? [], rejectedEvidenceIds: current[item.id]?.rejectedEvidenceIds ?? [], rationale: event.target.value } }))} placeholder="说明采用哪些正式制度、验证结果或责任人确认作为裁决依据"/><small>已处理 {new Set([...(adjudications[item.id]?.acceptedEvidenceIds ?? []), ...(adjudications[item.id]?.rejectedEvidenceIds ?? [])]).size} / {evidence[item.id].filter((entry) => entry.contested).length} · 必须同时包含采纳和排除结论</small></label> : null}</>}
        </div> : null}
        {revisions[item.id] !== undefined ? <EnterpriseMemoryVersions key={`${item.id}-${item.version}`} current={item} revisions={revisions[item.id]} canRestore={role === 'company_admin' && !contested} busy={Boolean(busyId)} onRestore={(revision, reason) => void restoreKnowledge(item, revision, reason)} /> : null}
      </article>;
    })}{!loading && !items.length ? <p>暂无企业知识。</p> : null}</div> : null}
  </DialogFrame>;
}

export function AutoSkillDialog({ open, candidates, lastAction, onRefresh, onConfirm, onReject, onClose, releases = [], releaseBusy = false, releaseError = null, releaseStatus, onRefreshReleases, onRollback, onRecord }: {
  open: boolean; candidates: AutoSkillCandidateInfo[];
  lastAction: { kind: 'confirmed' | 'rejected'; candidateId: string; savedPath?: string } | null;
  onRefresh(): void; onConfirm(id: string): void; onReject(id: string): void; onClose(): void;
  releases?: InstalledSkillReleases[]; releaseBusy?: boolean; releaseError?: string | null; releaseStatus?: string;
  onRefreshReleases?(): void; onRollback?(input: SkillRollbackInput): void; onRecord?(input: SkillAcceptanceInput): void;
}): React.JSX.Element | null {
  useEffect(() => { if (open) onRefreshReleases?.(); }, [open, onRefreshReleases, lastAction]);
  if (!open) return null;
  return <DialogFrame title="Skill 功能、草稿与版本" size="compact" onClose={onClose}>
    {onRefreshReleases && onRollback && onRecord ? <SkillVersionPanel skills={releases} busy={releaseBusy} error={releaseError} status={releaseStatus} onRefresh={onRefreshReleases} onRollback={onRollback} onRecord={onRecord} /> : null}
    <h2>待确认的新功能与更新</h2><div className="otto-workspace-dialog__toolbar"><p>先说明能做什么，再披露检查与风险。你确认后才安装；安装不代表业务效果已获验证。</p><button type="button" onClick={onRefresh}>立即分析</button></div>{lastAction?.kind === 'confirmed' ? <p role="status">Skill 已确认安装{lastAction.savedPath ? `：${lastAction.savedPath}` : ''}</p> : null}<div className="otto-workspace-dialog__list">{candidates.length ? candidates.map((candidate) => {
    const ready = candidate.draft?.validationPassed === true && candidate.draft.packageReady === true;
    return <article key={candidate.id} aria-label={`${candidate.name} Skill 草稿`}>
      <h3>{candidate.function?.title ?? candidate.name}</h3>
      {candidate.function ? <SkillFunctionCard value={candidate.function} /> : <p>{candidate.description}</p>}
      <small>{candidate.name} · {candidate.source === 'proactive' ? '来自你的需求' : '来自重复工作观察'}{candidate.source === 'automatic' ? ` · ${candidate.occurrenceCount} 次历史观察（不是新功能的测试结果）` : ''}</small>
      <p className="otto-skill-warning">尚未验证业务效果。功能说明是设计目标，不是生产级保证；本次没有自动运行行为测试。</p>
      {candidate.draft ? <div className="otto-auto-skill-draft-audit">
        <p><strong>{ready ? '静态检查通过，等待确认试用' : '检查未通过，禁止安装'}</strong>{candidate.draft.packageRelativePath ? ` · 已打包 ${candidate.draft.packageRelativePath}` : ''}</p>
        <details><summary>文件变更（{candidate.draft.risk.fileChanges.length}）</summary><ul>{candidate.draft.risk.fileChanges.map((change) => <li key={change}>{change}</li>)}</ul></details>
        <details><summary>权限（{candidate.draft.risk.permissions.length}）</summary>{candidate.draft.risk.permissions.length ? <ul>{candidate.draft.risk.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul> : <p>未发现额外权限。</p>}</details>
        <details><summary>安全风险（{candidate.draft.risk.securityRisks.length}）</summary>{candidate.draft.risk.securityRisks.length ? <ul>{candidate.draft.risk.securityRisks.map((risk) => <li key={risk}>{risk}</li>)}</ul> : <p>本次静态检查未发现已识别的风险，不等于不存在风险。</p>}</details>
        <details><summary>测试与校验（{candidate.draft.tests.length}）</summary><ul>{candidate.draft.tests.map((test) => <li key={test.name}>{test.status === 'passed' ? '通过' : test.status === 'failed' ? '失败' : '需人工确认'} · {test.name}：{test.detail}</li>)}</ul>{candidate.draft.validationErrors.map((error) => <p role="alert" key={error}>{error}</p>)}</details>
        {candidate.draft.risk.executionBlocked ? <p role="note">此草稿包含脚本：生成、打包和安装均不会执行；以后首次执行仍需单独授权。</p> : null}
      </div> : <p role="alert">旧候选尚未生成受控草稿；确认时会先完成校验和打包。</p>}
      <footer><button type="button" disabled={candidate.draft ? !ready : false} onClick={() => onConfirm(candidate.id)}>{candidate.recommendation === 'enhance' ? '确认更新并试用' : '确认安装'}</button><button type="button" onClick={() => onReject(candidate.id)}>拒绝草稿</button></footer>
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
