/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */

import type { RpaDriver } from './ports.js';

/** Routes the fixed action namespaces without allowing arbitrary driver names. */
export class CompositeRpaDriver implements RpaDriver {
  constructor(
    private readonly web: RpaDriver,
    private readonly desktop?: RpaDriver,
  ) {}

  execute(input: Parameters<RpaDriver['execute']>[0]): ReturnType<RpaDriver['execute']> {
    if (input.step.action.startsWith('web.') || input.step.action === 'checkpoint') {
      return this.web.execute(input);
    }
    if (input.step.action.startsWith('desktop.')) {
      if (!this.desktop) {
        throw new Error('Desktop RPA is unavailable: the signed accessibility host is not registered.');
      }
      return this.desktop.execute(input);
    }
    throw new Error(`Unsupported RPA driver namespace: ${input.step.action}`);
  }
}
