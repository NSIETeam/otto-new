/** @license Copyright 2026 Otto SPDX-License-Identifier: Apache-2.0 */
// Isolated acceptance harness: real React components, HTTP adapter, SQLite and
// native MLS. Synthetic map fixtures and test bearer identities are explicit.
import { build } from 'esbuild';
import process from 'node:process';
import console from 'node:console';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { _electron as electron } from 'playwright';
const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../..',
);
const require = createRequire(path.join(root, 'packages/desktop/package.json'));
const temp = await mkdtemp(path.join(tmpdir(), 'otto-carpool-electron-'));
const evidence =
  process.env.OTTO_CARPOOL_EVIDENCE_DIR ??
  path.join(root, 'docs/research/carpool-delivery/evidence');
await mkdir(evidence, { recursive: true });
let app;
try {
  await build({
    stdin: {
      contents: `import React from 'react';import {createRoot} from 'react-dom/client';import {ParkCarpoolDialog} from ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/components/ParkCarpoolDialog.tsx'))};import ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/styles/tokens.css'))};import ${JSON.stringify(path.join(root, 'packages/desktop/src/renderer/styles/app.css'))};createRoot(document.getElementById('root')).render(<ParkCarpoolDialog open onClose={()=>{}}/>);`,
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
    entryPoints: [
      path.join(root, 'packages/desktop/src/main/park-carpool-chat.ts'),
    ],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.join(temp, 'chat.cjs'),
    external: ['@otto/native'],
    plugins: [
      {
        name: 'native-path',
        setup(builder) {
          builder.onResolve({ filter: /^@otto\/native$/ }, () => ({
            path: path.join(root, 'otto-native/dist/index.js'),
            external: true,
          }));
        },
      },
    ],
    logLevel: 'warning',
  });
  await writeFile(
    path.join(temp, 'index.html'),
    '<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\';script-src \'self\';style-src \'self\' \'unsafe-inline\';img-src \'self\' data:"><link rel="stylesheet" href="ui.css"><div id="root"></div><script src="ui.js"></script>',
  );
  const methods = [
    'Get',
    'Refresh',
    'SearchPlaces',
    'Publish',
    'Stop',
    'Confirm',
    'RoutePreview',
    'WorkflowGet',
    'WorkflowExecute',
    'ChatRead',
    'ChatSend',
  ];
  await writeFile(
    path.join(temp, 'preload.cjs'),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('otto',Object.fromEntries(${JSON.stringify(methods)}.map(name=>['enterpriseParkCarpool'+name,(...args)=>ipcRenderer.invoke('carpool-test',name,args)])));`,
  );
  await writeFile(
    path.join(temp, 'main.cjs'),
    `
const {app,BrowserWindow,ipcMain,safeStorage}=require('electron');const {randomBytes,generateKeyPairSync,sign}=require('node:crypto');const {createServer}=require('node:http');const {once}=require('node:events');const path=require('node:path');const {ParkCarpoolChat}=require('./chat.cjs');app.setPath('userData',${JSON.stringify(path.join(temp, 'user-data'))});
app.whenReady().then(async()=>{console.error('acceptance: app ready');
 const {Database}=await import(${JSON.stringify(path.join(root, 'packages/server/dist/src/modules/data_platform/sqliteCompat.js'))});
 const {createEncryptedFieldCipher}=await import(${JSON.stringify(path.join(root, 'packages/server/dist/src/modules/data_platform/encryptedFieldCipher.js'))});
 const {createParkCarpoolService}=await import(${JSON.stringify(path.join(root, 'packages/server/dist/src/modules/park_carpool/parkCarpoolService.js'))});
 const {createParkCarpoolSqliteStore}=await import(${JSON.stringify(path.join(root, 'packages/server/dist/src/modules/park_carpool/parkCarpoolSqliteRepository.js'))});
 const {PARK_CARPOOL_SCHEMA_CONTRIBUTOR}=await import(${JSON.stringify(path.join(root, 'packages/server/dist/src/modules/park_carpool/parkCarpoolSchema.js'))});
 const {handleParkCarpoolHttp}=await import(${JSON.stringify(path.join(root, 'packages/server/dist/src/modules/park_carpool/parkCarpoolHttp.js'))});
 console.error('acceptance: modules loaded');const db=new Database(':memory:');db.exec("CREATE TABLE accounts(id TEXT PRIMARY KEY);CREATE TABLE organizations(id TEXT PRIMARY KEY);INSERT INTO accounts VALUES ('a'),('b');INSERT INTO organizations VALUES ('org-a'),('org-b');CREATE TABLE e2ee_devices(account_id TEXT,organization_id TEXT,device_id TEXT,approval_state TEXT,revoked_at TEXT);INSERT INTO e2ee_devices VALUES ('a','org-a','device-a','approved',NULL),('b','org-b','device-b','approved',NULL);");PARK_CARPOOL_SCHEMA_CONTRIBUTOR.apply(db);const signingKeys=new Map(['a','b'].map(id=>[id,generateKeyPairSync('ed25519')]));db.exec('ALTER TABLE e2ee_devices ADD COLUMN identity_signing_public_key TEXT');for(const [id,keys] of signingKeys)db.prepare('UPDATE e2ee_devices SET identity_signing_public_key=? WHERE account_id=?').run(keys.publicKey.export({type:'spki',format:'pem'}).toString(),id);
 const store=createParkCarpoolSqliteStore({db:()=>db,fieldCipher:createEncryptedFieldCipher({keyProvider:{getKey:()=>randomKey,clear:()=>{}}}),getPrincipal:id=>['a','b'].includes(id)?{accountId:id,organizationId:'org-'+id,organizationName:'测试企业'+id,displayName:id+'同事',parkId:'test-park',active:true,parkServiceEnabled:true}:null});const randomKey=randomBytes(32);
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());const places=[{id:'origin',label:'测试园区南门',address:'公共出口',district:'测试区',coordinate:{longitude:116,latitude:40}},{id:'destination',label:'测试地铁站',address:'公共站口',district:'测试区',coordinate:{longitude:116.1,latitude:40}}];
 const service=createParkCarpoolService({store,createId:id=>'intent-'+id,mapProvider:{configured:true,searchPlaces:async query=>query.includes('园区')?[places[0]]:[places[1]],planDrivingRoute:async(a,b)=>({provider:'explicit-electron-map-fixture',distanceMeters:8500,durationSeconds:1200,polyline:[a,b]})}});
 await service.publishIntent('b',{requestKey:'electron-peer',travelDate:today,departureTime:today+'T23:00:00+08:00',flexibleMinutes:30,origin:places[0],destination:places[1],travelOptions:['shared_taxi']});
 console.error('acceptance: peer published');const tokens=new Map([['a',randomBytes(24).toString('hex')],['b',randomBytes(24).toString('hex')]]);
 const server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');const actor=[...tokens].find(([,token])=>req.headers.authorization==='Bearer '+token)?.[0];void handleParkCarpoolHttp({service,path:url.pathname,url,method:req.method,req,res,memberAccount:actor?{id:actor}:null,readBody:async request=>{let body='';for await(const chunk of request)body+=chunk;return JSON.parse(body);},sendJSON:(response,status,body)=>{response.writeHead(status,{'content-type':'application/json'});response.end(JSON.stringify(body));}});});server.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port+'/enterprise/park-carpool';
 const request=async(route,method='GET',body,actor='a')=>{const response=await fetch(base+route,{method,headers:{authorization:'Bearer '+tokens.get(actor),'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(result.error);return result;};
 console.error('acceptance: HTTP listening');const secure=safeStorage.isEncryptionAvailable();if(!secure)throw new Error('OS secure storage unavailable');
 const protectedValue=safeStorage.encryptString('carpool-os-probe');if(safeStorage.decryptString(protectedValue)!=='carpool-os-probe')throw new Error('OS secure storage roundtrip failed');
 console.error('acceptance: OS storage tested');const chats=new Map();for(const id of ['a','b']){const chat=new ParkCarpoolChat({stateDirectory:path.join(${JSON.stringify(temp)},'mls'),binaryPath:${JSON.stringify(path.join(root, 'otto-native/target/debug/otto-native'))},secureStorage:{assertAvailable:()=>{if(!safeStorage.isEncryptionAvailable())throw new Error('OS storage unavailable');},protect:value=>safeStorage.encryptString(value).toString('base64'),unprotect:value=>safeStorage.decryptString(Buffer.from(value,'base64'))},client:{getParkCarpoolWorkflow:()=>request('/workflow','GET',undefined,id).then(result=>result.workflow),executeParkCarpoolTransport:command=>{const timestamp=new Date().toISOString();const proof={timestamp,signature:sign(null,Buffer.from(JSON.stringify(['otto:park-carpool-device:v1',id,timestamp,command])),signingKeys.get(id).privateKey).toString('base64')};return request('/transport','POST',{...command,proof},id).then(result=>result.result);}}});await chat.activate({serverUrl:'http://127.0.0.1:54321',organizationId:'org-'+id,accountId:id,deviceId:'device-'+id,approvalState:'approved'});chats.set(id,chat);}
 console.error('acceptance: native initialized');const win=new BrowserWindow({width:1100,height:900,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true}});
 ipcMain.handle('carpool-test',async(event,name,args)=>{if(event.sender!==win.webContents)throw new Error('untrusted test window');switch(name){case 'Get':return (await request('')).state;case 'Refresh':return (await request('/matches?'+new URLSearchParams(args[0]??{}))).state;case 'SearchPlaces':return (await request('/places?q='+encodeURIComponent(args[0]))).places;case 'Publish':return (await request('/intents','PUT',args[0])).intent;case 'Stop':return (await request('/intents/stop','POST',{intentId:args[0]})).intent;case 'Confirm':return (await request('/intents/confirm','POST',{intentId:args[0]})).intent;case 'RoutePreview':return (await request('/route-preview','POST',{intentId:args[0],groupId:args[1]})).preview;case 'WorkflowGet':return (await request('/workflow')).workflow;case 'WorkflowExecute':return (await request('/workflow','POST',args[0])).workflow;case 'ChatRead':return chats.get('a').read(args[0]);case 'ChatSend':return chats.get('a').send(...args);default:throw new Error('unsupported test operation');}});
 globalThis.carpoolAcceptance={service,chats,secure,today};await win.loadFile(path.join(__dirname,'index.html'));app.on('before-quit',()=>server.close());
}).catch(error=>{console.error(error);app.exit(1);});
`,
  );
  app = await electron.launch({
    executablePath: require('electron'),
    args: [path.join(temp, 'main.cjs'), '--remote-allow-origins=*'],
    timeout: 30_000,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(15_000);
  await page.getByText('找到与你方向相近的园区伙伴').waitFor();
  for (const [name, query, label] of [
    ['从哪里出发', '园区', '测试园区南门'],
    ['要去哪里', '地铁', '测试地铁站'],
  ]) {
    const group = page.getByRole('group', { name });
    await group.getByPlaceholder('搜索小区、地标或地址').fill(query);
    await group.getByRole('button', { name: '搜索', exact: true }).click();
    await group.getByRole('option', { name: new RegExp(label) }).click();
  }
  const today = await app.evaluate(() => globalThis.carpoolAcceptance.today);
  await page.getByLabel('计划出发时间').fill(today + 'T23:00');
  await page.getByRole('checkbox', { name: /一起叫车/ }).check();
  await page.getByRole('button', { name: '发布并查找同路伙伴' }).click();
  await page.getByRole('button', { name: '查看路线对比' }).click();
  await page.getByText(/深色实线：双方或全员共同方向/).waitFor();
  await page.getByRole('button', { name: '发消息', exact: true }).click();
  await page.getByLabel('首条消息').fill('Electron 真界面请求');
  await page.getByRole('button', { name: '发送请求', exact: true }).click();
  const conversationId = await app.evaluate(async () => {
    const { service, chats } = globalThis.carpoolAcceptance;
    const request = (await service.getWorkflow('b')).requests[0];
    await service.executeWorkflow('b', {
      type: 'resolve',
      requestId: request.id,
      action: 'accept',
    });
    const id = (await service.getWorkflow('a')).conversations[0].id;
    await chats.get('a').read(id);
    await chats.get('b').read(id);
    return id;
  });
  await page.getByRole('button', { name: '刷新同行消息' }).click();
  await page.getByRole('button', { name: '打开同行私聊' }).click();
  await page.getByText('端到端加密已就绪').waitFor();
  await page
    .getByLabel('同行消息')
    .fill('Electron 与 OS 密钥链保护的真实加密消息');
  await page.getByRole('button', { name: '发送加密消息' }).click();
  await page
    .getByRole('list', { name: '同行聊天记录' })
    .getByText('Electron 与 OS 密钥链保护的真实加密消息')
    .waitFor();
  const received = await app.evaluate(
    async (_, id) =>
      (await globalThis.carpoolAcceptance.chats.get('b').read(id)).messages.map(
        (message) => message.text,
      ),
    conversationId,
  );
  if (!received.includes('Electron 与 OS 密钥链保护的真实加密消息'))
    throw new Error('recipient did not decrypt actual message');
  await page.screenshot({
    path: path.join(evidence, 'electron-carpool-chat.png'),
    fullPage: true,
  });
  console.log(
    JSON.stringify(
      {
        passed: true,
        osSecureStorage: await app.evaluate(
          () => globalThis.carpoolAcceptance.secure,
        ),
        received,
        map: 'explicit local provider fixture',
        authentication: 'isolated test bearer identities',
        surface:
          'real Electron React components, isolated IPC, device-signed HTTP and native MLS',
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await rm(temp, { recursive: true, force: true });
}
