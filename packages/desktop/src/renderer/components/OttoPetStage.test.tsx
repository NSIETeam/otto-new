/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { OttoPetStage, PET_ANIMATIONS } from './OttoPetStage.js';

vi.mock('../assets/otto-pet-atlas.png', () => ({ default: 'otto-pet-atlas.png' }));

const matchMedia = (matches: boolean): typeof window.matchMedia =>
  vi.fn().mockReturnValue({
    matches,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  });

beforeEach(() => {
  vi.useFakeTimers();
  window.matchMedia = matchMedia(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('OttoPetStage', () => {
  it('小宠物作为右下角挂件显示真实工作状态和红绿灯', () => {
    const { rerender } = render(<OttoPetStage running={false} variant="widget" />);

    expect(screen.getByRole('complementary', { name: 'Otto 小宠物工作状态' })).toBeTruthy();
    expect(screen.getByText('等待下一项工作')).toBeTruthy();
    expect(screen.getByLabelText('空闲待命')).toBeTruthy();

    rerender(<OttoPetStage running variant="widget" workLabel="正在运行工具" />);
    expect(screen.getByText('正在运行工具')).toBeTruthy();
    expect(screen.getByLabelText('工作中')).toBeTruthy();
  });

  it('声明完整 9 行动画协议，行号与 hatch-pet atlas 一一对应', () => {
    expect(Object.values(PET_ANIMATIONS).map((animation) => animation.row)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 8,
    ]);
  });

  it('按 idle 行的逐帧时长推进 spritesheet 帧', () => {
    const { container } = render(<OttoPetStage running={false} variant="widget" />);
    const motion = container.querySelector<HTMLElement>('[data-state="idle"]');
    expect(motion?.dataset.frame).toBe('0');

    act(() => vi.advanceTimersByTime(280));
    expect(motion?.dataset.frame).toBe('1');
  });

  it('系统要求减少动效时固定在 idle 首帧', () => {
    window.matchMedia = matchMedia(true);
    const { container } = render(<OttoPetStage running variant="widget" />);
    const motion = container.querySelector<HTMLElement>('[data-state="idle"]');
    expect(motion?.dataset.reducedMotion).toBe('true');

    act(() => vi.advanceTimersByTime(5000));
    expect(motion?.dataset.frame).toBe('0');
  });

  it('Otto 真正运行时切到右向跑步行', () => {
    const { container } = render(<OttoPetStage running variant="widget" />);
    expect(
      container.querySelector<HTMLElement>('[data-state="running-right"]'),
    ).toBeTruthy();
  });

  it('空闲时不再自动轮播挥手、跳跃或观察动作', () => {
    const { container } = render(
      <OttoPetStage running={false} variant="desktop" />,
    );

    const idleMotion = container.querySelector<HTMLElement>('[data-state="idle"]');
    expect(idleMotion?.dataset.frame).toBe('0');

    act(() => vi.advanceTimersByTime(60_000));

    expect(container.querySelector('[data-current-state="idle"]')).toBeTruthy();
    expect(idleMotion?.dataset.frame).toBe('0');
    expect(container.querySelector('[data-state="waving"]')).toBeNull();
    expect(container.querySelector('[data-state="jumping"]')).toBeNull();
    expect(container.querySelector('[data-state="review"]')).toBeNull();
  });

  it('桌面宠物模式只保留放大的宠物本体，不渲染卡片文案和红绿灯', () => {
    const { container } = render(
      <OttoPetStage running={false} variant="desktop" workLabel="等待你的下一项工作" />,
    );
    const pet = screen.getByRole('complementary', { name: 'Otto 桌面宠物' });
    const sprite = container.querySelector<HTMLElement>('.otto-pet-stage__sprite');

    expect(pet.classList.contains('otto-desktop-pet')).toBe(true);
    expect(screen.queryByText('等待你的下一项工作')).toBeNull();
    expect(container.querySelector('.otto-pet-widget__copy')).toBeNull();
    expect(container.querySelector('.otto-pet-widget__lights')).toBeNull();
    expect(sprite?.style.width).toBe('119.04px');
    expect(sprite?.style.height).toBe('128.96px');
  });

  it('点击互动时可强制切换到挥手等宠物动作', () => {
    const { rerender } = render(
      <OttoPetStage running={false} variant="desktop" reaction={null} />,
    );
    const pet = screen.getByRole('complementary', { name: 'Otto 桌面宠物' });
    expect(pet.dataset.currentState).toBe('idle');

    rerender(
      <OttoPetStage running={false} variant="desktop" reaction="waving" />,
    );
    expect(pet.dataset.currentState).toBe('waving');
  });

  it('登录页模式放大官方图集，并移除右栏标题和地面装饰', () => {
    const { container } = render(<OttoPetStage running={false} variant="login" />);
    const stage = container.querySelector<HTMLElement>('[data-testid="otto-pet-stage"]');
    const sprite = container.querySelector<HTMLElement>('.otto-pet-stage__sprite');

    expect(stage?.classList.contains('otto-pet-stage--login')).toBe(true);
    expect(container.querySelector('.otto-pet-stage__head')).toBeNull();
    expect(container.querySelector('.otto-pet-stage__floor')).toBeNull();
    expect(sprite?.style.width).toBe('316.8px');
    expect(sprite?.style.height).toBe('343.2px');
  });
});
