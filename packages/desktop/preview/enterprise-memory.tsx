/** Local visual fixture: fictional knowledge; no enterprise, model, or filesystem mutation. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { EnterpriseMemoryDialog } from '../src/renderer/components/WorkspaceDialogs.js';
import '../src/renderer/styles/tokens.css';
import '../src/renderer/styles/app.css';
document.documentElement.dataset.ottoTheme = new URLSearchParams(location.search).get('theme') === 'light' ? 'light' : 'dark';

const base = { organizationId: 'preview-only', department: '交付部', sourceType: 'auto_capture', confidence: 0.82, createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-03T08:00:00Z', contributor: '演示负责人', expiresAt: '2027-09-01T08:00:00Z' };
let items = [{ ...base, id: '12', title: '客户交付前检查', category: '交付流程', content: '交付前核对清单、完成安全扫描，并保留扫描报告。\n适用于本部门标准交付项目；合同有额外要求时需单独核对。', version: 3, status: 'active', evidenceCount: 3, verifiedEvidenceCount: 1, distinctSessionCount: 2, distinctContributorCount: 2 }];
const history = [{ id: '12-v1', version: 1, title: '客户交付前检查', category: '交付流程', content: '交付前核对清单并完成安全扫描。', changedBy: '演示负责人', changeNote: '根据试点交付记录整理，待复核报告留存规则', createdAt: '2026-09-01T08:00:00Z' }];
Object.assign(window, { otto: {
  enterpriseKnowledgeList: async () => items,
  enterpriseKnowledgeRevisions: async () => history,
  enterpriseKnowledgeEvidence: async () => [{ id: '41', knowledgeId: '12', sourceId: '演示项目复盘-01', content: '已核对试点项目的扫描报告，交付材料需要随附报告。', contributor: '演示负责人', confidence: 0.8, verified: true, observedAt: '2026-09-01T08:00:00Z', tags: ['试点项目'], impactReasons: [], stance: 'affirmative', contested: false }],
  enterpriseKnowledgeRevise: async (id: string, input: { restoreVersion?: number; expectedVersion?: number }) => {
    if (id !== '12' || input.expectedVersion !== items[0].version) throw new Error('演示版本已变化');
    items = [{ ...items[0], content: history[0].content, status: 'pending_review', version: items[0].version + 1 }];
    return items[0];
  },
  enterpriseKnowledgeReview: async () => { items = [{ ...items[0], status: 'active', version: items[0].version + 1 }]; return items[0]; },
  enterpriseKnowledgeAnalyze: async () => ({ shouldUpdate: true, title: items[0].title, category: items[0].category, content: items[0].content + '\n报告保存期限需负责人确认。', confidence: 0.9, rationale: '建议明确尚未确认的报告保存期限，避免当作既定制度。', changes: ['补充待确认条件'], uncertainties: ['未提供保存期限的正式制度'], usedEvidenceIds: ['41'], evidenceGraph: [{ claim: '交付材料随附报告', status: 'partially_supported', evidenceIds: ['41'], explanation: '仅有试点项目复盘记录，不能泛化为所有合同要求。', gaps: ['缺少正式制度'], nextQuestion: '是否有当前有效的报告留存制度？' }], applicableScenarios: ['标准交付材料检查（建议场景）'], riskIfWrong: '可能遗漏合同专属要求', nextQuestion: '是否有当前有效的报告留存制度？', modelProvider: '演示数据 · 未调用模型', inputTokens: 0, outputTokens: 0 }),
} });
function Preview() {
  const [open, setOpen] = useState(true);
  return <><p>企业记忆界面预览 · 全部为虚构数据</p><button onClick={() => setOpen(true)}>打开企业记忆</button><EnterpriseMemoryDialog open={open} role="company_admin" onClose={() => setOpen(false)} /></>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
