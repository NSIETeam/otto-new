/**
 * @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type {
  DesktopPetBehaviorEvent,
  DesktopPetState,
} from '../../preload/index.js';
import {
  OttoPetStage,
  type DesktopPetReaction,
} from './OttoPetStage.js';

const DEFAULT_STATE: DesktopPetState = {
  running: false,
  workLabel: '等待你的下一项工作',
  sessionId: null,
};

const PET_BEHAVIORS: Record<DesktopPetBehaviorEvent, {
  animation: DesktopPetReaction;
  message: string;
  duration: number;
}> = {
  'task-completed': {
    animation: 'waving',
    message: '任务完成，交给你啦',
    duration: 900,
  },
  'pet-clicked': {
    animation: 'jumping',
    message: '我在呢，需要我做什么？',
    duration: 1_000,
  },
  'open-main': {
    animation: 'review',
    message: '正在打开 Otto',
    duration: 1_150,
  },
};

const CLICK_DELAY_MS = 260;
const LONG_PRESS_CLICK_CUTOFF_MS = 360;

/** 独立透明 BrowserWindow 的唯一内容；只有宠物本体，没有卡片外壳。 */
export function DesktopPetSurface(): React.JSX.Element {
  const [state, setState] = useState<DesktopPetState>(DEFAULT_STATE);
  const [reaction, setReaction] = useState<DesktopPetReaction | null>(null);
  const [bubble, setBubble] = useState<string | null>(null);
  const [pointerHeld, setPointerHeld] = useState(false);
  const reactionTimerRef = useRef<number>();
  const clickTimerRef = useRef<number>();
  const dragRef = useRef<{
    pointerId: number;
    startedAt: number;
    secondClickArmed: boolean;
    startPromise: Promise<void>;
  }>();

  const playBehavior = useCallback((event: DesktopPetBehaviorEvent): void => {
    const behavior = PET_BEHAVIORS[event];
    setReaction(behavior.animation);
    setBubble(behavior.message);
    if (reactionTimerRef.current) window.clearTimeout(reactionTimerRef.current);
    reactionTimerRef.current = window.setTimeout(() => {
      setReaction(null);
      setBubble(null);
    }, behavior.duration);
  }, []);

  useEffect(() => {
    let alive = true;
    void window.otto.desktopPetGetState().then((next) => {
      if (alive) setState(next);
    }).catch(() => undefined);
    const unsubscribe = window.otto.onDesktopPetState((next) => {
      if (alive) setState(next);
    });
    const unsubscribeReaction = window.otto.onDesktopPetReaction((event) => {
      if (alive) playBehavior(event);
    });
    const unsubscribeNativeDragEnd = window.otto.onDesktopPetNativeDragEnd(() => {
      if (!alive || !dragRef.current) return;
      dragRef.current = undefined;
      setPointerHeld(false);
      window.otto.desktopPetSetInteractive(true);
    });
    return () => {
      alive = false;
      unsubscribe();
      unsubscribeReaction();
      unsubscribeNativeDragEnd();
      const activeDrag = dragRef.current;
      dragRef.current = undefined;
      if (activeDrag) {
        void activeDrag.startPromise
          .then(() => window.otto.desktopPetDragEnd())
          .catch(() => undefined);
      }
      if (reactionTimerRef.current) window.clearTimeout(reactionTimerRef.current);
      if (clickTimerRef.current) window.clearTimeout(clickTimerRef.current);
    };
  }, [playBehavior]);

  useEffect(() => {
    const reportHit = (event: MouseEvent): void => {
      const target = typeof document.elementFromPoint === 'function'
        ? document.elementFromPoint(event.clientX, event.clientY)
        : event.target;
      const overPet = Boolean(
        target instanceof Element &&
        target.closest('.otto-desktop-pet__hit-target'),
      );
      window.otto.desktopPetSetInteractive(overPet || Boolean(dragRef.current));
    };
    const releaseTransparentArea = (): void => {
      if (!dragRef.current) window.otto.desktopPetSetInteractive(false);
    };
    window.addEventListener('mousemove', reportHit, true);
    window.addEventListener('mouseleave', releaseTransparentArea, true);
    return () => {
      window.removeEventListener('mousemove', reportHit, true);
      window.removeEventListener('mouseleave', releaseTransparentArea, true);
      window.otto.desktopPetSetInteractive(false);
    };
  }, []);

  const handlePointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const secondClickArmed = Boolean(clickTimerRef.current);
    if (clickTimerRef.current) {
      window.clearTimeout(clickTimerRef.current);
      clickTimerRef.current = undefined;
    }
    window.otto.desktopPetSetInteractive(true);
    setPointerHeld(true);
    const drag = {
      pointerId: event.pointerId,
      startedAt: Date.now(),
      secondClickArmed,
      startPromise: window.otto.desktopPetDragStart(),
    };
    dragRef.current = drag;
  };

  const finishDrag = useCallback(async (pointerId: number): Promise<void> => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = undefined;
    setPointerHeld(false);
    await drag.startPromise.catch(() => undefined);
    const moved = await window.otto.desktopPetDragEnd();
    // The cursor is still over the pet on release. Keep this window
    // interactive until the next forwarded mousemove reports that it left the
    // actual hit target.
    window.otto.desktopPetSetInteractive(true);
    const heldFor = Date.now() - drag.startedAt;
    if (moved || heldFor >= LONG_PRESS_CLICK_CUTOFF_MS) return;

    if (drag.secondClickArmed) {
      playBehavior('open-main');
      void window.otto.desktopPetOpenMain();
      return;
    }
    clickTimerRef.current = window.setTimeout(() => {
      clickTimerRef.current = undefined;
      playBehavior('pet-clicked');
    }, CLICK_DELAY_MS);
  }, [playBehavior]);

  useEffect(() => {
    const finishFromWindowMouseUp = (event: MouseEvent): void => {
      if (event.button !== 0) return;
      const drag = dragRef.current;
      if (drag) void finishDrag(drag.pointerId);
    };
    window.addEventListener('mouseup', finishFromWindowMouseUp, true);
    return () => {
      window.removeEventListener('mouseup', finishFromWindowMouseUp, true);
    };
  }, [finishDrag]);

  return (
    <main className="otto-desktop-pet-surface">
      {bubble ? <span className="otto-desktop-pet__bubble">{bubble}</span> : null}
      <div
        className="otto-desktop-pet__hit-target"
        title="单击互动 · 双击打开 Otto · 按住拖动 · 右键更多"
        role="button"
        tabIndex={0}
        aria-label="Otto 桌面宠物，单击互动，双击打开 Otto"
        onPointerDown={handlePointerDown}
        onPointerUp={(event) => void finishDrag(event.pointerId)}
        onPointerCancel={() => {
          // Keep native cursor polling alive. BrowserWindow relocation can
          // cancel Chromium's pointer sequence before the physical button is
          // released; the window-level mouseup listener ends the drag instead.
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          void window.otto.desktopPetShowMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            void window.otto.desktopPetOpenMain();
          } else if (event.key === ' ') {
            event.preventDefault();
            playBehavior('pet-clicked');
          }
        }}
      >
        <OttoPetStage
          variant="desktop"
          running={state.running}
          workLabel={state.workLabel}
          reaction={reaction}
          interactionHeld={pointerHeld}
        />
      </div>
    </main>
  );
}
