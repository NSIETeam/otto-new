/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import { describe, expect, it } from 'vitest';
import { parseChannelIdentityMutationIpc } from './channel-identity-ipc.js';

const installationId = 'channel_wecom_0123456789abcdef01234567';

describe('parseChannelIdentityMutationIpc', () => {
  it('returns a bounded bind request and drops untrusted tenant fields', () => {
    expect(parseChannelIdentityMutationIpc(installationId, {
      action: 'bind', providerUserId: ' wm_user_1 ', canonicalUserId: ' otto-user-1 ',
      approvalId: ' approval-1 ', approvedBy: ' spoofed-admin ', expectedRevision: 0,
      tenantId: 'tenant-attacker',
    })).toEqual({
      ok: true,
      installationId,
      body: {
        action: 'bind', providerUserId: 'wm_user_1', canonicalUserId: 'otto-user-1',
        approvalId: 'approval-1', expectedRevision: 0,
      },
    });
  });

  it('rejects malformed installations, incomplete approvals and negative revisions', () => {
    expect(parseChannelIdentityMutationIpc('channel_wecom_bad', {})).toMatchObject({ ok: false });
    expect(parseChannelIdentityMutationIpc(installationId, {
      action: 'bind', providerUserId: 'wm_user_1', expectedRevision: 0,
    })).toMatchObject({ ok: false });
    expect(parseChannelIdentityMutationIpc(installationId, {
      action: 'revoke', providerUserId: 'wm_user_1', approvalId: 'approval-1',
      expectedRevision: -1,
    })).toMatchObject({ ok: false });
  });
});
