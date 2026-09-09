import { loadStarMapCanvas } from '../starMap/loadCanvas.js';
/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import type { ModuleDefinition } from '../moduleCatalog.js';
import type { ModuleReadCache } from './moduleReadCache.js';

/** Intent prefetch is an allowlist of reads. Opening/analysis/mark-read are never executed. */
export async function prefetchModule(
  module: Pick<ModuleDefinition, 'availability' | 'activation'>,
  cache: ModuleReadCache,
): Promise<void> {
  if (module.availability !== 'available' || module.activation.kind !== 'dialog') return;
  const activation = module.activation;
  try {
    if (activation.dialog === 'park-carpool' && window.otto.enterpriseParkCarpoolGet)
      await cache.read('carpool', () => window.otto.enterpriseParkCarpoolGet());
    if (activation.dialog === 'enterprise-memory' && window.otto.enterpriseKnowledgeList)
      await cache.read('knowledge:', () => window.otto.enterpriseKnowledgeList({ includeReview: true }), 30_000);
    if (activation.dialog !== 'park') return;
    if (activation.target === 'enterprise-star-map') {
      void loadStarMapCanvas().catch(() => undefined);
      if (window.otto.enterpriseParkStarMap) await cache.read('star-map', () => window.otto.enterpriseParkStarMap(), 30_000);
    }
    else if (activation.target === 'meeting-room' && window.otto.enterpriseParkResources)
      await cache.read('resources', () => window.otto.enterpriseParkResources());
    else if (['announcement', 'satisfaction'].includes(activation.target) && window.otto.enterpriseParkPublications)
      await cache.read('publications', () => window.otto.enterpriseParkPublications());
  } catch { /* Speculative reads do not show errors until the user opens the module. */ }
}
