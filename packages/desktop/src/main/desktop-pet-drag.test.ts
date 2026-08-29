import { describe, expect, it } from 'vitest';
import {
  advanceDesktopPetDrag,
  clampDesktopPetToWorkArea,
  createDesktopPetDragState,
  rebaseDesktopPetDrag,
} from './desktop-pet-drag.js';

describe('desktop pet native drag tracking', () => {
  const createState = () => createDesktopPetDragState(
    { x: 320, y: 180 },
    { x: 900, y: 500 },
  );

  it('严格使用按下点到当前鼠标的绝对位移，不累积采样误差', () => {
    const state = createState();
    advanceDesktopPetDrag(state, { x: 885, y: 500 });
    advanceDesktopPetDrag(state, { x: 868, y: 500 });
    const step = advanceDesktopPetDrag(state, { x: 850, y: 500 });

    expect(step.position).toEqual({ x: 270, y: 180 });
    expect(step.displacement).toEqual({ x: -50, y: 0 });
  });

  it('鼠标轻微移动几个像素时窗口只移动相同像素', () => {
    const step = advanceDesktopPetDrag(createState(), { x: 903, y: 498 });

    expect(step.position).toEqual({ x: 323, y: 178 });
    expect(step.displacement).toEqual({ x: 3, y: -2 });
  });

  it('横移后可以立即上移，不锁死任何方向', () => {
    const state = createState();
    const horizontal = advanceDesktopPetDrag(state, { x: 860, y: 500 });
    const vertical = advanceDesktopPetDrag(state, { x: 859, y: 460 });

    expect(horizontal.position).toEqual({ x: 280, y: 180 });
    expect(vertical.position).toEqual({ x: 279, y: 140 });
  });

  it('鼠标静止时窗口完全静止', () => {
    const step = advanceDesktopPetDrag(createState(), { x: 900, y: 500 });

    expect(step.position).toEqual({ x: 320, y: 180 });
    expect(step.displacement).toEqual({ x: 0, y: 0 });
  });

  it('贴边后重建锚点，反向一像素就立即离开屏幕边缘', () => {
    const desired = advanceDesktopPetDrag(createState(), { x: 1_100, y: 500 });
    expect(desired.position.x).toBe(520);

    const rebased = rebaseDesktopPetDrag({ x: 480, y: 180 }, { x: 1_100, y: 500 });
    const reversed = advanceDesktopPetDrag(rebased, { x: 1_099, y: 500 });

    expect(reversed.position).toEqual({ x: 479, y: 180 });
  });

  it('使用真实外层窗口尺寸约束边界，不依赖写死的内容区尺寸', () => {
    const result = clampDesktopPetToWorkArea(
      { x: 1_900, y: 1_000 },
      { width: 184, height: 196 },
      { x: 0, y: 0, width: 1_920, height: 1_040 },
    );

    expect(result).toEqual({ x: 1_736, y: 844 });
  });
});
