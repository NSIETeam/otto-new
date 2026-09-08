// Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0
// Controller-owned independent oracle. Never copied into the model workspace.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const [root, id, mode] = process.argv.slice(2);
const files = { 'login-retry': 'auth.cjs', 'utc-display': 'time.cjs' };
if (!files[id] || !['hidden', 'public'].includes(mode))
  throw new Error('Invalid oracle request');
const checks = [];
async function check(name, file, test) {
  try {
    const context = vm.createContext(
      {},
      {
        codeGeneration: { strings: false, wasm: false },
        microtaskMode: 'afterEvaluate',
      },
    );
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    new vm.Script('const module = {exports:{}};\n' + source).runInContext(
      context,
      { timeout: 1000 },
    );
    // Promise results stay INSIDE the context; do not expose host callbacks.
    new vm.Script(
      `globalThis.result = undefined; (async()=>{ ${test} })().then(value=>{ globalThis.result = value === true; },()=>{ globalThis.result = false; });`,
    ).runInContext(context, { timeout: 1000 });
    for (let i = 0; i < 20 && context.result === undefined; i++)
      new vm.Script('0').runInContext(context, { timeout: 1000 });
    checks.push({ name, passed: context.result === true });
  } catch {
    checks.push({ name, passed: false });
  }
}
(async () => {
  if (id === 'login-retry') {
    await check(
      'login-normal',
      files[id],
      'let n=0,r=0; const value=await module.exports.login(async()=>{n++;return {status:200}},async()=>{r++;return "fresh"}); return n===1 && r===0 && value.status===200;',
    );
    await check(
      'login-expired',
      files[id],
      'const tokens=[]; const value=await module.exports.login(async token=>{tokens.push(token);return {status:token==="fresh"?200:401}},async()=>"fresh"); return value.status===200 && tokens.join(",")==="current,fresh";',
    );
    if (mode === 'hidden') {
      await check(
        'login-retry-bounded',
        files[id],
        'let n=0,r=0;const value=await module.exports.login(async()=>{n++;return {status:401}},async()=>{r++;return "fresh"}); return value.status===401&&n===2&&r===1;',
      );
      await check(
        'login-server-error',
        files[id],
        'let n=0,r=0;const value=await module.exports.login(async()=>{n++;return {status:500}},async()=>{r++;return "fresh"}); return value.status===500&&n===1&&r===0;',
      );
      await check(
        'login-refresh-error',
        files[id],
        'let n=0;try{await module.exports.login(async()=>{n++;return {status:401}},async()=>{throw new Error("refresh-failed")});return false}catch(e){return n===1&&e.message==="refresh-failed"}',
      );
      await check(
        'login-network-error',
        files[id],
        'let r=0;try{await module.exports.login(async()=>{throw new Error("offline")},async()=>{r++;return "fresh"});return false}catch(e){return r===0&&e.message==="offline"}',
      );
    }
  } else {
    await check(
      'sqlite-utc',
      files[id],
      'return module.exports.parseTimestamp("2026-09-01 04:32:00")===1788237120000;',
    );
    await check(
      'explicit-z',
      files[id],
      'return module.exports.parseTimestamp("2026-09-01T04:32:00Z")===1788237120000;',
    );
    if (mode === 'hidden') {
      await check(
        'explicit-offset',
        files[id],
        'return module.exports.parseTimestamp("2026-09-01T12:32:00+08:00")===1788237120000;',
      );
      await check(
        'midnight-boundary',
        files[id],
        'return module.exports.parseTimestamp("2026-08-31 23:59:59")===1788220799000;',
      );
      await check(
        'fractional-seconds',
        files[id],
        'return module.exports.parseTimestamp("2026-09-01 04:32:00.123")===1788237120123;',
      );
      await check(
        'invalid-and-empty',
        files[id],
        'return ["bad", "", null, undefined].every(v=>module.exports.parseTimestamp(v)===null);',
      );
    }
  }
  await check(
    'payment-retry-preserved',
    'payment.cjs',
    'let n=0;const value=await module.exports.payment(async()=>({status:++n===1?503:200}));return n===2&&value.status===200;',
  );
  await check(
    'payment-no-extra-retry',
    'payment.cjs',
    'let n=0;const value=await module.exports.payment(async()=>{n++;return {status:400}});return n===1&&value.status===400;',
  );
  process.stdout.write(JSON.stringify({ checks }));
  process.exitCode = checks.every((c) => c.passed) ? 0 : 1;
})().catch(() => {
  process.stdout.write(
    JSON.stringify({ checks: [{ name: 'oracle-error', passed: false }] }),
  );
  process.exitCode = 1;
});
