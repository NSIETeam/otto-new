/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { OttoChat } from './ottoChat.js';
import type { Config } from '../config/config.js';
import type { ContentGenerator } from './contentGenerator.js';

it('reads only user text without cloning attachment/tool payloads or exposing mutable history', () => {
  const chat = new OttoChat(
    { getModel: () => 'fixture' } as Config,
    {} as ContentGenerator,
    {},
    [
      {
        role: 'user',
        parts: [
          { text: 'runtime rules' },
          { inlineData: { mimeType: 'image/png', data: 'large-payload' } },
        ],
      },
      { role: 'model', parts: [{ text: 'model text' }] },
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: 'read_file',
              response: { text: 'tool text' },
            },
          },
        ],
      },
    ],
  );
  const clone = vi
    .spyOn(globalThis, 'structuredClone')
    .mockImplementation(() => {
      throw new Error('No whole-history cloning');
    });
  try {
    const texts = chat.getUserTextHistory();
    expect(texts).toEqual(['runtime rules']);
    texts.push('caller edit');
    expect(chat.getUserTextHistory()).toEqual(['runtime rules']);
    chat.setHistory([{ role: 'user', parts: [{ text: 'compressed' }] }]);
    expect(chat.getUserTextHistory()).toEqual(['compressed']);
    chat.clearHistory();
    expect(chat.getUserTextHistory()).toEqual([]);
  } finally {
    clone.mockRestore();
  }
});
