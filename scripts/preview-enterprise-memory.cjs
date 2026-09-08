// Local visual QA helper. Generated bundles stay in memory; no production services are called.
const esbuild = require('esbuild');
const http = require('node:http');
const path = require('node:path');
esbuild.build({
  entryPoints: ['packages/desktop/preview/enterprise-memory.tsx'], bundle: true, write: false,
  outdir: 'memory-preview', format: 'iife', jsx: 'automatic', target: 'chrome120',
  define: { 'process.env.NODE_ENV': '"development"' },
  loader: { '.png': 'dataurl', '.svg': 'dataurl', '.jpg': 'dataurl', '.jpeg': 'dataurl', '.gif': 'dataurl', '.woff2': 'dataurl' },
}).then(({ outputFiles }) => {
  const assets = new Map(outputFiles.map((file) => ['/' + path.basename(file.path), file.contents]));
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/enterprise-memory.css"><title>企业记忆本地验证 · 虚构数据</title><div id="root"></div><script src="/enterprise-memory.js"></script></html>';
  http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const route = (req.url || '/').split('?')[0];
    if (route === '/') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); return; }
    const data = assets.get(route);
    if (!data) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript'); res.end(data);
  }).listen(4597, '127.0.0.1', () => console.log('Memory preview: http://127.0.0.1:4597 (fictional data only)'));
}).catch((error) => { console.error(error); process.exitCode = 1; });
