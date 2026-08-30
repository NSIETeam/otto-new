import { describe, expect, it } from 'vitest';
import { displayOttoVersion } from './versionDisplay.js';

describe('displayOttoVersion', () => {
  it('renders the 1.9.14 beta release with its product label', () => {
    expect(displayOttoVersion('1.9.14-beta.0')).toBe('1.9.14beta');
  });

  it('leaves stable versions unchanged', () => {
    expect(displayOttoVersion('1.9.14')).toBe('1.9.14');
  });
});
