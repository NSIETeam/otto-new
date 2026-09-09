import { describe, expect, it } from 'vitest';
import { supplyDemo } from './supplyDemo.js';
import { demoMap, graphIndex, visibleEdges } from './model.js';
describe('public supply-demand relations', () => {
  it('matches across industries with provider direction and unique neighbour degrees', () => {
    const index = graphIndex(supplyDemo, 'supply_demand');
    expect(
      index.matches?.some(
        (m) =>
          m.providerId === 'demo:bhc-demo-018' &&
          m.consumerId === 'demo:bhc-demo-002',
      ),
    ).toBe(true);
    expect(index.peers.get('demo:bhc-demo-018')).toHaveLength(7);
    expect(visibleEdges(index, null)).toHaveLength(25);
    expect(index.peers.get('demo:bhc-demo-012')).toHaveLength(0);
    expect(index.peers.get('demo:bhc-demo-006')).toHaveLength(1);
    expect(graphIndex(supplyDemo).peers.get('demo:bhc-demo-018')).toHaveLength(
      1,
    );
  });
  it('removes a finished need but preserves another active match between the same pair', () => {
    const data = structuredClone(supplyDemo);
    const manufacturing = data.nodes.find(
      (n) => n.organizationId === 'demo:bhc-demo-002',
    )!;
    manufacturing.demoCooperationNeeds = [];
    const index = graphIndex(data, 'supply_demand');
    expect(index.peers.get('demo:bhc-demo-002')).toContain('demo:bhc-demo-011');
    expect(
      index.matches?.some((m) => m.consumerId === manufacturing.organizationId),
    ).toBe(false);
  });
  it('does not infer vague/substrings, self or private relationships', () => {
    const data = structuredClone(supplyDemo);
    data.nodes.forEach((n) => (n.demoCooperationNeeds = ['设备']));
    expect(visibleEdges(graphIndex(data, 'supply_demand'), null)).toHaveLength(
      0,
    );
    data.nodes[0].demoCooperationNeeds = [
      ...data.nodes[0].demoProductsServices!,
    ];
    data.nodes[0].isPublic = false;
    const index = graphIndex(data, 'supply_demand');
    expect(index.byId.has(data.nodes[0].organizationId)).toBe(false);
    expect(index.matches).toEqual([]);
  });
});

it('deduplicates repeated needs and matches simple explicit prefixes without capability inference', () => {
  const data = structuredClone(supplyDemo);
  const buyer = data.nodes.find(
    (node) => node.organizationId === 'demo:bhc-demo-002',
  )!;
  buyer.demoCooperationNeeds = ['采购自动化设备', '采购自动化设备'];
  const index = graphIndex(data, 'supply_demand');
  expect(
    index.matches?.filter((match) => match.consumerId === buyer.organizationId),
  ).toHaveLength(1);
  const supplier = data.nodes.find(
    (node) => node.organizationId === 'demo:bhc-demo-011',
  )!;
  supplier.capabilities = supplier.demoProductsServices!;
  supplier.demoProductsServices = [];
  expect(
    graphIndex(data, 'supply_demand').matches?.filter(
      (match) => match.consumerId === buyer.organizationId,
    ),
  ).toHaveLength(0);
});
it('clears a revoked company from all matches and counts', () => {
  const data = structuredClone(supplyDemo);
  data.nodes.find(
    (node) => node.organizationId === 'demo:bhc-demo-018',
  )!.isPublic = false;
  const index = graphIndex(data, 'supply_demand');
  expect(
    index.matches?.some(
      (match) =>
        match.providerId === 'demo:bhc-demo-018' ||
        match.consumerId === 'demo:bhc-demo-018',
    ),
  ).toBe(false);
  expect(index.peers.get('demo:bhc-demo-006')).toEqual([]);
});

it('uses exactly the researched 17 identities without mutating their published facts', () => {
  expect(supplyDemo.nodes.map((node) => node.organizationId)).toEqual(
    demoMap.nodes.map((node) => node.organizationId),
  );
  for (const node of supplyDemo.nodes) {
    const { demoProductsServices, demoCooperationNeeds, ...facts } = node;
    expect(facts).toEqual(
      demoMap.nodes.find(
        (original) => original.organizationId === node.organizationId,
      ),
    );
    expect(demoProductsServices).toBeDefined();
    expect(demoCooperationNeeds).toBeDefined();
  }
  expect(visibleEdges(graphIndex(supplyDemo), null)).toHaveLength(11);
});
it('never uses simulated fields for real API data', () => {
  const data = structuredClone(supplyDemo);
  data.dataSource = 'real';
  data.nodes.forEach((node) => {
    node.productsServices = [];
    node.cooperationNeeds = [];
  });
  expect(graphIndex(data, 'supply_demand').matches).toEqual([]);
});
