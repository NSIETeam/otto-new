/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopPetSurface } from './DesktopPetSurface.js';
import type { DesktopPetBehaviorEvent } from '../../preload/index.js';

vi.mock('../assets/otto-pet-atlas.png', () => ({ default: 'otto-pet-atlas.png' }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function installDesktopPetBridge() {
  const stateListeners = new Set<
    (state: { running: boolean; workLabel: string; sessionId: string | null }) => void
  >();
  const reactionListeners = new Set<(event: DesktopPetBehaviorEvent) => void>();
  const nativeDragEndListeners = new Set<(moved: boolean) => void>();
  const bridge = {
    desktopPetGetState: vi.fn().mockReturnValue(new Promise(() => undefined)),
    onDesktopPetState: vi.fn((handler) => {
      stateListeners.add(handler);
      return () => stateListeners.delete(handler);
    }),
    onDesktopPetReaction: vi.fn((handler) => {
      reactionListeners.add(handler);
      return () => reactionListeners.delete(handler);
    }),
    desktopPetDragStart: vi.fn().mockResolvedValue(undefined),
    desktopPetDragEnd: vi.fn().mockResolvedValue(false),
    desktopPetOpenMain: vi.fn().mockResolvedValue(undefined),
    desktopPetSetInteractive: vi.fn(),
    onDesktopPetNativeDragEnd: vi.fn((handler) => {
      nativeDragEndListeners.add(handler);
      return () => nativeDragEndListeners.delete(handler);
    }),
    desktopPetShowMenu: vi.fn().mockResolvedValue(undefined),
  };
  window.otto = bridge as unknown as typeof window.otto;
  return { bridge, stateListeners, reactionListeners, nativeDragEndListeners };
}

function firePointer(
  target: Element,
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  values: {
    button?: number;
    buttons?: number;
    clientX?: number;
    clientY?: number;
    pointerId: number;
    screenX: number;
    screenY: number;
  },
): void {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const normalized = {
    ...values,
    clientX: values.clientX ?? values.screenX,
    clientY: values.clientY ?? values.screenY,
  };
  for (const [key, value] of Object.entries(normalized)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  fireEvent(target, event);
}

describe('DesktopPetSurface', () => {
  it('在独立桌面窗口接收并显示实时工作状态', async () => {
    const { stateListeners } = installDesktopPetBridge();

    const { container } = render(<DesktopPetSurface />);
    const pet = await screen.findByRole('complementary', { name: 'Otto 桌面宠物' });
    expect(pet.dataset.running).toBe('false');
    expect(screen.queryByText('等待你的下一项工作')).toBeNull();
    expect(container.querySelector('.otto-pet-widget__lights')).toBeNull();

    act(() => {
      for (const listener of stateListeners) {
        listener({
          running: true,
          workLabel: '正在运行工具',
          sessionId: 'session-1',
        });
      }
    });
    await waitFor(() => expect(pet.dataset.running).toBe('true'));
    expect(pet.dataset.currentState).toBe('running-right');
  });

  it('单击会说话并做动作，双击会唤回 Otto', async () => {
    vi.useFakeTimers();
    const { bridge } = installDesktopPetBridge();
    render(<DesktopPetSurface />);
    const surface = screen.getByRole('button', {
      name: 'Otto 桌面宠物，单击互动，双击打开 Otto',
    });

    firePointer(surface, 'pointerdown', { button: 0, pointerId: 1, screenX: 80, screenY: 90 });
    firePointer(surface, 'pointerup', { button: 0, pointerId: 1, screenX: 80, screenY: 90 });
    await act(async () => Promise.resolve());
    act(() => vi.advanceTimersByTime(260));
    expect(screen.getByText('我在呢，需要我做什么？')).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Otto 桌面宠物' }).dataset.currentState)
      .toBe('jumping');

    firePointer(surface, 'pointerdown', { button: 0, pointerId: 2, screenX: 80, screenY: 90 });
    firePointer(surface, 'pointerup', { button: 0, pointerId: 2, screenX: 80, screenY: 90 });
    await act(async () => Promise.resolve());
    firePointer(surface, 'pointerdown', { button: 0, pointerId: 3, screenX: 80, screenY: 90 });
    firePointer(surface, 'pointerup', { button: 0, pointerId: 3, screenX: 80, screenY: 90 });
    await act(async () => Promise.resolve());
    expect(bridge.desktopPetOpenMain).toHaveBeenCalledOnce();
    expect(screen.getByText('正在打开 Otto')).toBeTruthy();
  });

  it('拖动不会误触点击，右键会打开宠物快捷菜单', async () => {
    const { bridge } = installDesktopPetBridge();
    bridge.desktopPetDragEnd.mockResolvedValueOnce(true);
    render(<DesktopPetSurface />);
    const surface = screen.getByRole('button', {
      name: 'Otto 桌面宠物，单击互动，双击打开 Otto',
    });

    firePointer(surface, 'pointerdown', { button: 0, pointerId: 4, screenX: 50, screenY: 60 });
    firePointer(surface, 'pointermove', {
      buttons: 1,
      pointerId: 4,
      screenX: 62,
      screenY: 72,
    });
    firePointer(surface, 'pointermove', {
      buttons: 1,
      pointerId: 4,
      screenX: 80,
      screenY: 90,
    });
    firePointer(surface, 'pointerup', { button: 0, pointerId: 4, screenX: 80, screenY: 90 });
    await act(async () => Promise.resolve());
    expect(bridge.desktopPetDragStart).toHaveBeenCalledOnce();
    expect(bridge.desktopPetDragEnd).toHaveBeenCalledOnce();
    expect(screen.queryByText('我在呢，需要我做什么？')).toBeNull();

    fireEvent.contextMenu(surface);
    expect(bridge.desktopPetShowMenu).toHaveBeenCalledOnce();
  });

  it('连续 pointermove 不再从渲染层重复驱动窗口', async () => {
    const { bridge } = installDesktopPetBridge();
    bridge.desktopPetDragEnd.mockResolvedValueOnce(true);
    render(<DesktopPetSurface />);
    const surface = screen.getByRole('button', {
      name: 'Otto 桌面宠物，单击互动，双击打开 Otto',
    });

    firePointer(surface, 'pointerdown', {
      button: 0,
      buttons: 1,
      pointerId: 12,
      screenX: 50,
      screenY: 60,
    });
    firePointer(surface, 'pointermove', {
      buttons: 1,
      pointerId: 12,
      screenX: 60,
      screenY: 60,
    });
    firePointer(surface, 'pointermove', {
      buttons: 1,
      pointerId: 12,
      screenX: 90,
      screenY: 60,
    });
    firePointer(surface, 'pointerup', {
      button: 0,
      buttons: 0,
      pointerId: 12,
      screenX: 90,
      screenY: 60,
    });
    await act(async () => Promise.resolve());

    expect(bridge.desktopPetDragStart).toHaveBeenCalledOnce();
    expect(bridge.desktopPetDragEnd).toHaveBeenCalledOnce();
  });

  it('窗口移动触发 pointercancel 时不提前结束，等待真实 mouseup', async () => {
    const { bridge } = installDesktopPetBridge();
    const { container } = render(<DesktopPetSurface />);
    const surface = container.querySelector<HTMLElement>('.otto-desktop-pet__hit-target');
    expect(surface).not.toBeNull();

    firePointer(surface!, 'pointerdown', {
      button: 0,
      buttons: 1,
      pointerId: 15,
      screenX: 80,
      screenY: 500,
    });
    firePointer(surface!, 'pointercancel', {
      button: 0,
      buttons: 0,
      pointerId: 15,
      screenX: 80,
      screenY: 420,
    });
    await act(async () => Promise.resolve());
    expect(bridge.desktopPetDragEnd).not.toHaveBeenCalled();

    fireEvent.mouseUp(window, { button: 0 });
    await act(async () => Promise.resolve());
    expect(bridge.desktopPetDragEnd).toHaveBeenCalledOnce();
  });

  it('Chromium 丢失 pointerup 时由原生释放事件解除按住状态', async () => {
    vi.useFakeTimers();
    const { bridge, nativeDragEndListeners } = installDesktopPetBridge();
    render(<DesktopPetSurface />);
    const surface = screen.getByRole('button', {
      name: 'Otto 桌面宠物，单击互动，双击打开 Otto',
    });

    firePointer(surface, 'pointerdown', {
      button: 0,
      buttons: 1,
      pointerId: 16,
      screenX: 80,
      screenY: 420,
    });
    act(() => {
      for (const listener of nativeDragEndListeners) listener(true);
    });
    act(() => vi.advanceTimersByTime(1_000));

    expect(bridge.desktopPetDragEnd).not.toHaveBeenCalled();
    expect(screen.queryByText('我在呢，需要我做什么？')).toBeNull();
    expect(bridge.desktopPetSetInteractive).toHaveBeenLastCalledWith(true);
  });

  it('左键长按后松开不会被误判成单击动作', async () => {
    vi.useFakeTimers();
    const { bridge } = installDesktopPetBridge();
    render(<DesktopPetSurface />);
    const surface = screen.getByRole('button', {
      name: 'Otto 桌面宠物，单击互动，双击打开 Otto',
    });

    firePointer(surface, 'pointerdown', {
      button: 0,
      pointerId: 8,
      screenX: 70,
      screenY: 80,
    });
    act(() => vi.advanceTimersByTime(500));
    firePointer(surface, 'pointerup', {
      button: 0,
      pointerId: 8,
      screenX: 70,
      screenY: 80,
    });
    await act(async () => Promise.resolve());
    act(() => vi.advanceTimersByTime(300));

    expect(screen.queryByText('我在呢，需要我做什么？')).toBeNull();
    expect(bridge.desktopPetOpenMain).not.toHaveBeenCalled();
    expect(bridge.desktopPetDragStart).toHaveBeenCalledOnce();
    expect(bridge.desktopPetDragEnd).toHaveBeenCalledOnce();
  });

  it('透明窗口空白区不会启动拖拽', () => {
    const { bridge } = installDesktopPetBridge();
    const { container } = render(<DesktopPetSurface />);
    const surface = container.querySelector('.otto-desktop-pet-surface');
    expect(surface).toBeTruthy();

    firePointer(surface!, 'pointerdown', {
      button: 0,
      pointerId: 9,
      screenX: 10,
      screenY: 10,
    });
    firePointer(surface!, 'pointermove', {
      pointerId: 9,
      screenX: 60,
      screenY: 60,
    });
    firePointer(surface!, 'pointerup', {
      button: 0,
      pointerId: 9,
      screenX: 60,
      screenY: 60,
    });

    expect(bridge.desktopPetDragStart).not.toHaveBeenCalled();
    expect(bridge.desktopPetDragEnd).not.toHaveBeenCalled();
  });

  it('只有宠物命中区域拦截鼠标，透明区域恢复系统点击穿透', () => {
    const { bridge } = installDesktopPetBridge();
    const { container } = render(<DesktopPetSurface />);
    const hitTarget = container.querySelector<HTMLElement>('.otto-desktop-pet__hit-target');
    const surface = container.querySelector<HTMLElement>('.otto-desktop-pet-surface');
    expect(hitTarget).not.toBeNull();
    expect(surface).not.toBeNull();

    fireEvent.mouseMove(hitTarget!, { clientX: 80, clientY: 90 });
    expect(bridge.desktopPetSetInteractive).toHaveBeenLastCalledWith(true);

    fireEvent.mouseMove(surface!, { clientX: 4, clientY: 4 });
    expect(bridge.desktopPetSetInteractive).toHaveBeenLastCalledWith(false);
  });

  it('按住期间冻结宠物工作动画，鼠标不动时保持同一姿势', async () => {
    vi.useFakeTimers();
    const { bridge, stateListeners } = installDesktopPetBridge();
    render(<DesktopPetSurface />);
    const petTarget = screen.getByRole('button', {
      name: 'Otto 桌面宠物，单击互动，双击打开 Otto',
    });
    const pet = screen.getByRole('complementary', { name: 'Otto 桌面宠物' });

    act(() => {
      for (const listener of stateListeners) {
        listener({
          running: true,
          workLabel: '正在运行工具',
          sessionId: 'session-held',
        });
      }
    });
    expect(pet.dataset.currentState).toBe('running-right');

    firePointer(petTarget, 'pointerdown', {
      button: 0,
      buttons: 1,
      pointerId: 11,
      screenX: 70,
      screenY: 80,
    });
    expect(pet.dataset.currentState).toBe('idle');
    expect(pet.querySelector('.otto-pet-stage__motion')?.getAttribute('data-frame'))
      .toBe('0');
    act(() => vi.advanceTimersByTime(5_000));
    expect(pet.dataset.currentState).toBe('idle');
    expect(pet.querySelector('.otto-pet-stage__motion')?.getAttribute('data-frame'))
      .toBe('0');

    firePointer(petTarget, 'pointerup', {
      button: 0,
      buttons: 0,
      pointerId: 11,
      screenX: 70,
      screenY: 80,
    });
    await act(async () => Promise.resolve());

    expect(bridge.desktopPetDragStart).toHaveBeenCalledOnce();
    expect(bridge.desktopPetDragEnd).toHaveBeenCalledOnce();
  });

  it('任务完成事件只触发挥手，不与点击动作混用', () => {
    const { reactionListeners } = installDesktopPetBridge();
    render(<DesktopPetSurface />);

    act(() => {
      for (const listener of reactionListeners) listener('task-completed');
    });

    const pet = screen.getByRole('complementary', { name: 'Otto 桌面宠物' });
    expect(pet.dataset.currentState).toBe('waving');
    expect(screen.getByText('任务完成，交给你啦')).toBeTruthy();
  });
});
