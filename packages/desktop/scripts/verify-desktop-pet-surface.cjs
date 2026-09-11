/** Real Electron smoke test of the built lazy entry, without loading App/CSS. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(require('electron'), [__filename, ...process.argv.slice(2)], { env, windowsHide: true, stdio: 'inherit' });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  const { app, BrowserWindow, nativeTheme } = require('electron');
  const software = process.argv.includes('--software');
  if (software) app.disableHardwareAcceleration();
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'otto-pet-surface-check-'));
  app.setPath('userData', path.join(output, 'profile'));
  const watchdog = setTimeout(() => { console.error('Desktop pet check timed out'); app.exit(1); }, 30_000);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ width: 176, height: 184, useContentSize: true, frame: false,
      transparent: true, backgroundColor: '#00000000', show: false, hasShadow: false,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true,
        backgroundThrottling: false,
        preload: path.join(__dirname, 'desktop-pet-smoke/preload.cjs') },
    });
    const template = process.argv[2] || 'desktop-pet.html';
    assert(['index.html', 'desktop-pet.html'].includes(template));
    await win.loadFile(path.join(__dirname, '../dist/renderer', template), { query: { surface: 'desktop-pet' } });
    await win.webContents.executeJavaScript(`new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Pet did not mount')),10000);
      const check=()=>{if(document.querySelector('.otto-desktop-pet__hit-target')){clearTimeout(timeout);resolve();}else setTimeout(check,20);};check();
    })`);
    await win.webContents.executeJavaScript(`(async () => {
      const sprite=document.querySelector('.otto-pet-stage__sprite');
      const url=getComputedStyle(sprite).backgroundImage.match(/^url\\(["']?(.*?)["']?\\)$/)?.[1];
      if(!url) throw new Error('Missing pet atlas');
      const img=new Image();img.src=url;await img.decode();
    })()`);
    for (const theme of ['dark', 'light']) {
      nativeTheme.themeSource = theme;
      const result = await win.webContents.executeJavaScript(`(() => {
        document.documentElement.dataset.ottoTheme = '${theme}';
        const target = document.querySelector('.otto-desktop-pet__hit-target');
        target.focus();
        const rect = target.getBoundingClientRect();
        const sprite = document.querySelector('.otto-pet-stage__sprite');
        return { background: [document.documentElement,document.body,document.getElementById('root')].map(e=>getComputedStyle(e).backgroundColor),
          position:getComputedStyle(target).position, width:rect.width, height:rect.height,
          bottom:innerHeight-rect.bottom, outline:getComputedStyle(target).outlineStyle,
          spriteWidth:sprite.getBoundingClientRect().width,
          colorScheme:getComputedStyle(document.documentElement).colorScheme,
          hasAppStyles:[...document.styleSheets].some(s=>[...s.cssRules].some(r=>r.selectorText==='.otto-hub-page')) };
      })()`);
      fs.writeFileSync(path.join(output, `${theme}.json`), JSON.stringify(result, null, 2));
      assert(result.background.every(color => color === 'rgba(0, 0, 0, 0)'), JSON.stringify(result));
      assert.equal(result.position, 'absolute');
      assert.equal(result.width, 112); assert.equal(result.height, 132);
      // Fractional Windows DPI can round the native viewport by a physical pixel.
      assert(Math.abs(result.bottom - 4) < 0.75, `Unexpected pet bottom gap: ${result.bottom}`);
      assert.equal(result.outline, 'none');
      assert(result.spriteWidth > 100 && result.spriteWidth < 130);
      assert.equal(result.colorScheme, 'light');
      assert.equal(result.hasAppStyles, false, 'Pet must not depend on lazy App CSS');
      // Offscreen windows publish their rendered frames via paint; capturePage
      // may have no Viz surface for a never-shown native window on Windows.
      const image = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          win.webContents.removeListener('paint', onPaint);
          reject(new Error('No rendered pet frame'));
        }, 5_000);
        function onPaint(_event, _dirty, frame) {
          if (frame.isEmpty()) return;
          clearTimeout(timeout); win.webContents.removeListener('paint', onPaint); resolve(frame);
        }
        win.webContents.on('paint', onPaint);
        win.webContents.invalidate();
      });
      fs.writeFileSync(path.join(output, `${theme}.png`), image.toPNG());
      const pixels = image.toBitmap();
      assert(pixels.length > 0, 'Missing rendered frame');
      assert.equal(pixels[3], 0, 'Top-left background must be transparent');
      assert.equal(pixels[pixels.length - 1], 0, 'Bottom-right background must be transparent');
      assert(pixels.some((value, index) => index % 4 === 3 && value > 0), 'Pet must remain visible');
    }
    console.log(`Desktop pet light/dark transparency passed (${software ? 'software' : 'default GPU'} rendering). Evidence: ${output}`);
    win.destroy(); clearTimeout(watchdog); app.exit(0);
  }).catch(error => { console.error(error.message); console.error(`Evidence: ${output}`); clearTimeout(watchdog); app.exit(1); });
}
