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
export type RelationMode = 'same_industry' | 'supply_demand';
export interface SupplyMatch {
  providerId: string;
  consumerId: string;
  product: string;
  need: string;
}
export type SizeMode = 'uniform' | 'degree';
export interface GraphIndex {
  relationMode?: RelationMode;
  matches?: SupplyMatch[];
  nodes: EnterpriseNode[];
  byId: Map<string, EnterpriseNode>;
  peers: Map<string, string[]>;
  groups: NonNullable<StarMapData['industryGroups']>;
}
export function graphIndex(
  data: StarMapData,
  relationMode: RelationMode = 'same_industry',
): GraphIndex {
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
  const matches: SupplyMatch[] = [];
  if (relationMode === 'supply_demand') {
    for (const id of peers.keys()) peers.set(id, []);
    // Conservative explicit terms only, never infer links from a broad industry or substring.
    const normalize = (text: string) =>
      text
        .normalize('NFKC')
        .trim()
        .toLocaleLowerCase()
        .replace(/^(?:希望|需要|寻找|采购|求购|提供|供应)\s*/u, '')
        .replace(/[\s，,。.!！]+$/u, '')
        .trim();
    const supplies = new Map<string, Array<{ id: string; product: string }>>();
    for (const node of nodes)
      for (const product of new Set(node.productsServices)) {
        const key = normalize(product);
        if (key)
          supplies.set(key, [
            ...(supplies.get(key) ?? []),
            { id: node.organizationId, product },
          ]);
      }
    for (const consumer of nodes)
      for (const need of new Set(consumer.cooperationNeeds)) {
        for (const provider of supplies.get(normalize(need)) ?? []) {
          if (provider.id === consumer.organizationId) continue;
          matches.push({
            providerId: provider.id,
            consumerId: consumer.organizationId,
            product: provider.product,
            need,
          });
          const add = (a: string, b: string) => {
            const values = peers.get(a)!;
            if (!values.includes(b)) values.push(b);
          };
          add(provider.id, consumer.organizationId);
          add(consumer.organizationId, provider.id);
        }
      }
  }
  return { nodes, byId, peers, groups, matches, relationMode };
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
  if (index.relationMode === 'supply_demand') {
    // Dense graphs expand all direct neighbours only on focus, avoiding a wall of lines.
    const edges = [...index.peers].flatMap(([id, peers]) =>
      peers
        .filter((other) => id < other)
        .map((other) => [id, other] as [string, string]),
    );
    return edges.length > 600 ? [] : edges;
  }
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
