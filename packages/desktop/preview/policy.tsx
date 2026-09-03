/** Visual fixture only: fictional policies, no network or paid model calls. */
import React from 'react';
import { createRoot } from 'react-dom/client';
import { PolicyIntelligenceDialog } from '../src/renderer/components/PolicyIntelligenceDialog.js';
import { emptyPolicyState } from '../src/renderer/policyIntelligencePresentation.js';
import type { PolicyIntelligenceState } from '../src/preload/index.js';
import '../src/renderer/styles/app.css';
import '../src/renderer/styles/tokens.css';
const state: PolicyIntelligenceState = {
  ...emptyPolicyState(),
  enabled: true,
  canManage: true,
  modelName: '视觉测试（无模型调用）',
  profile: {
    organizationName: '演示科技有限公司',
    registeredRegion: '上海市浦东新区',
    industry: '软件服务',
    mainBusiness: '工业数字化软件',
    enterpriseType: '有限责任公司',
    establishedAt: '2020-01-01',
    qualifications: ['科技型中小企业'],
  },
  region: {
    country: 'CN',
    province: '上海市',
    city: '上海市',
    district: '浦东新区',
  },
  coverage: [
    {
      level: 'district',
      regionLabel: '浦东新区',
      sourceCount: 0,
      status: 'missing',
    },
    {
      level: 'city',
      regionLabel: '上海市',
      sourceCount: 1,
      status: 'configured',
    },
    {
      level: 'national',
      regionLabel: '国家级',
      sourceCount: 2,
      status: 'configured',
    },
  ],
  categories: ['数字化转型', '绿色金融', '知识产权'],
  policies: ['数字化转型', '绿色金融', '知识产权'].map((category, index) => ({
    id: 'demo-' + index,
    title: '【虚构测试】' + category + '支持项目',
    url: 'https://www.gov.cn/',
    sourceName: '演示官方来源 · 非真实政策',
    sourceId: 'demo',
    issuer: '演示部门',
    level: index === 0 ? 'city' : 'national',
    region: { country: 'CN', ...(index === 0 ? { city: '上海市' } : {}) },
    categories: [category],
    deadline: '2027-10-01',
    fetchedAt: new Date().toISOString(),
    version: 1,
    contentHash: 'demo',
    bodyText: '营业收入不少于100万元。申报需要收入证明。',
    summary:
      '演示如何查看政策内容、准备材料，并通过问答核实企业与条件的差距。此页面仅用于界面测试。',
    supportText: '演示支持内容，不构成真实申报依据。',
    conditions: [
      {
        id: 'income',
        label: '营业收入达到门槛',
        quote: '营业收入不少于100万元',
        factKeys: ['annualRevenueCny'],
      },
    ],
    conditionTree: { all: ['income'] },
    materials: [
      { id: 'proof', label: '年度收入证明', quote: '申报需要收入证明' },
    ],
    resources: [],
    attachments: [],
    sourceStatus: 'verified',
    interpretationStatus: 'ready',
    interpretationVersion: 3,
    exclusionsReviewed: true,
    exclusions: [
      {
        id: 'credit',
        label: '失信限制与信用修复例外',
        quote: '严重失信企业不予支持；已完成信用修复且符合规定的除外。',
        when: {
          field: 'blacklisted',
          operator: 'eq',
          value: true,
          quote: '严重失信企业不予支持',
        },
        unless: {
          field: 'repaired',
          operator: 'eq',
          value: true,
          quote: '已完成信用修复且符合规定的除外',
        },
      },
    ],
  })),
};
Object.assign(window, {
  otto: {
    policyIntelligenceGet: async () => structuredClone(state),
    policyIntelligenceAction: async () => {
      throw new Error('视觉测试不执行后台操作');
    },
    openExternal: async () => undefined,
  },
});
document.documentElement.dataset.ottoTheme =
  new URLSearchParams(location.search).get('theme') === 'dark'
    ? 'dark'
    : 'light';
createRoot(document.getElementById('root')!).render(
  <React.Fragment>
    <p>仅供视觉自检：虚构示例，不是已抓取政策。</p>
    <PolicyIntelligenceDialog
      open
      scopeId="visual:demo"
      seedProfile={{}}
      onClose={() => undefined}
    />
  </React.Fragment>,
);
