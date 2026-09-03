/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { useState } from 'react';
import type { PolicyAction, PolicyFeedback } from 'otto-server';
const OUTCOMES = {
  submitted: '已提交申报',
  approved: '已获批',
  rejected: '未通过',
  dispute: '判断有误／我要纠错',
};
const REASONS = {
  none: '无／暂不适用',
  eligibility: '资格条件',
  materials: '材料问题',
  quota: '名额或额度不足',
  competition: '竞争或择优排序',
  other: '其他',
};
export function PolicyFeedbackForm({
  policyId,
  record,
  revision,
  loading,
  submit,
}: {
  policyId: string;
  record?: PolicyFeedback;
  revision: number;
  loading: boolean;
  submit(action: PolicyAction): Promise<void>;
}): React.JSX.Element {
  const [outcome, setOutcome] = useState<PolicyFeedback['outcome']>(
    record?.outcome ?? 'submitted',
  );
  const [reason, setReason] = useState<PolicyFeedback['reason']>(
    record?.reason ?? 'none',
  );
  const [note, setNote] = useState(record?.note ?? '');
  const [confirmed, setConfirmed] = useState(false);
  const needsReason = outcome === 'rejected' || outcome === 'dispute';
  return (
    <section className="otto-policy-v2__feedback">
      <h4>申报反馈与判断纠错</h4>
      <p>
        仅记录实际情况，不替你提交申请。名额、材料、竞争等原因不会自动变成资格排除规则。
      </p>
      {record && (
        <p role="status">
          已记录：{OUTCOMES[record.outcome]} ·{' '}
          {record.reviewStatus === 'pending'
            ? '待核实（尚未接入人工处理服务，不代表已接单）'
            : '仅作申报记录'}{' '}
          · 第 {record.revision} 次更新
        </p>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (confirmed)
            void submit({
              action: 'feedback',
              policyId,
              revision,
              consent: true,
              feedback: { outcome, reason, note },
            });
        }}
      >
        <label>
          反馈类型
          <select
            value={outcome}
            onChange={(event) => {
              setOutcome(event.target.value as PolicyFeedback['outcome']);
              setConfirmed(false);
            }}
          >
            {Object.entries(OUTCOMES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          反馈原因
          <select
            value={reason}
            onChange={(event) => {
              setReason(event.target.value as PolicyFeedback['reason']);
              setConfirmed(false);
            }}
          >
            {Object.entries(REASONS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="is-wide">
          依据或情况说明
          <textarea
            rows={3}
            maxLength={2000}
            value={note}
            placeholder="例如：因本批次名额已满未通过；或说明你认为哪条判断不准确。请勿填写无关个人信息。"
            onChange={(event) => {
              setNote(event.target.value);
              setConfirmed(false);
            }}
          />
        </label>
        <label className="otto-policy-v2__check is-wide">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          我确认以上信息及本次保存或删除操作，仅在当前账号留存，不修改官方规则。
        </label>
        <div className="is-wide">
          <button
            type="submit"
            disabled={
              loading ||
              !confirmed ||
              (needsReason && (reason === 'none' || !note.trim()))
            }
          >
            保存反馈记录
          </button>{' '}
          {record && (
            <button
              type="button"
              disabled={loading || !confirmed}
              onClick={() =>
                void submit({
                  action: 'delete-feedback',
                  policyId,
                  revision,
                  consent: true,
                })
              }
            >
              删除反馈记录
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
