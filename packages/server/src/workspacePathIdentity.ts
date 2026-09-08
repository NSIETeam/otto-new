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

  constructor(root: string) {
    this.lexicalPath = path.resolve(root);
    try {
      this.bound = observe(this.lexicalPath);
    } catch {
      // Unknown roots remain fail-closed; construction grants no permissions.
    }
    this.canonicalPath = this.bound?.root ?? this.lexicalPath;
  }

  currentPath(): string | undefined {
    if (!this.bound) return undefined;
    try {
      const anchor = observe(this.bound.anchor);
      if (
        anchor.anchor !== this.bound.anchor ||
        anchor.canonicalAnchor !== this.bound.canonicalAnchor ||
        anchor.fileId !== this.bound.fileId ||
        observe(this.lexicalPath).root !== this.canonicalPath
      )
        return undefined;
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
