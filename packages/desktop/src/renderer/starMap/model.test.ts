import { describe, expect, it } from 'vitest';
import demo from './beikongDemo.json';
import {
  graphIndex,
  searchEnterprises,
  visibleEdges,
  nodeDiameter,
  shortName,
} from './model.js';

describe('enterprise exploration semantics', () => {
  it('retains all 17 public companies, 11 undirected relations, and isolated enterprises', () => {
    const index = graphIndex(demo);
    expect(index.nodes).toHaveLength(17);
    expect(visibleEdges(index, null)).toHaveLength(11);
    expect(index.peers.get('demo:bhc-demo-018')).toEqual(['demo:bhc-demo-003']);
  });
  it('searches names and public business case-insensitively without changing degree', () => {
    const index = graphIndex(demo);
    expect(searchEnterprises(index.nodes, ' 国金源富 ')[0].displayName).toBe(
      '国金源富',
    );
    expect(searchEnterprises(index.nodes, 'rfid')[0].displayName).toBe(
      '国金源富',
    );
    expect(searchEnterprises(index.nodes, 'not-found')).toEqual([]);
    expect(nodeDiameter(99, 'degree')).toBe(18);
    expect(nodeDiameter(99, 'uniform')).toBe(10);
  });
  it('suppresses dense default lines but returns every peer when focused', () => {
    const nodes = Array.from({ length: 13 }, (_, i) => ({
      ...demo.nodes[0],
      organizationId: String(i),
    }));
    const index = graphIndex({
      ...demo,
      nodes,
      industryGroups: [
        {
          code: 'x',
          name: '行业',
          memberOrganizationIds: nodes.map((n) => n.organizationId),
        },
      ],
    });
    expect(visibleEdges(index, null)).toEqual([]);
    expect(visibleEdges(index, '0')).toHaveLength(12);
  });
  it('clips invalid group members, deduplicates IDs and never indexes private profiles', () => {
    const index = graphIndex({
      ...demo,
      nodes: [
        ...demo.nodes,
        { ...demo.nodes[0], organizationId: 'private', isPublic: false },
      ],
      industryGroups: [
        {
          code: 'x',
          name: 'x',
          memberOrganizationIds: [
            'private',
            demo.nodes[0].organizationId,
            demo.nodes[0].organizationId,
            'missing',
          ],
        },
      ],
    });
    expect(index.nodes).toHaveLength(17);
    expect(visibleEdges(index, null)).toEqual([]);
  });
  it('truncates readable labels by grapheme and retains short names', () => {
    expect(shortName('甲企业')).toBe('甲企业');
    expect(shortName('👨‍👩‍👧‍👦'.repeat(14))).toBe('👨‍👩‍👧‍👦'.repeat(12) + '…');
  });
});
