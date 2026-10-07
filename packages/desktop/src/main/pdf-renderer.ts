/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
// A dedicated child entry, never the ordinary desktop app / customer profile.
import { app, BrowserWindow, session } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function printIsolatedPdf(html: string, output: string, profile: string): Promise<void> {
  for (const file of [html, output, profile]) {
    if (!path.isAbsolute(file)) throw new Error('PDF renderer requires absolute staging paths');
  }
  const root = path.dirname(html);
  if (path.dirname(output) !== root || path.dirname(profile) !== root
    || fs.lstatSync(html).isSymbolicLink()) throw new Error('Invalid PDF staging paths');
  fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  app.setPath('userData', profile);
  app.setPath('sessionData', profile);
  app.commandLine.appendSwitch('disable-background-networking');
  app.commandLine.appendSwitch('disable-component-update');
  await app.whenReady();
  const isolated = session.fromPartition('pdf-' + process.pid);
  const url = pathToFileURL(html).href;
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: details.url !== url || details.resourceType !== 'mainFrame',
  }));
  const win = new BrowserWindow({
    show: false, width: 900, height: 1100,
    webPreferences: {
      session: isolated, javascript: false, nodeIntegration: false,
      nodeIntegrationInWorker: false, sandbox: true, contextIsolation: true,
      webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
      devTools: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());
  try {
    await win.loadURL(url);
    const data = await win.webContents.printToPDF({
      printBackground: true, preferCSSPageSize: true, pageSize: 'A4',
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font-size:9px;color:#667085;text-align:center;width:100%"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    });
    fs.writeFileSync(output, data, { mode: 0o600, flag: 'wx' });
  } finally {
    win.destroy();
  }
}

export async function runPdfRenderer(html: string, output: string, profile: string): Promise<void> {
  // The parent also bounds and kills the entire tree. Never keep an orphan app.
  const deadline = setTimeout(() => app.exit(1), 40_000);
  try {
    await printIsolatedPdf(html, output, profile);
  } catch {
    clearTimeout(deadline);
    console.error('Isolated PDF rendering failed; the original document was not modified.');
    app.exit(1);
    return;
  } finally {
    clearTimeout(deadline);
  }
  app.exit(0);
}

// Electron's require.main is its internal bootstrap, not the app entry. Compare
// its explicit argv entry; importing this helper for tests never starts an app.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  void runPdfRenderer(process.argv[2], process.argv[3], process.argv[4]);
}
