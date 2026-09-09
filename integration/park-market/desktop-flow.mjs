// Real Electron components + authenticated HTTP/crypto adapters supplied by the integration test.
// This is not a packaged-client or production IPC security acceptance test.
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import { _electron as electron } from 'playwright';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
export async function runMarketDesktopFlow({ accounts, invoke, photo }) {
  const temp = await mkdtemp(path.join(tmpdir(), 'otto-market-ui-flow-'));
  let app;
  let completed = false;
  try {
    await build({
      stdin: {
        contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ParkMarketDialog} from ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/components/ParkMarketDialog.tsx'))};import {MarketContactCenter} from ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/components/MarketContactCenter.tsx'))};import ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/styles/tokens.css'))};import ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/styles/app.css'))};const account=${JSON.stringify(accounts)}[Number(new URLSearchParams(location.search).get('account'))];window.otto={enterpriseParkMarket:input=>window.marketInvoke('request',input),enterpriseMarketDrafts:value=>window.marketInvoke('drafts',value),enterpriseMarketSend:input=>window.marketInvoke('send',input),enterpriseMarketMessages:(id,before)=>window.marketInvoke('messages',{id,before})};function Test(){const [open,setOpen]=React.useState(true);const [inbox,setInbox]=React.useState(false);return <><button onClick={()=>{setInbox(false);setOpen(true)}}>打开市场</button><button onClick={()=>{setOpen(false);setInbox(true)}}>打开我的消息</button><ParkMarketDialog open={open} accountId={account.id} draftScope={account.scope} onClose={()=>setOpen(false)}/>{inbox&&<MarketContactCenter accountId={account.id}/>}</>};createRoot(document.getElementById('root')).render(<Test/>);`,
        loader: 'tsx',
        resolveDir: path.join(root, 'packages/desktop'),
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      outfile: path.join(temp, 'ui.js'),
      alias: {
        react: path.join(root, 'node_modules/react'),
        'react-dom': path.join(root, 'node_modules/react-dom'),
      },
    });
    await writeFile(
      path.join(temp, 'index.html'),
      '<html lang="zh-CN"><meta charset="utf-8"><link rel="stylesheet" href="ui.css"><body><div id="root"></div><script src="ui.js"></script></body></html>',
    );
    await writeFile(
      path.join(temp, 'main.cjs'),
      `const {app,BrowserWindow}=require('electron');app.setPath('userData',${JSON.stringify(path.join(temp, 'profile'))});app.whenReady().then(()=>{for(let i=0;i<2;i++)new BrowserWindow({width:1100,height:850,show:true,webPreferences:{contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank');});`,
    );
    app = await electron.launch({ args: [path.join(temp, 'main.cjs')] });
    await app.firstWindow();
    if (app.windows().length < 2)
      await app.waitForEvent('window', { timeout: 5000 });
    const pages = app.windows();
    if (pages.length !== 2)
      throw new Error('Expected two isolated account windows');
    for (let i = 0; i < 2; i++) {
      pages[i].setDefaultTimeout(15000);
      await pages[i].exposeFunction('marketInvoke', (kind, input) =>
        invoke(i, kind, input),
      );
      await pages[i].goto(
        `file://${path.join(temp, 'index.html')}?account=${i}`,
      );
    }
    const [seller, buyer] = pages;
    await seller.getByRole('button', { name: '发布闲置', exact: true }).click();
    await seller.getByLabel('标题 *', { exact: true }).fill('双桌面验收台灯');
    await seller.getByLabel(/^分类/).selectOption('office');
    await seller.getByLabel('售价（元）*', { exact: true }).fill('35.50');
    await seller.getByLabel(/^成色/).selectOption('used');
    await seller.getByLabel(/^功能状态/).selectOption('working');
    await seller
      .getByLabel('物品说明 *', { exact: true })
      .fill('灯光正常，开关和调节功能均可用。');
    await seller.getByLabel('大致交接区域 *', { exact: true }).fill('园区大厅');
    await seller
      .locator('input[type=file]')
      .setInputFiles({
        name: 'lamp.png',
        mimeType: 'image/png',
        buffer: photo,
      });
    await seller.getByRole('button', { name: '正式发布', exact: true }).click();
    await seller.getByText('发布已保存', { exact: true }).waitFor();
    await buyer.getByRole('button', { name: '搜索', exact: true }).click();
    await buyer.getByRole('button', { name: /双桌面验收台灯/ }).click();
    await buyer.getByRole('button', { name: '联系卖家', exact: true }).click();
    await buyer
      .getByLabel('你的问题（1–500 字）')
      .fill('今晚可以在大厅交接吗？');
    await buyer.getByRole('button', { name: '发送问题', exact: true }).click();
    await buyer.getByText('问题已发送，请在“我的消息”查看后续咨询。').waitFor();
    await seller.getByRole('button', { name: '关闭跳蚤市场' }).click();
    await seller.getByRole('button', { name: '打开我的消息' }).click();
    await seller
      .getByRole('button', { name: '回复并接受', exact: true })
      .first()
      .click();
    await seller.getByText('今晚可以在大厅交接吗？', { exact: true }).waitFor();
    await seller
      .getByLabel('消息', { exact: true })
      .fill('可以，晚上七点在大厅见。');
    await seller
      .getByRole('region', { name: '商品会话', exact: true })
      .getByRole('button', { name: '回复并接受', exact: true })
      .click();
    await seller
      .getByText('可以，晚上七点在大厅见。', { exact: true })
      .waitFor();
    await buyer.getByRole('button', { name: '关闭跳蚤市场' }).click();
    await buyer.getByRole('button', { name: '打开我的消息' }).click();
    await buyer
      .getByRole('button', { name: /^商品会话/ })
      .first()
      .click();
    await buyer
      .getByText('可以，晚上七点在大厅见。', { exact: true })
      .waitFor();
    await seller.getByRole('button', { name: '打开市场' }).click();
    await seller
      .getByRole('button', { name: '我的发布记录', exact: true })
      .click();
    await seller.getByRole('button', { name: /双桌面验收台灯/ }).click();
    await seller
      .getByLabel('预留备注（仅本人，最多 200 字）')
      .fill('双桌面私有交接备注');
    await seller.getByRole('button', { name: '设为预留', exact: true }).click();
    await seller
      .getByRole('button', { name: '取消预留', exact: true })
      .waitFor();
    await seller
      .getByRole('button', { name: '标记已售出', exact: true })
      .click();
    await seller.getByRole('button', { name: /撤销.*售出/ }).waitFor();
    const capture = await app.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].webContents.capturePage())
        .toPNG()
        .toString('base64'),
    );
    await writeFile(
      path.join(
        root,
        'docs/research/flea-market-evidence/authenticated-electron-sold.png',
      ),
      Buffer.from(capture, 'base64'),
    );
    completed = true;
    return {
      windows: 2,
      authenticatedHttp: true,
      realEncryptedMessages: true,
      flow: 'publish/contact/reply/reserve/sold',
      packagedClient: false,
    };
  } catch (error) {
    if (app)
      for (let i = 0; i < app.windows().length; i++)
        await writeFile(
          path.join(temp, `failure-${i}.html`),
          await app.windows()[i].content(),
        );
    throw new Error(`${error.message}; diagnostics ${temp}`);
  } finally {
    await app?.close();
    if (completed) await rm(temp, { recursive: true, force: true });
  }
}
