/* global innerWidth, innerHeight, document, requestAnimationFrame */
import { Buffer } from 'node:buffer';
import process from 'node:process';
import console from 'node:console';
// Layout/OS draft acceptance only. Read-only marketplace responses below are explicit fixtures.
// Authentication, publishing and encrypted messaging are covered by real-flows tests separately.
import { build } from 'esbuild';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const require = createRequire(path.join(root, 'packages/desktop/package.json'));
const temp = await mkdtemp(path.join(tmpdir(), 'otto-market-layout-'));
const evidence = path.join(root, 'docs/research/flea-market-evidence');
await mkdir(evidence, { recursive: true });
let app;
try {
  await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ParkMarketDialog} from ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/components/ParkMarketDialog.tsx'))};import ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/styles/tokens.css'))};import ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/styles/app.css'))};function Test(){const [open,setOpen]=React.useState(true);return <ParkMarketDialog open={open} accountId="layout-user" draftScope={{server:'https://layout.test',organization:'layout-org',account:'layout-user'}} onClose={()=>setOpen(false)}/>;}createRoot(document.getElementById('root')).render(<Test/>);`,
      loader: 'tsx',
      resolveDir: path.join(root, 'packages/desktop'),
    },
    bundle: true,
    platform: 'browser',
    format: 'iife',
    outfile: path.join(temp, 'ui.js'),
    alias: {
      react: path.dirname(require.resolve('react/package.json')),
      'react-dom': path.dirname(require.resolve('react-dom/package.json')),
    },
    loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff2': 'dataurl' },
    logLevel: 'warning',
  });
  await build({
    entryPoints: [path.join(root, 'packages/desktop/src/main/park-market.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(temp, 'drafts.cjs'),
    logLevel: 'warning',
  });
  await writeFile(
    path.join(temp, 'index.html'),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\';script-src \'self\';style-src \'self\' \'unsafe-inline\';img-src \'self\' data:"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>',
  );
  await writeFile(
    path.join(temp, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('otto',{enterpriseParkMarket:input=>ipcRenderer.invoke('market-layout-request',input),enterpriseMarketDrafts:(...args)=>ipcRenderer.invoke('market-layout-drafts',...args)});`,
  );
  await writeFile(
    path.join(temp, 'main.cjs'),
    `const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');const path=require('node:path');const {MarketDraftStore,assertMarketDraftScope}=require('./drafts.cjs');app.setPath('userData',path.join(__dirname,'profile'));app.whenReady().then(async()=>{if(!safeStorage.isEncryptionAvailable())throw new Error('OS secure storage unavailable');const scope={server:'https://layout.test',organization:'layout-org',account:'layout-user'};const store=new MarketDraftStore(path.join(__dirname,'drafts'),v=>safeStorage.encryptString(v),v=>safeStorage.decryptString(v));const win=new BrowserWindow({width:1024,height:768,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});ipcMain.handle('market-layout-request',(_event,input)=>{if(input.path==='/settings')return {parkId:'layout-park',enabled:true,ready:true,rules:'仅限个人闲置实物',contact:'测试服务台',version:1,canModerate:false};if(input.method==='PUT'&&input.path.startsWith('/drafts/'))return {ok:true};if(input.method!=='GET')throw new Error('Layout fixture does not publish');return {items:[],nextCursor:null};});ipcMain.handle('market-layout-drafts',(_event,value,expected)=>{if(value!==undefined){assertMarketDraftScope(scope,expected);store.save(scope,value);}return store.load(scope);});globalThis.marketLayout={store,scope};await win.loadFile(path.join(__dirname,'index.html'));}).catch(e=>{console.error(e);app.exit(1);});`,
  );
  app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(temp, 'main.cjs')],
    timeout: 30000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15000);
  await page.getByRole('button', { name: '发布闲置' }).click();
  await page.getByLabel('标题 *', { exact: true }).fill('真实系统安全存储草稿');
  const results = [];
  for (const zoom of [1, 1.25, 1.5]) {
    await app.evaluate(({ BrowserWindow }, factor) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setSize(1024, 768);
      win.webContents.setZoomFactor(factor);
    }, zoom);
    const button = page.getByRole('button', { name: '正式发布', exact: true });
    await button.evaluate(element => element.scrollIntoView({block: 'center'}));
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const geometry = await button.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const clip = element.closest('dialog').getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        right: rect.right,
        bottom: rect.bottom,
        clipped: rect.bottom > clip.bottom || rect.top < clip.top,
        width: innerWidth,
        height: innerHeight,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    if (
      geometry.x < 0 ||
      geometry.right > geometry.width ||
      geometry.bottom > geometry.height ||
      geometry.overflow || geometry.clipped
    )
      throw new Error(JSON.stringify({ zoom, geometry }));
    const capture = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString('base64'),
    );
    await writeFile(
      path.join(evidence, `market-layout-${zoom}.png`),
      Buffer.from(capture, 'base64'),
    );
    results.push({ zoom, geometry });
  }
  await page.getByLabel('标题 *', { exact: true }).fill('退出前最后输入草稿');
  await page.getByRole('button', { name: '关闭跳蚤市场' }).click();
  await page.getByRole('button', { name: '保存草稿并退出' }).click();
  await page
    .getByRole('dialog', { name: '跳蚤市场', exact: true })
    .waitFor({ state: 'hidden' });
  const saved = await app.evaluate(() => {
    const { store, scope } = globalThis.marketLayout;
    return {
      drafts: store.load(scope),
      other: store.load({ ...scope, account: 'another-user' }),
    };
  });
  if (
    saved.drafts[0]?.form?.title !== '退出前最后输入草稿' ||
    saved.other.length
  )
    throw new Error('OS draft isolation/flush failed');
  await writeFile(
    path.join(evidence, 'market-layout.json'),
    JSON.stringify(
      {
        platform: process.platform,
        fixtures:
          'read-only marketplace settings; no publishing or authentication simulated as acceptance',
        results,
        osEncryptedDraftFlush: true,
        otherAccountEmpty: true,
      },
      null,
      2,
    ),
  );
  console.log(
    'PASS: Electron 1024x768 at 100/125/150%, real OS-encrypted draft flush and account isolation',
  );
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
