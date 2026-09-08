/** Local visual fixture. Fictional reviews; never connects to a model or production data. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AutoSkillDialog } from '../src/renderer/components/WorkspaceDialogs.js';
import type { InstalledSkillReleases } from 'otto-server';
import '../src/renderer/styles/tokens.css';
import '../src/renderer/styles/app.css';
const card = {
  title: '销售月报助手',
  summary: '把销售明细整理成月报，列出缺失数据和异常金额，供负责人复核。',
  inputs: ['销售明细表、统计月份及输出格式'],
  outputs: ['月报文件、数据来源和待确认事项'],
  scope: ['已授权的本地销售表格'],
  boundaries: ['不代替财务审计，不擅自发送客户资料。'],
};
const current: InstalledSkillReleases['current'] = {
  id: 'b'.repeat(64),
  capturedAt: '2026-09-03T08:00:00Z',
  function: card,
  files: {
    'SKILL.md': 'new',
    'scripts/check.cjs': 'script',
    'references/template.txt': 'new',
  },
  staticValidation: { passed: true, errors: [], warnings: [] },
  acceptance: [],
};
const releases: InstalledSkillReleases[] = [
  {
    skillName: 'sales-report',
    current,
    history: [
      {
        ...current,
        id: 'a'.repeat(64),
        files: { 'SKILL.md': 'old', 'references/template.txt': 'old' },
      },
    ],
    comparison: {
      addedFiles: ['scripts/check.cjs'],
      changedFiles: ['SKILL.md', 'references/template.txt'],
      removedFiles: [],
      improved: [],
      regressed: [],
      comparableCases: 0,
      businessVerdict: 'insufficient-evidence',
    },
    warnings: [],
  },
];
function Preview() {
  const [status, setStatus] = useState(
    '界面验收演示：虚构数据，不连接真实账号或大模型。',
  );
  return (
    <AutoSkillDialog
      open
      candidates={[
        {
          id: 'sample-1',
          name: 'meeting-notes-helper',
          function: {
            ...card,
            title: '会议纪要助手',
            summary:
              '从会议记录提炼决定、责任人和待办事项，列出尚未明确的截止时间。',
            inputs: ['会议记录、参会人员和本次议题'],
            outputs: ['会议决定、待办清单和未明确的事项'],
            scope: ['已经授权整理的会议文字记录'],
            boundaries: ['不猜测未明确的责任人，不擅自创建日程或发送通知。'],
          },
          description: '整理会议纪要',
          detectedPattern: '重复会议',
          occurrenceCount: 3,
          reason: '重复工作',
          source: 'automatic',
          recommendation: 'create',
        },
      ]}
      lastAction={null}
      releases={releases}
      releaseStatus={status}
      onRefreshReleases={() => undefined}
      onRollback={() => setStatus('演示回滚已确认；未修改任何真实 Skill。')}
      onRecord={() => setStatus('演示复核已确认；未保存任何真实记录。')}
      onRefresh={() => undefined}
      onConfirm={() => undefined}
      onReject={() => undefined}
      onClose={() => undefined}
    />
  );
}
createRoot(document.getElementById('root')!).render(<Preview />);
