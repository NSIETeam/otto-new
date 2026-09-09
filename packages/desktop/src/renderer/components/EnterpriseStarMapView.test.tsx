import React, { forwardRef, useImperativeHandle } from 'react';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EnterpriseStarMapView } from './EnterpriseStarMapView.js';
import { demoMap } from '../starMap/model.js';
vi.mock('../starMap/EnterpriseGraphCanvas.js', () => ({
  EnterpriseGraphCanvas: forwardRef(function MockGraph(props: any, ref) {
    useImperativeHandle(ref, () => ({
      fit: vi.fn(),
      locate: vi.fn(),
      camera: () => ({ x: 5, y: 7, zoom: 1 }),
      restore: vi.fn(),
      zoom: vi.fn(),
    }));
    return (
      <div
        data-testid="graph"
        data-focus={props.hover ?? props.selected ?? ''}
        data-size-mode={props.sizeMode}
        data-reduced-motion={String(props.reducedMotion)}
      >
        {props.index.nodes.map((node: any) => (
          <button
            key={node.organizationId}
            aria-label={`节点 ${node.organizationName}`}
            onClick={() => props.onSelect(node.organizationId)}
            onMouseEnter={() => props.onHover(node.organizationId)}
            onMouseLeave={() => props.onHover(null)}
          >
            ●
          </button>
        ))}
      </div>
    );
  }),
}));
const real = () => ({
  ...structuredClone(demoMap),
  dataSource: 'real',
  currentOrganizationId: 'demo:bhc-demo-018',
  nodes: demoMap.nodes.map((node) => ({
    ...node,
    industryConfirmedByCompany: true,
  })),
});
beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
  Object.defineProperty(window, 'otto', {
    configurable: true,
    value: {
      enterpriseParkStarMap: vi.fn(async () => real()),
      openExternal: vi.fn(async () => undefined),
      writeClipboard: vi.fn(async () => true),
      onEnterpriseSessionInvalidated: vi.fn(() => () => undefined),
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
describe('enterprise star map exploration', () => {
  it('uses a fixed visual policy and ignores legacy view preferences', async () => {
    localStorage.setItem(
      'otto:star-map:demo',
      JSON.stringify({
        sizeMode: 'uniform',
        showIndustries: false,
        motion: 'reduce',
      }),
    );
    try {
      render(
        <EnterpriseStarMapView onBack={() => undefined} initialSource="demo" />,
      );
      const graph = await screen.findByTestId('graph');
      expect(screen.queryByRole('button', { name: '视图设置' })).toBeNull();
      expect(graph.getAttribute('data-size-mode')).toBe('degree');
      expect(screen.queryByText(/对关系/)).toBeNull();
      expect(graph.getAttribute('data-reduced-motion')).toBe('false');
    } finally {
      localStorage.removeItem('otto:star-map:demo');
    }
  });
  it('automatically respects system reduced motion', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: () => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      }),
    });
    render(
      <EnterpriseStarMapView onBack={() => undefined} initialSource="demo" />,
    );
    expect(
      (await screen.findByTestId('graph')).getAttribute('data-reduced-motion'),
    ).toBe('true');
  });
  it('shows only the graph by default even on narrow windows, without refresh or list buttons', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      value: 600,
    });
    try {
      render(
        <EnterpriseStarMapView onBack={() => undefined} initialSource="demo" />,
      );
      await screen.findByTestId('graph');
      expect(screen.queryByRole('button', { name: '刷新企业资料' })).toBeNull();
      expect(screen.queryByRole('button', { name: '企业列表' })).toBeNull();
      expect(
        screen.queryByRole('complementary', { name: '企业列表' }),
      ).toBeNull();
      fireEvent.change(
        screen.getByRole('combobox', { name: '搜索企业名称或业务' }),
        { target: { value: '国金源富' } },
      );
      expect(
        await screen.findByRole('complementary', { name: '企业列表' }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: '清空搜索' }));
      await waitFor(() =>
        expect(
          screen.queryByRole('complementary', { name: '企业列表' }),
        ).toBeNull(),
      );
    } finally {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: width,
      });
    }
  });
  it('loads 17 researched demo enterprises explicitly without calling the real service', async () => {
    render(
      <EnterpriseStarMapView onBack={() => undefined} initialSource="demo" />,
    );
    expect(await screen.findByText(/公开资料演示数据/)).toBeTruthy();
    expect(await screen.findByTestId('graph')).toBeTruthy();
    const fitButton = screen.getByRole('button', { name: '适配全图' });
    expect(fitButton.textContent).toBe('');
    expect(fitButton.querySelector('svg')).toBeTruthy();
    expect(window.otto.enterpriseParkStarMap).not.toHaveBeenCalled();
    expect(
      within(screen.getByTestId('graph')).getAllByRole('button'),
    ).toHaveLength(17);
    expect(
      screen
        .getByRole('button', { name: '回到本企业' })
        .hasAttribute('disabled'),
    ).toBe(true);
    expect(
      screen
        .getByRole('option', { name: '上下游 · 规划中' })
        .hasAttribute('disabled'),
    ).toBe(true);
  });
  it('searches, opens details, explores peers, and keeps hover separate from fixed detail', async () => {
    render(
      <EnterpriseStarMapView onBack={() => undefined} initialSource="demo" />,
    );
    await screen.findByTestId('graph');
    fireEvent.change(
      screen.getByRole('combobox', { name: '搜索企业名称或业务' }),
      { target: { value: '国金源富' } },
    );
    const list = await screen.findByRole('complementary', { name: '企业列表' });
    await waitFor(() =>
      expect(within(list).getAllByRole('option')).toHaveLength(1),
    );
    fireEvent.click(within(list).getByRole('option', { name: /国金源富/ }));
    const detail = screen.getByRole('complementary', { name: '企业资料' });
    expect(
      within(detail).getByRole('heading', { name: '北京国金源富科技有限公司' }),
    ).toBeTruthy();
    fireEvent.mouseEnter(
      screen.getByRole('button', { name: '节点 广网数据服务（北京）有限公司' }),
    );
    expect(
      within(detail).getByRole('heading', { name: '北京国金源富科技有限公司' }),
    ).toBeTruthy();
    fireEvent.mouseLeave(
      screen.getByRole('button', { name: '节点 广网数据服务（北京）有限公司' }),
    );
    expect(screen.getByTestId('graph').getAttribute('data-focus')).toBe(
      'demo:bhc-demo-018',
    );
    fireEvent.click(within(detail).getByRole('button', { name: '仅看同行' }));
    expect(screen.getByRole('button', { name: '← 返回全图' })).toBeTruthy();
    expect(
      within(detail).getByRole('heading', { name: '同行企业 1 家' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← 返回全图' }));
  });
  it('copies only a published contact on explicit action', async () => {
    render(
      <EnterpriseStarMapView onBack={() => undefined} initialSource="demo" />,
    );
    fireEvent.click(
      await screen.findByRole('button', {
        name: '节点 盈科视控（北京）科技有限公司',
      }),
    );
    fireEvent.click(screen.getByRole('button', { name: '复制联系方式' }));
    expect(await screen.findByText('已复制')).toBeTruthy();
    expect(window.otto.writeClipboard).toHaveBeenCalledWith(
      '010-56232404；sales@wiiss.com',
    );
  });
  it('never substitutes demo on failure, retains stale data for network errors, clears it for revoked access', async () => {
    const loader = vi.mocked(window.otto.enterpriseParkStarMap);
    render(<EnterpriseStarMapView onBack={() => undefined} />);
    await screen.findByTestId('graph');
    loader.mockRejectedValueOnce(new Error('network unavailable'));
    fireEvent(window, new Event('otto:enterprise-profile-updated'));
    expect(await screen.findByText(/显示上次加载内容/)).toBeTruthy();
    expect(screen.getByTestId('graph')).toBeTruthy();
    loader.mockRejectedValueOnce(
      new Error('[STAR_MAP_ACCESS_DENIED] forbidden'),
    );
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(screen.queryByTestId('graph')).toBeNull());
    expect(screen.queryByText('公开资料演示数据')).toBeNull();
  });
  it('withdraws selected enterprise details when refreshed visibility changes', async () => {
    const loader = vi.mocked(window.otto.enterpriseParkStarMap);
    render(<EnterpriseStarMapView onBack={() => undefined} />);
    fireEvent.click(
      await screen.findByRole('button', {
        name: '节点 北京国金源富科技有限公司',
      }),
    );
    const next = real();
    next.nodes = next.nodes.filter(
      (n) => n.organizationId !== 'demo:bhc-demo-018',
    );
    loader.mockResolvedValueOnce(next as any);
    fireEvent(window, new Event('otto:enterprise-profile-updated'));
    await waitFor(() =>
      expect(
        screen.queryByRole('complementary', { name: '企业资料' }),
      ).toBeNull(),
    );
    expect(screen.getByText('该企业资料已不可查看')).toBeTruthy();
  });
  it('ignores an old real request after switching data sources', async () => {
    let resolve!: (value: any) => void;
    vi.mocked(window.otto.enterpriseParkStarMap).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    render(<EnterpriseStarMapView onBack={() => undefined} />);
    fireEvent.click(screen.getByRole('button', { name: '体验演示' }));
    await screen.findByTestId('graph');
    await act(async () => resolve({ ...real(), parkName: '旧请求' }));
    expect(screen.queryByText('旧请求')).toBeNull();
    expect(screen.getByText(/公开资料演示数据/)).toBeTruthy();
  });
  it('supports keyboard search selection and clears all visible data on session invalidation', async () => {
    render(<EnterpriseStarMapView onBack={() => undefined} />);
    await screen.findByTestId('graph');
    const input = screen.getByRole('combobox', { name: '搜索企业名称或业务' });
    fireEvent.change(input, { target: { value: '国金源富' } });
    await screen.findByRole('option', { name: /国金源富/ });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(
      screen.getByRole('complementary', { name: '企业资料' }),
    ).toBeTruthy();
    act(() =>
      vi.mocked(window.otto.onEnterpriseSessionInvalidated).mock.calls[0][0](),
    );
    expect(screen.queryByTestId('graph')).toBeNull();
    expect(
      screen.queryByRole('complementary', { name: '企业资料' }),
    ).toBeNull();
  });
  it('distinguishes empty authorized data from a request failure without invented nodes', async () => {
    vi.mocked(window.otto.enterpriseParkStarMap).mockResolvedValueOnce({
      ...real(),
      nodes: [],
      industryGroups: [],
    } as any);
    const view = render(<EnterpriseStarMapView onBack={() => undefined} />);
    expect(await screen.findByText('园区暂无已公开资料的企业')).toBeTruthy();
    expect(screen.queryByTestId('graph')).toBeNull();
    view.unmount();
    vi.mocked(window.otto.enterpriseParkStarMap).mockRejectedValueOnce(
      new Error('network unavailable'),
    );
    render(<EnterpriseStarMapView onBack={() => undefined} />);
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByTestId('graph')).toBeNull();
    expect(screen.queryByText('公开资料演示数据')).toBeNull();
  });
});

it('shows offline status and clears it when connection returns', async () => {
  render(<EnterpriseStarMapView onBack={() => undefined} />);
  await screen.findByTestId('graph');
  fireEvent(window, new Event('offline'));
  expect(screen.getByText(/当前离线/)).toBeTruthy();
  expect(screen.getByTestId('graph')).toBeTruthy();
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(screen.queryByText(/当前离线/)).toBeNull());
});

it('explores fictional supply relationships and closes a demo need without calling update APIs', async () => {
  window.otto.enterprisePublicProfileUpdate = vi.fn();
  render(
    <EnterpriseStarMapView onBack={() => undefined} initialSource="demo" />,
  );
  await screen.findByTestId('graph');
  expect(screen.queryByRole('button', { name: '供需虚拟演示' })).toBeNull();
  expect(
    within(screen.getByTestId('graph')).getAllByRole('button'),
  ).toHaveLength(17);
  fireEvent.change(screen.getByRole('combobox', { name: '连接方式' }), {
    target: { value: 'supply_demand' },
  });
  await screen.findByText('北控宏创科技园');
  expect(
    (screen.getByRole('combobox', { name: '连接方式' }) as HTMLSelectElement)
      .value,
  ).toBe('supply_demand');
  fireEvent.click(
    screen.getByRole('button', { name: '节点 盈科视控（北京）科技有限公司' }),
  );
  expect(await screen.findByText('谁能满足我的需求')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: '演示完成需求：自动化设备' }),
  );
  expect(
    await screen.findByRole('button', { name: '演示恢复需求：自动化设备' }),
  ).toBeTruthy();
  fireEvent.change(screen.getByRole('combobox', { name: '连接方式' }), {
    target: { value: 'same_industry' },
  });
  expect(screen.getByRole('button', { name: '仅看同行' })).toBeTruthy();
  expect(window.otto.enterprisePublicProfileUpdate).not.toHaveBeenCalled();
});
