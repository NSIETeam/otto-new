/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
export const loadStarMapCanvas = () => import('./EnterpriseGraphCanvas.js').then(module => ({
  default: module.EnterpriseGraphCanvas,
}));
