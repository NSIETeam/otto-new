/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
interface Entry {
  value?: unknown;
  updatedAt: number;
  pending?: Promise<unknown>;
}

/** Owned by one authenticated workspace, never persisted or shared across logins. */
export class ModuleReadCache {
  private readonly entries = new Map<string, Entry>();

  peek<T>(key: string): T | undefined {
    return this.entries.get(key)?.value as T | undefined;
  }

  set<T>(key: string, value: T): void {
    this.entries.set(key, { value, updatedAt: Date.now() });
    if (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!);
  }

  isCurrent<T>(key: string, value: T): boolean {
    const entry = this.entries.get(key);
    return Boolean(entry?.updatedAt && entry.value === value);
  }

  remove(key: string): void {
    this.entries.delete(key);
  }

  removePrefix(prefix: string): void {
    for (const key of this.entries.keys()) if (key.startsWith(prefix)) this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  invalidate(key: string): void {
    const previous = this.entries.get(key);
    this.entries.set(key, { value: previous?.value, updatedAt: 0 });
  }

  read<T>(key: string, load: () => Promise<T>, maxAge = 4_000): Promise<T> {
    const previous = this.entries.get(key);
    if (previous?.pending) return previous.pending as Promise<T>;
    if (previous?.updatedAt && Date.now() - previous.updatedAt < maxAge)
      return Promise.resolve(previous.value as T);
    const entry: Entry = { value: previous?.value, updatedAt: previous?.updatedAt ?? 0 };
    this.entries.set(key, entry);
    // Bound retained query/filter combinations; pending callers still settle normally.
    if (this.entries.size > 100) this.entries.delete(this.entries.keys().next().value!);
    const pending = Promise.resolve().then(load).then(value => {
      if (this.entries.get(key) === entry) {
        entry.value = value;
        entry.updatedAt = Date.now();
      }
      return value;
    }).finally(() => { if (entry.pending === pending) entry.pending = undefined; });
    entry.pending = pending;
    return pending;
  }
}
