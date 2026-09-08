/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

export type ChannelIdentityMutationBody = {
  action: 'claim-owner' | 'bind' | 'revoke';
  providerUserId: string;
  canonicalUserId?: string;
  approvalId: string;
  expectedRevision: number;
};

export function isChannelInstallationId(value: unknown): value is string {
  return typeof value === 'string'
    && /^channel_(feishu|lark|wecom|dingtalk)_[a-f0-9]{24}$/.test(value);
}

export function parseChannelIdentityMutationIpc(
  installationId: unknown,
  input: unknown,
): { ok: true; installationId: string; body: ChannelIdentityMutationBody }
  | { ok: false; error: string } {
  if (!isChannelInstallationId(installationId) || !input || typeof input !== 'object') {
    return { ok: false, error: '身份绑定请求不合法。' };
  }
  const candidate = input as Record<string, unknown>;
  const action = candidate.action;
  const readText = (name: string): string =>
    typeof candidate[name] === 'string' ? candidate[name].trim() : '';
  const providerUserId = readText('providerUserId');
  const canonicalUserId = readText('canonicalUserId');
  const approvalId = readText('approvalId');
  const expectedRevision = candidate.expectedRevision;
  if ((action !== 'claim-owner' && action !== 'bind' && action !== 'revoke') || !providerUserId || providerUserId.length > 200
    || (action === 'bind' && (!canonicalUserId || canonicalUserId.length > 200))
    || (action !== 'claim-owner' && (!approvalId || approvalId.length > 200))
    || !Number.isSafeInteger(expectedRevision) || (expectedRevision as number) < 0) {
    return { ok: false, error: '身份绑定字段不完整或不合法。' };
  }
  return {
    ok: true,
    installationId,
    body: {
      action,
      providerUserId,
      ...(action === 'bind' ? { canonicalUserId } : {}),
      ...(action !== 'claim-owner' ? { approvalId } : { approvalId: 'local-owner-claim' }),
      expectedRevision: expectedRevision as number,
    },
  };
}
