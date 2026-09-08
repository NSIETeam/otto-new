/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  OfficialPolicyDocument,
  PolicyActor,
  PolicyInbox,
  PolicyNotice,
} from './contracts.js';
import { policyDate, policyHash } from './policyDomain.js';
import { PolicyOperationError } from './policyErrors.js';
import type { PolicyStore } from './policyStore.js';

export interface PolicyMailbox {
  accountId: string;
  organizationId: string;
  watches: Record<
    string,
    { fingerprint: string; deadline?: string; version: number }
  >;
  notices: PolicyNotice[];
}
export const policyMailboxKey = (actor: PolicyActor): string =>
  `policy-inbox:${policyHash([actor.organizationId, actor.id])}`;
const fingerprint = (doc: OfficialPolicyDocument): string =>
  policyHash([doc.contentHash, doc.deadline, doc.governance]);
export const emptyPolicyMailbox = (actor: PolicyActor): PolicyMailbox => ({
  accountId: actor.id,
  organizationId: actor.organizationId,
  watches: {},
  notices: [],
});
export function policyInboxView(mailbox: PolicyMailbox): PolicyInbox {
  return {
    notices: [...mailbox.notices].reverse(),
    unreadCount: mailbox.notices.filter((n) => !n.readAt).length,
    watchedPolicyIds: Object.keys(mailbox.watches),
  };
}
export async function watchPolicy(
  store: PolicyStore,
  actor: PolicyActor,
  doc: OfficialPolicyDocument,
  enabled: boolean,
): Promise<void> {
  await store.update<PolicyMailbox>(policyMailboxKey(actor), (current) => {
    const mailbox = current ?? emptyPolicyMailbox(actor);
    if (enabled && !mailbox.watches[doc.id]) {
      if (Object.keys(mailbox.watches).length >= 100)
        throw new PolicyOperationError(
          '最多关注100项政策，请先取消不再需要的提醒',
        );
      mailbox.watches[doc.id] = {
        fingerprint: fingerprint(doc),
        deadline: doc.deadline,
        version: doc.version,
      };
    } else if (!enabled) delete mailbox.watches[doc.id];
    return mailbox;
  });
}
// One atomic mailbox transaction preserves concurrent read acknowledgements and
// makes scheduler retries / multiple server processes idempotent. No model calls.
export function advancePolicyMailbox(
  mailbox: PolicyMailbox,
  documents: OfficialPolicyDocument[],
  now: Date,
): PolicyMailbox {
  const add = (
    doc: OfficialPolicyDocument,
    kind: PolicyNotice['kind'],
    event: string,
    body: string,
  ): void => {
    const id = policyHash([doc.id, kind, event]);
    if (mailbox.notices.some((n) => n.id === id)) return;
    mailbox.notices.push({
      id,
      policyId: doc.id,
      policyTitle: doc.title,
      url: doc.url,
      kind,
      body,
      createdAt: now.toISOString(),
      policyVersion: doc.version,
    });
  };
  for (const doc of documents) {
    const watch = mailbox.watches[doc.id];
    if (!watch || doc.sourceStatus !== 'verified') continue;
    const next = fingerprint(doc);
    if (watch.fingerprint !== next) {
      add(
        doc,
        'changed',
        next,
        `关注的政策原文已更新（版本 ${watch.version} → ${doc.version}）。${watch.deadline !== doc.deadline ? `截止时间：${watch.deadline ?? '待核验'} → ${doc.deadline ?? '待核验'}。` : ''}请重新核对条件、材料和原文，旧诊断不能直接用于本批次申报。`,
      );
      mailbox.watches[doc.id] = {
        fingerprint: next,
        version: doc.version,
        deadline: doc.deadline,
      };
    }
    // A pending/partial extraction is not authority for an application deadline.
    if (
      doc.interpretationStatus !== 'ready' ||
      doc.attachments.some((a) => !a.parsed) ||
      doc.referenceOnly ||
      doc.governance
    )
      continue;
    const deadline = policyDate(doc.deadline, true);
    if (deadline === undefined) continue;
    const days = (deadline - now.getTime()) / 86_400_000;
    const window =
      days <= 0
        ? 'closed'
        : days <= 1
          ? '1'
          : days <= 3
            ? '3'
            : days <= 7
              ? '7'
              : undefined;
    if (!window) continue;
    add(
      doc,
      window === 'closed' ? 'closed' : 'deadline',
      `${doc.deadline}:${window}`,
      window === 'closed'
        ? `本批次已到截止日期 ${doc.deadline}，请核对官方受理状态；不要继续使用已截止批次申报。`
        : `本批次截止日期为 ${doc.deadline}（北京时间），已进入最后 ${window} 天。请核对材料及官方原文中的具体受理时刻；提醒不代替申报。`,
    );
  }
  return mailbox;
}
