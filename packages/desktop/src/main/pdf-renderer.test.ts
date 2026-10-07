/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const partition = {
    setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
    webRequest: { onBeforeRequest: vi.fn() },
  };
  const window = {
    loadURL: vi.fn(async () => undefined), destroy: vi.fn(),
    webContents: { setWindowOpenHandler: vi.fn(), on: vi.fn(),
      printToPDF: vi.fn(async () => Buffer.from('%PDF-1.7\n%%EOF\n')) },
  };
  // eslint-disable-next-line prefer-arrow-callback -- BrowserWindow must support new.
  const construct = vi.fn(function () { return window; });
  return { partition, window, construct, app: { setPath: vi.fn(), exit: vi.fn(),
    whenReady: vi.fn(async () => undefined), commandLine: { appendSwitch: vi.fn() } } };
});
vi.mock('electron', () => ({ app: mocks.app, BrowserWindow: mocks.construct,
  session: { fromPartition: vi.fn(() => mocks.partition) } }));
import { printIsolatedPdf, runPdfRenderer } from './pdf-renderer.js';

let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-pdf-host-'));
  fs.writeFileSync(path.join(root, 'doc.html'), '<p>synthetic</p>');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const render = () => printIsolatedPdf(path.join(root, 'doc.html'), path.join(root, 'doc.pdf'), path.join(root, 'profile'));

describe('isolated desktop PDF host', () => {
  it('uses the bundled browser with all active capabilities disabled and a private profile', async () => {
    await render();
    expect(mocks.app.setPath).toHaveBeenCalledWith('userData', path.join(root, 'profile'));
    expect(mocks.app.setPath).toHaveBeenCalledWith('sessionData', path.join(root, 'profile'));
    expect(mocks.construct).toHaveBeenCalledWith(expect.objectContaining({ show: false,
      webPreferences: expect.objectContaining({ javascript: false, nodeIntegration: false,
        sandbox: true, contextIsolation: true, webSecurity: true, webviewTag: false }) }));
    expect(mocks.window.destroy).toHaveBeenCalledOnce();
    expect(mocks.window.webContents.printToPDF).toHaveBeenCalledWith(expect.objectContaining({
      preferCSSPageSize: true, printBackground: true, displayHeaderFooter: true }));
    expect(fs.readFileSync(path.join(root, 'doc.pdf'), 'utf8')).toContain('%PDF-');
  });

  it('denies network, local subresources, permissions and popups', async () => {
    await render();
    const filter = mocks.partition.webRequest.onBeforeRequest.mock.calls[0][0];
    for (const details of [
      { url: 'https://example.invalid/', resourceType: 'mainFrame' },
      { url: 'file:///etc/passwd', resourceType: 'image' },
      { url: pathToFileURL(path.join(root, 'doc.html')).href, resourceType: 'subFrame' },
    ]) {
      const callback = vi.fn(); filter(details, callback);
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    }
    const allowed = vi.fn();
    filter({ url: pathToFileURL(path.join(root, 'doc.html')).href, resourceType: 'mainFrame' }, allowed);
    expect(allowed).toHaveBeenCalledWith({ cancel: false });
    const permission = vi.fn();
    mocks.partition.setPermissionRequestHandler.mock.calls[0][0](null, 'media', permission);
    expect(permission).toHaveBeenCalledWith(false);
    expect(mocks.partition.setPermissionCheckHandler.mock.calls[0][0]()).toBe(false);
    expect(mocks.window.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
    const preventDefault = vi.fn();
    for (const [, callback] of mocks.window.webContents.on.mock.calls) callback({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
  });

  it('destroys the hidden renderer when printing fails without writing a PDF', async () => {
    mocks.window.webContents.printToPDF.mockRejectedValueOnce(new Error('printer failed'));
    await expect(render()).rejects.toThrow('printer failed');
    expect(mocks.window.destroy).toHaveBeenCalledOnce();
    expect(fs.existsSync(path.join(root, 'doc.pdf'))).toBe(false);
  });

  it('rejects non-staging paths and never overwrites an existing output', async () => {
    await expect(printIsolatedPdf('relative.html', path.join(root, 'doc.pdf'), path.join(root, 'profile'))).rejects.toThrow('absolute');
    await expect(printIsolatedPdf(path.join(root, 'doc.html'), path.join(root, 'outside', 'doc.pdf'), path.join(root, 'profile'))).rejects.toThrow('staging');
    fs.writeFileSync(path.join(root, 'doc.pdf'), 'existing');
    await expect(render()).rejects.toThrow();
    expect(fs.readFileSync(path.join(root, 'doc.pdf'), 'utf8')).toBe('existing');
    expect(mocks.window.destroy).toHaveBeenCalledOnce();
  });

  it('exits zero only after successful printing and nonzero for a real failure', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      await runPdfRenderer(path.join(root, 'doc.html'), path.join(root, 'doc.pdf'), path.join(root, 'profile'));
      expect(mocks.app.exit).toHaveBeenLastCalledWith(0);
      await runPdfRenderer('invalid', path.join(root, 'doc.pdf'), path.join(root, 'profile'));
      expect(mocks.app.exit).toHaveBeenLastCalledWith(1);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('original document was not modified'));
    } finally { error.mockRestore(); }
  });

  it('bounds a hanging renderer with a hard child deadline', async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let fail!: (error: Error) => void;
    mocks.app.whenReady.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    try {
      const request = runPdfRenderer(path.join(root, 'doc.html'), path.join(root, 'doc.pdf'), path.join(root, 'profile'));
      await vi.advanceTimersByTimeAsync(40_000);
      expect(mocks.app.exit).toHaveBeenCalledWith(1);
      fail(new Error('synthetic timeout'));
      await request;
      expect(fs.existsSync(path.join(root, 'doc.pdf'))).toBe(false);
    } finally { vi.useRealTimers(); error.mockRestore(); }
  });
});
