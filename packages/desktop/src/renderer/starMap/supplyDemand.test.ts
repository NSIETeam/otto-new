import { describe, expect, it } from 'vitest';
import { supplyDemo } from './supplyDemo.js';
import { graphIndex, visibleEdges } from './model.js';
describe('public supply-demand relations', () => {
  it('matches across industries with provider direction and unique neighbour degrees', () => {
    const index = graphIndex(supplyDemo, 'supply_demand');
    expect(
      index.matches?.some(
        (m) =>
          m.providerId === 'synthetic:software' &&
          m.consumerId === 'synthetic:manufacturing',
      ),
    ).toBe(true);
    expect(index.peers.get('synthetic:software')).toHaveLength(6);
    expect(visibleEdges(index, null)).toHaveLength(12);
    expect(index.peers.get('synthetic:garden')).toHaveLength(0);
    expect(index.peers.get('synthetic:design')).toHaveLength(1);
    expect(graphIndex(supplyDemo).peers.get('synthetic:software')).toHaveLength(
      0,
    );
  });
  it('removes a finished need but preserves another active match between the same pair', () => {
    const data = structuredClone(supplyDemo);
    const manufacturing = data.nodes.find(
      (n) => n.organizationId === 'synthetic:manufacturing',
    )!;
    manufacturing.cooperationNeeds = [];
    const index = graphIndex(data, 'supply_demand');
    expect(index.peers.get('synthetic:manufacturing')).toContain(
      'synthetic:inspection',
    );
    expect(
      index.matches?.some((m) => m.consumerId === manufacturing.organizationId),
    ).toBe(false);
  });
  it('does not infer vague/substrings, self or private relationships', () => {
    const data = structuredClone(supplyDemo);
    data.nodes.forEach((n) => (n.cooperationNeeds = ['设备']));
    expect(visibleEdges(graphIndex(data, 'supply_demand'), null)).toHaveLength(
      0,
    );
    data.nodes[0].cooperationNeeds = [...data.nodes[0].productsServices];
    data.nodes[0].isPublic = false;
    const index = graphIndex(data, 'supply_demand');
    expect(index.byId.has(data.nodes[0].organizationId)).toBe(false);
    expect(index.matches).toEqual([]);
  });
});

it('deduplicates repeated needs and matches simple explicit prefixes without capability inference', () => {
  const data = structuredClone(supplyDemo);
  const buyer = data.nodes.find(
    (node) => node.organizationId === 'synthetic:manufacturing',
  )!;
  buyer.cooperationNeeds = ['采购工业检测设备', '采购工业检测设备'];
  const index = graphIndex(data, 'supply_demand');
  expect(
    index.matches?.filter((match) => match.consumerId === buyer.organizationId),
  ).toHaveLength(1);
  const supplier = data.nodes.find(
    (node) => node.organizationId === 'synthetic:inspection',
  )!;
  supplier.capabilities = supplier.productsServices;
  supplier.productsServices = [];
  expect(
    graphIndex(data, 'supply_demand').matches?.filter(
      (match) => match.consumerId === buyer.organizationId,
    ),
  ).toHaveLength(0);
});
it('clears a revoked company from all matches and counts', () => {
  const data = structuredClone(supplyDemo);
  data.nodes.find(
    (node) => node.organizationId === 'synthetic:software',
  )!.isPublic = false;
  const index = graphIndex(data, 'supply_demand');
  expect(
    index.matches?.some(
      (match) =>
        match.providerId === 'synthetic:software' ||
        match.consumerId === 'synthetic:software',
    ),
  ).toBe(false);
  expect(index.peers.get('synthetic:design')).toEqual([]);
});
