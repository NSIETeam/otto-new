/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type {
  EnterpriseParkStarMap,
  EnterprisePublicProfile,
} from '../../preload/index.js';
import bundledDemo from './beikongDemo.json';
export type EnterpriseNode = Omit<
  EnterprisePublicProfile,
  'industryClassificationBasis'
> & {
  industryClassificationBasis?: string | null;
  displayName?: string;
  officeAddress?: string;
  addressType?: string;
  parkSourceUrl?: string;
  profileSourceUrl?: string;
  retrievedAt?: string;
  notes?: string;
};
export type StarMapData = Omit<
  EnterpriseParkStarMap,
  'nodes' | 'dataSource' | 'relationType'
> & {
  nodes: EnterpriseNode[];
  dataSource?: string;
  relationType?: string;
};
export const demoMap: StarMapData = bundledDemo;
export type SizeMode = 'uniform' | 'degree';
export interface GraphIndex {
  nodes: EnterpriseNode[];
  byId: Map<string, EnterpriseNode>;
  peers: Map<string, string[]>;
  groups: NonNullable<StarMapData['industryGroups']>;
}
export function graphIndex(data: StarMapData): GraphIndex {
  const byId = new Map(
    data.nodes
      .filter((node) => node.isPublic)
      .map((node) => [node.organizationId, node]),
  );
  const nodes = [...byId.values()].sort(
    (a, b) =>
      a.organizationName.localeCompare(b.organizationName, 'zh-CN') ||
      a.organizationId.localeCompare(b.organizationId),
  );
  const peers = new Map(
    nodes.map((node) => [node.organizationId, [] as string[]]),
  );
  const groups = (data.industryGroups ?? []).map((group) => ({
    ...group,
    memberOrganizationIds: [...new Set(group.memberOrganizationIds)].filter(
      (id) => byId.has(id),
    ),
  }));
  for (const group of groups)
    for (const id of group.memberOrganizationIds)
      peers.set(
        id,
        group.memberOrganizationIds.filter((peer) => peer !== id),
      );
  return { nodes, byId, peers, groups };
}
export function searchEnterprises(
  nodes: EnterpriseNode[],
  query: string,
): EnterpriseNode[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return nodes;
  const score = (node: EnterpriseNode): number => {
    const names = [node.organizationName, node.displayName ?? ''].map((name) =>
      name.toLocaleLowerCase(),
    );
    if (names.includes(q)) return 0;
    if (names.some((name) => name.includes(q))) return 1;
    return [node.summary, ...node.industryTags, ...node.productsServices].some(
      (value) => value.toLocaleLowerCase().includes(q),
    )
      ? 2
      : 3;
  };
  return nodes
    .map((node) => ({ node, score: score(node) }))
    .filter((item) => item.score < 3)
    .sort(
      (a, b) =>
        a.score - b.score ||
        a.node.organizationName.localeCompare(b.node.organizationName, 'zh-CN'),
    )
    .map((item) => item.node);
}
export function visibleEdges(
  index: GraphIndex,
  focus: string | null,
): Array<[string, string]> {
  if (focus) return (index.peers.get(focus) ?? []).map((id) => [focus, id]);
  return index.groups.flatMap((group) =>
    group.memberOrganizationIds.length > 12
      ? []
      : group.memberOrganizationIds.flatMap((id, i) =>
          group.memberOrganizationIds
            .slice(i + 1)
            .map((other) => [id, other] as [string, string]),
        ),
  );
}
export function nodeDiameter(degree: number, mode: SizeMode): number {
  return mode === 'uniform'
    ? 10
    : 8 + 10 * Math.min(1, Math.sqrt(Math.max(0, degree) / 30));
}
const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
export function shortName(value: string): string {
  const chars = Array.from(segmenter.segment(value), (item) => item.segment);
  return chars.length > 12 ? chars.slice(0, 12).join('') + '…' : value;
}
export function safeWebsite(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
export function accessDenied(error: unknown): boolean {
  return /STAR_MAP_ACCESS_DENIED|\b40[13]\b|无权|权限|登录|停用|退出|未加入|park not found/i.test(
    String(error),
  );
}

export { default as industryTaxonomy } from './industryTaxonomy.json';
