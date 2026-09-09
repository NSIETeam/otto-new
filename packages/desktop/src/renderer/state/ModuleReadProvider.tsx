/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import React, { createContext, useContext, useEffect, useState } from 'react';
import { ModuleReadCache } from './moduleReadCache.js';

const Context = createContext<ModuleReadCache | null>(null);
export function ModuleReadProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const parent = useContext(Context);
  const [cache] = useState(() => new ModuleReadCache());
  useEffect(() => {
    if (parent) return;
    const clear = (): void => cache.clear();
    const invalidated = window.otto?.onEnterpriseSessionInvalidated?.(clear);
    const updated = window.otto?.onEnterpriseAccountUpdated?.(clear);
    window.addEventListener('otto-carpool-data-deleted', clear);
    return () => { invalidated?.(); updated?.(); window.removeEventListener('otto-carpool-data-deleted', clear); };
  }, [cache, parent]);
  return <Context.Provider value={parent ?? cache}>{children}</Context.Provider>;
}
export function useModuleReadCache(): ModuleReadCache {
  const context = useContext(Context);
  const [local] = useState(() => new ModuleReadCache());
  return context ?? local;
}
