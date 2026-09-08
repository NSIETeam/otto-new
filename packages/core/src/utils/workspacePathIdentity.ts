/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';

function observe(root: string) {
  let anchor = root;
  while (!existsSync(anchor)) {
    const parent = path.dirname(anchor);
    if (parent === anchor)
      throw new Error('Workspace has no observable ancestor');
    anchor = parent;
  }
  const info = statSync(anchor, { bigint: true });
  if (!info.isDirectory() || info.ino === 0n)
    throw new Error('Workspace ancestor is not an identifiable directory');
  const canonicalAnchor = realpathSync(anchor);
  return {
    anchor,
    canonicalAnchor,
    fileId: `${info.dev}:${info.ino}`,
    root: path.resolve(canonicalAnchor, path.relative(anchor, root)),
  };
}

/** Bind only the host-selected workspace, including OS aliases such as macOS
 * /var -> /private/var. Never follow a model-selected descendant to authorize it.
 * Recheck the original anchor before using this identity after an async wait. */
export class WorkspacePathIdentity {
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  private readonly bound?: ReturnType<typeof observe>;
  private readonly anchors = new Map<string, ReturnType<typeof observe>>();

  constructor(root: string) {
    this.lexicalPath = path.resolve(root);
    try {
      this.bound = observe(this.lexicalPath);
      this.anchors.set(this.bound.anchor, this.bound);
    } catch {
      // Unknown roots remain fail-closed; construction grants no permissions.
    }
    this.canonicalPath = this.bound?.root ?? this.lexicalPath;
  }

  currentPath(): string | undefined {
    if (!this.bound) return undefined;
    try {
      for (const bound of this.anchors.values()) {
        const current = observe(bound.anchor);
        if (current.anchor !== bound.anchor ||
            current.canonicalAnchor !== bound.canonicalAnchor ||
            current.fileId !== bound.fileId) return undefined;
      }
      const current = observe(this.lexicalPath);
      if (current.root !== this.canonicalPath) return undefined;
      // A not-yet-created workspace starts bound to its existing ancestor.
      // Pin every newly observed directory, not just the final root: neither
      // may later disappear or be replaced during an approval/render wait.
      for (let cursor = current.anchor; cursor !== this.bound.anchor; cursor = path.dirname(cursor)) {
        if (cursor === path.dirname(cursor)) return undefined;
        if (!this.anchors.has(cursor)) {
          const anchor = observe(cursor);
          // A concurrent disappearance must not store the fallback parent as
          // this child's identity and prevent that child from ever being pinned.
          if (anchor.anchor !== cursor) return undefined;
          this.anchors.set(cursor, anchor);
        }
      }
      return this.canonicalPath;
    } catch {
      return undefined;
    }
  }

  resolveTarget(raw: string): string {
    const root = this.currentPath();
    if (!root) throw new Error('Workspace identity changed or is unavailable');
    const target = path.resolve(this.lexicalPath, raw);
    const relative = path.relative(this.lexicalPath, target);
    if (
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    )
      return path.resolve(root, relative);
    return target;
  }
}
