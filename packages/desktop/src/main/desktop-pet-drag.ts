export interface DesktopPetDragState {
  anchorWindowX: number;
  anchorWindowY: number;
  anchorCursorX: number;
  anchorCursorY: number;
}

export interface DesktopPetDragStep {
  position: { x: number; y: number };
  displacement: { x: number; y: number };
}

export interface DesktopPetWorkArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function createDesktopPetDragState(
  windowPosition: { x: number; y: number },
  cursor: { x: number; y: number },
): DesktopPetDragState {
  return {
    anchorWindowX: windowPosition.x,
    anchorWindowY: windowPosition.y,
    anchorCursorX: cursor.x,
    anchorCursorY: cursor.y,
  };
}

/**
 * Resolves a drag from one immutable window/cursor anchor pair.
 *
 * The window always receives the cursor's displacement from the original
 * press point. Intermediate sampling frequency cannot accumulate error and a
 * one-pixel cursor movement can never turn into a larger window movement.
 */
export function advanceDesktopPetDrag(
  state: DesktopPetDragState,
  cursor: { x: number; y: number },
): DesktopPetDragStep {
  const displacement = {
    x: cursor.x - state.anchorCursorX,
    y: cursor.y - state.anchorCursorY,
  };

  return {
    position: {
      x: state.anchorWindowX + displacement.x,
      y: state.anchorWindowY + displacement.y,
    },
    displacement,
  };
}

/**
 * Starts a fresh anchor at the current cursor and actual window position.
 *
 * Call this when screen-edge containment changed the desired position. Without
 * rebasing, the invisible out-of-bounds distance becomes "position debt" and
 * the cursor must travel back through it before the pet leaves the edge.
 */
export function rebaseDesktopPetDrag(
  windowPosition: { x: number; y: number },
  cursor: { x: number; y: number },
): DesktopPetDragState {
  return createDesktopPetDragState(windowPosition, cursor);
}

/** Keeps the complete native window inside one display work area. */
export function clampDesktopPetToWorkArea(
  position: { x: number; y: number },
  windowSize: { width: number; height: number },
  workArea: DesktopPetWorkArea,
): { x: number; y: number } {
  const width = Number.isFinite(windowSize.width) && windowSize.width > 0
    ? Math.round(windowSize.width)
    : 1;
  const height = Number.isFinite(windowSize.height) && windowSize.height > 0
    ? Math.round(windowSize.height)
    : 1;
  const maxX = workArea.x + Math.max(0, workArea.width - width);
  const maxY = workArea.y + Math.max(0, workArea.height - height);
  return {
    x: Math.round(Math.min(Math.max(position.x, workArea.x), maxX)),
    y: Math.round(Math.min(Math.max(position.y, workArea.y), maxY)),
  };
}
