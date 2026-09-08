/** Session-only geometry, never enterprise profile text. Logout invalidates pending unmount saves. */
export interface SavedLayout {
  positions: Array<{ id: string; x: number; y: number }>;
  camera: { x: number; y: number; zoom: number };
}
let generation = 0;
const layouts = new Map<string, SavedLayout>();
export const layoutGeneration = (): number => generation;
export function clearLayouts(): void {
  generation++;
  layouts.clear();
}
export function readLayout(
  key: string,
  visibleIds: Set<string>,
): SavedLayout | null {
  const layout = layouts.get(key);
  if (!layout) return null;
  const pruned = {
    camera: { ...layout.camera },
    positions: layout.positions
      .filter((point) => visibleIds.has(point.id))
      .map((point) => ({ ...point })),
  };
  layouts.set(key, pruned);
  return pruned;
}
export function saveLayout(
  key: string,
  layout: SavedLayout,
  expectedGeneration: number,
): void {
  if (expectedGeneration !== generation) return;
  layouts.delete(key);
  layouts.set(key, layout);
  while (layouts.size > 8) layouts.delete(layouts.keys().next().value!);
}
