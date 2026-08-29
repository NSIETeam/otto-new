/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  EnterpriseParkPartnershipEdge,
  EnterpriseParkStarMap,
  EnterprisePublicProfile,
} from '../../preload/index.js';

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/^Error invoking remote method '[^']+':\s*/u, '')
    .replace(/^Error:\s*/u, '');
}

function strengthLabel(strength: EnterpriseParkPartnershipEdge['strength']): string {
  if (strength === 'strong') return '多项互补';
  if (strength === 'promising') return '值得对接';
  return '初步线索';
}

interface PositionedProfile extends EnterprisePublicProfile {
  x: number;
  y: number;
}

function positionNodes(map: EnterpriseParkStarMap): PositionedProfile[] {
  const current = map.nodes.find(
    (node) => node.organizationId === map.currentOrganizationId,
  );
  const remaining = map.nodes.filter(
    (node) => node.organizationId !== map.currentOrganizationId,
  );
  const positioned: PositionedProfile[] = [];
  if (current) positioned.push({ ...current, x: 380, y: 230 });
  const radiusX = current ? 270 : 250;
  const radiusY = current ? 155 : 145;
  remaining.forEach((node, index) => {
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / Math.max(remaining.length, 1);
    positioned.push({
      ...node,
      x: 380 + Math.cos(angle) * radiusX,
      y: 230 + Math.sin(angle) * radiusY,
    });
  });
  if (!current && map.nodes.length === 1) {
    return [{ ...map.nodes[0]!, x: 380, y: 230 }];
  }
  return positioned;
}

export function EnterpriseStarMapView({
  onBack,
}: {
  onBack: () => void;
}): React.JSX.Element {
  const [map, setMap] = useState<EnterpriseParkStarMap | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const load = useCallback((): void => {
    setLoading(true);
    setError(null);
    void window.otto
      .enterpriseParkStarMap()
      .then((next) => {
        setMap(next);
        const ownEdge = next.edges.find(
          (edge) =>
            edge.sourceOrganizationId === next.currentOrganizationId ||
            edge.targetOrganizationId === next.currentOrganizationId,
        );
        setSelectedEdgeId(ownEdge?.id ?? next.edges[0]?.id ?? null);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const positions = useMemo(() => (map ? positionNodes(map) : []), [map]);
  const positionById = useMemo(
    () => new Map(positions.map((node) => [node.organizationId, node])),
    [positions],
  );
  const selectedEdge = map?.edges.find((edge) => edge.id === selectedEdgeId) ?? null;
  const currentPublished = Boolean(
    map?.nodes.some((node) => node.organizationId === map.currentOrganizationId),
  );

  const nameFor = (organizationId: string): string =>
    positionById.get(organizationId)?.organizationName ?? '未知企业';

  return (
    <div className="otto-star-map">
      <header className="otto-star-map__header">
        <button type="button" onClick={onBack}>← 返回园区服务</button>
        <div>
          <span>ENTERPRISE STAR MAP</span>
          <h3>{map?.parkName ?? '企业星链图'}</h3>
          <p>根据企业主动公开的能力、产品和合作需求，生成可核实的合作线索。</p>
        </div>
        <button type="button" onClick={load} disabled={loading}>
          {loading ? '正在刷新…' : '刷新线索'}
        </button>
      </header>
      {error ? <div className="otto-star-map__error" role="alert">{error}</div> : null}
      {!loading && map ? (
        <>
          <div className="otto-star-map__metrics">
            <div><strong>{map.nodes.length}</strong><span>家公开资料企业</span></div>
            <div><strong>{map.edges.length}</strong><span>条互补线索</span></div>
            <div><strong>规则可解释</strong><span>不使用内部消息或经营数据</span></div>
          </div>
          {!currentPublished ? (
            <div className="otto-star-map__private-notice">
              <strong>本企业尚未进入星链图</strong>
              <span>请让企业管理员前往“企业管理 → 企业资料”完善资料并主动公开。</span>
            </div>
          ) : null}
          <div className="otto-star-map__workspace">
            <section className="otto-star-map__canvas" aria-label="园区企业关系图">
              {positions.length ? (
                <svg viewBox="0 0 760 460" role="img" aria-label={`${map.parkName}企业合作线索图`}>
                  <defs>
                    <filter id="otto-star-shadow" x="-30%" y="-30%" width="160%" height="160%">
                      <feDropShadow dx="0" dy="5" stdDeviation="6" floodOpacity=".12" />
                    </filter>
                  </defs>
                  {map.edges.map((edge) => {
                    const source = positionById.get(edge.sourceOrganizationId);
                    const target = positionById.get(edge.targetOrganizationId);
                    if (!source || !target) return null;
                    return (
                      <line
                        key={edge.id}
                        x1={source.x}
                        y1={source.y}
                        x2={target.x}
                        y2={target.y}
                        className={`is-${edge.strength} ${selectedEdgeId === edge.id ? 'is-selected' : ''}`}
                      />
                    );
                  })}
                  {positions.map((node) => {
                    const own = node.organizationId === map.currentOrganizationId;
                    return (
                      <g
                        key={node.organizationId}
                        className={own ? 'is-current' : ''}
                        transform={`translate(${node.x} ${node.y})`}
                        filter="url(#otto-star-shadow)"
                      >
                        <circle r={own ? 48 : 40} />
                        <text textAnchor="middle" y="-3">{node.organizationName.slice(0, 8)}</text>
                        <text className="otto-star-map__node-kind" textAnchor="middle" y="17">
                          {own ? '本企业' : node.industryTags[0] ?? '园区企业'}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              ) : (
                <div className="otto-star-map__empty">园区内尚无企业主动公开资料。</div>
              )}
            </section>
            <aside className="otto-star-map__recommendations" aria-label="合作线索说明">
              <div className="otto-star-map__recommendations-head">
                <strong>合作线索</strong>
                <small>点击查看推理依据</small>
              </div>
              {map.edges.length ? (
                <div className="otto-star-map__edge-list">
                  {map.edges.map((edge) => (
                    <button
                      key={edge.id}
                      type="button"
                      className={edge.id === selectedEdgeId ? 'is-selected' : ''}
                      onClick={() => setSelectedEdgeId(edge.id)}
                    >
                      <span>{strengthLabel(edge.strength)}</span>
                      <strong>{nameFor(edge.sourceOrganizationId)} ↔ {nameFor(edge.targetOrganizationId)}</strong>
                      <small>规则置信度 {Math.round(edge.ruleConfidence * 100)}%</small>
                    </button>
                  ))}
                </div>
              ) : <p>暂未发现产品、能力与合作需求之间的直接互补。</p>}
              {selectedEdge ? (
                <div className="otto-star-map__evidence">
                  <h4>为什么推荐</h4>
                  <ul>{selectedEdge.evidence.map((item) => <li key={item}>{item}</li>)}</ul>
                  <h4>对接前必须核实</h4>
                  <ul>{selectedEdge.unverifiedQuestions.map((item) => <li key={item}>{item}</li>)}</ul>
                  {(() => {
                    const otherId = selectedEdge.sourceOrganizationId === map.currentOrganizationId
                      ? selectedEdge.targetOrganizationId
                      : selectedEdge.sourceOrganizationId;
                    const other = positionById.get(otherId);
                    return other?.publicContact ? (
                      <p className="otto-star-map__contact"><strong>企业公开联系方式</strong>{other.publicContact}</p>
                    ) : null;
                  })()}
                </div>
              ) : null}
            </aside>
          </div>
          <footer className="otto-star-map__disclaimer">
            以上为基于企业公开资料的规则推理，不代表合作承诺、履约能力或商业成功概率；请由双方人工核实并自主决定。
          </footer>
        </>
      ) : null}
    </div>
  );
}
