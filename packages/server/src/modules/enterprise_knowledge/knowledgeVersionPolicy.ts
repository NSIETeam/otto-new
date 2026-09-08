/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export class KnowledgeVersionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 409 = 400,
  ) {
    super(message);
    this.name = 'KnowledgeVersionError';
  }
}

export function checkKnowledgeVersion(
  currentVersion: number,
  expectedVersion: unknown,
  restoreVersion?: unknown,
): void {
  if (
    expectedVersion !== undefined &&
    (!Number.isSafeInteger(expectedVersion) || Number(expectedVersion) < 1)
  ) {
    throw new KnowledgeVersionError('expectedVersion 必须是正整数');
  }
  if (expectedVersion !== undefined && currentVersion !== expectedVersion) {
    throw new KnowledgeVersionError(
      '企业记忆版本已变化，请刷新后重新比较，不会覆盖他人的修改。',
      409,
    );
  }
  if (restoreVersion === undefined) return;
  if (expectedVersion === undefined)
    throw new KnowledgeVersionError('恢复历史内容必须提供 expectedVersion');
  if (
    !Number.isSafeInteger(restoreVersion) ||
    Number(restoreVersion) < 1 ||
    Number(restoreVersion) >= currentVersion
  ) {
    throw new KnowledgeVersionError('请选择早于当前版本的历史版本');
  }
}

export function knowledgeRestoreNote(value: unknown, version: number): string {
  if (
    typeof value !== 'string' ||
    value.trim().length < 12 ||
    value.trim().length > 400
  ) {
    throw new KnowledgeVersionError(
      '恢复依据请填写 12–400 个字，说明为什么需要恢复旧内容',
    );
  }
  return `恢复历史 v${version} 的内容，待重新确认：${value.trim()}`;
}
