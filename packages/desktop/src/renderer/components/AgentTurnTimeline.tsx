/**
 * @license
 * Copyright 2026 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import type {
  AgentTurnItem,
  AgentTurnItemStatus,
  AgentTurnSnapshot,
  TurnVerificationCheck,
} from 'otto-server';

function statusLabel(status: AgentTurnItemStatus): string {
  switch (status) {
    case 'in_progress':
      return '进行中';
    case 'awaiting_confirmation':
      return '等待确认';
    case 'completed':
      return '已完成';
    case 'cancelled':
      return '已停止';
    case 'failed':
      return '需要处理';
    default:
      return '待处理';
  }
}

function itemDetail(item: AgentTurnItem): string | undefined {
  if (item.type === 'control') {
    const execution = {
      direct: '直接回答',
      tool_assisted: '工具辅助',
      parallel_read: '并行读取',
      planned: '计划执行',
      restricted: '受限执行',
    }[item.executionMode];
    const risk = {
      read_only: '只读',
      local_write: '本地写入',
      external_write: '外部写入',
      destructive: '破坏性操作',
    }[item.riskLevel];
    return `${execution} · ${risk}`;
  }
  if (item.type === 'tool_group') {
    if (item.awaitingConfirmation > 0) {
      return `${item.awaitingConfirmation} 项等待你的确认`;
    }
    if (item.failed > 0) {
      return `${item.total} 项中 ${item.failed} 项未完成`;
    }
    return `${item.completed}/${item.total} 项已完成`;
  }
  if (item.type === 'artifact') return item.path;
  if (item.type === 'verification') {
    const passed = item.verification.checks.filter(
      (check) => check.status === 'passed',
    ).length;
    return `${passed}/${item.verification.checks.length} 项成功条件已满足`;
  }
  if (item.type === 'stage' || item.type === 'notice') return item.detail;
  return undefined;
}

function verificationStatusLabel(
  status: TurnVerificationCheck['status'],
): string {
  switch (status) {
    case 'passed':
      return '已满足';
    case 'failed':
      return '未通过';
    case 'not_run':
      return '未验证';
    default:
      return '待验证';
  }
}

function TimelineItem({ item }: { item: AgentTurnItem }): React.JSX.Element {
  const detail = itemDetail(item);
  return (
    <li className={`otto-turn-item otto-turn-item--${item.status}`}>
      <span className="otto-turn-item__dot" aria-hidden="true" />
      <div className="otto-turn-item__content">
        <div className="otto-turn-item__line">
          <span className="otto-turn-item__label">{item.label}</span>
          <span className="otto-turn-item__status">
            {statusLabel(item.status)}
          </span>
        </div>
        {detail ? <div className="otto-turn-item__detail">{detail}</div> : null}
        {item.type === 'plan' ? (
          <ol className="otto-turn-plan">
            {item.steps.map((step) => (
              <li
                key={step.id}
                className={`otto-turn-plan__step otto-turn-plan__step--${step.status}`}
              >
                <span className="otto-turn-plan__mark" aria-hidden="true" />
                <span>{step.label}</span>
              </li>
            ))}
          </ol>
        ) : null}
        {item.type === 'verification' ? (
          <ul className="otto-turn-verification" aria-label="成功条件验证">
            {item.verification.checks.map((check) => (
              <li
                key={check.id}
                className={`otto-turn-verification__check otto-turn-verification__check--${check.status}`}
              >
                <span>{check.label}</span>
                <span className="otto-turn-verification__status">
                  {verificationStatusLabel(check.status)}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

export function AgentTurnTimeline({
  turn,
}: {
  turn: AgentTurnSnapshot;
}): React.JSX.Element | null {
  const citations = turn.citations ?? [];
  const artifacts = turn.artifacts ?? [];
  if (
    turn.items.length === 0 &&
    citations.length === 0 &&
    artifacts.length === 0
  )
    return null;
  return (
    <div className="otto-turn-summary">
      {turn.items.length > 0 ? (
        <ol className="otto-turn-timeline" aria-label="Otto 处理进度">
          {turn.items.map((item) => (
            <TimelineItem key={item.id} item={item} />
          ))}
        </ol>
      ) : null}
      {artifacts.length > 0 ? (
        <section className="otto-turn-references" aria-label="本轮产物">
          <h4>本轮产物</h4>
          <ul>
            {artifacts.map((artifact) => (
              <li key={artifact.id}>
                <span className="otto-turn-references__label">
                  {artifact.label}
                </span>
                {artifact.path ? (
                  <span
                    className="otto-turn-references__meta"
                    title={artifact.path}
                  >
                    {artifact.path}
                  </span>
                ) : null}
                <span
                  className={`otto-turn-references__state otto-turn-references__state--${artifact.verified ? 'verified' : 'pending'}`}
                >
                  {artifact.verified ? '已验证' : '待验证'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {citations.length > 0 ? (
        <section className="otto-turn-references" aria-label="引用来源">
          <h4>引用来源</h4>
          <ul>
            {citations.map((citation) => (
              <li key={citation.id}>
                {citation.uri ? (
                  <a
                    href={citation.uri}
                    onClick={(event) => {
                      event.preventDefault();
                      void window.otto?.openExternal?.(citation.uri!);
                    }}
                  >
                    {citation.label}
                  </a>
                ) : (
                  <span className="otto-turn-references__label">
                    {citation.label}
                  </span>
                )}
                <span className="otto-turn-references__meta">
                  {citation.sourceType === 'web'
                    ? '网页'
                    : citation.sourceType === 'enterprise'
                      ? '企业知识'
                      : '工具结果'}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
