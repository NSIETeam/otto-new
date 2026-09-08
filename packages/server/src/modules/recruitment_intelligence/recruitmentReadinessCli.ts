#!/usr/bin/env node
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readWorkableAcceptanceApproval } from './workableAcceptance.js';
import { createRecruitmentResumeReader } from './recruitmentResumeReader.js';
import { resolveRecruitmentBackgroundModel } from './recruitmentBackgroundModel.js';
import { readRecruitmentOrganizationBudget } from './recruitmentUsageLedger.js';
import type { WorkableRecruitmentScope } from './workableRecruitmentAdapter.js';

interface ReadinessCheck { id: string; status: 'configured' | 'missing' | 'invalid'; message: string }
/** Pure configuration check. No grant reads, network requests, migrations or model calls. */
export function inspectRecruitmentReadiness(env: NodeJS.ProcessEnv, scope: WorkableRecruitmentScope, now = Date.now()) {
  const checks: ReadinessCheck[] = [];
  checks.push({ id: 'oauth_entry', status: env.OTTO_WORKABLE_OAUTH_ENABLED === '1' ? 'configured' : 'missing', message: '官方浏览器授权入口开关；不代表本人已登录' });
  checks.push({ id: 'sample_approval', status: readWorkableAcceptanceApproval(env, scope, now) ? 'configured' : env.OTTO_WORKABLE_ACCEPTANCE_SCOPES ? 'invalid' : 'missing', message: '必须精确匹配测试企业、本人、岗位，并在未来七天内到期；不代表生产验收' });
  let origins: ReadinessCheck['status'] = 'missing';
  if (env.OTTO_WORKABLE_RESUME_ORIGINS) {
    try {
      const value: unknown = JSON.parse(env.OTTO_WORKABLE_RESUME_ORIGINS);
      if (!Array.isArray(value) || !value.length || value.length > 20 || !value.every((item) => typeof item === 'string')) throw new Error();
      createRecruitmentResumeReader({ approvedOrigins: value }); origins = 'configured';
    } catch { origins = 'invalid'; }
  }
  checks.push({ id: 'resume_origins', status: origins, message: '已审核的附件 HTTPS origin 配置；未连接或下载附件' });
  checks.push({ id: 'model_route', status: resolveRecruitmentBackgroundModel(scope.organizationId, env) ? 'configured' : env.OTTO_RECRUITMENT_BACKGROUND_ANALYSIS_ENABLED === '1' ? 'invalid' : 'missing', message: '企业专用模型与数据处理批准配置；未调用模型，也未验证厂商协议、预算或账单' });
  checks.push({ id: 'organization_budget', status: readRecruitmentOrganizationBudget(scope.organizationId, env) ? 'configured' : env.OTTO_RECRUITMENT_ORGANIZATION_BUDGETS ? 'invalid' : 'missing', message: '企业所有服务器招聘后台岗位共用的每日预留额度；不包含桌面端自带模型，不是人民币账单保证' });
  let postgres: ReadinessCheck['status'] = 'missing';
  if (env.OTTO_POSTGRES_URL) {
    try { const url = new URL(env.OTTO_POSTGRES_URL); postgres = ['postgres:', 'postgresql:'].includes(url.protocol) && Boolean(url.hostname) && url.pathname.length > 1 ? 'configured' : 'invalid'; }
    catch { postgres = 'invalid'; }
  }
  checks.push({ id: 'postgres_connection', status: postgres, message: 'PostgreSQL 连接串语法检查；未连接数据库，未验收 TLS、迁移、两个实例或恢复' });
  return { kind: 'otto-recruitment-offline-preflight-v1', checkedAt: new Date(now).toISOString(),
    networkUsed: false, databaseConnected: false, modelInvoked: false, liveAcceptance: 'not_run', checks,
    notice: '仅检查当前进程环境，不代表远端服务器配置。配置齐全不等于通过验收。本检查不会读取账号、设置生产批准、启动任务或修改配置。' };
}
const usage = '用法：npm run recruitment:check -- --org <企业ID> --actor <账号ID> --job <共享岗位ID>\n仅检查当前进程环境配置，不接受令牌参数、不访问网络。';
export function runRecruitmentReadinessCli(args: string[], env: NodeJS.ProcessEnv = process.env, write: (text: string) => void = console.log): number {
  if (!args.length || (args.length === 1 && args[0] === '--help')) { write(usage); return 0; }
  const fields = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i]; const value = args[i + 1];
    if (!['--org', '--actor', '--job'].includes(flag) || fields.has(flag) || !value || !/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/u.test(value)) { write(usage); return 2; }
    fields.set(flag, value);
  }
  if (fields.size !== 3) { write(usage); return 2; }
  const report = inspectRecruitmentReadiness(env, { organizationId: fields.get('--org')!, actorAccountId: fields.get('--actor')!, requisitionId: fields.get('--job')! });
  write(JSON.stringify(report, null, 2)); return report.checks.every((entry) => entry.status === 'configured') ? 0 : 2;
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = runRecruitmentReadinessCli(process.argv.slice(2));
