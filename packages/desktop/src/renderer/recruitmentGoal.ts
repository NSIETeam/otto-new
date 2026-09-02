/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

export function inferRecruitmentJobTitle(goal: string): string {
  const normalized = goal.replace(/\s+/gu, ' ').trim();
  const role = /(?:招|招聘|需要)(?:一|两|三|\d+)?(?:名|位|个)?\s*([^，。；;]{2,30}?(?:工程师|设计师|产品经理|运营|销售|会计|专员|负责人|助理|主管|经理))/u.exec(normalized)?.[1];
  if (role) return role.trim();
  return normalized.split(/[，。；;\n]/u)[0]?.slice(0, 30).trim() || '待分析岗位';
}

export function looksLikeNaturalRecruitmentGoal(text: string): boolean {
  return /(?:我要|我们要|准备|计划|正在|想要|需要).{0,8}(?:招|招聘)|(?:招|招聘).{0,30}(?:工程师|设计师|产品经理|运营|销售|会计|专员|负责人|助理|主管|经理)/u.test(text);
}
