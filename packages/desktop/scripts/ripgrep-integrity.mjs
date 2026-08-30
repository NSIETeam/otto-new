/**
 * @license
 * Copyright 2025 Otto
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Windows ripgrep 预编译包的固定供应链摘要。
 *
 * ZIP digest 来自 microsoft/ripgrep-prebuilt 对应 GitHub Release 资产元数据，
 * executable digest 由该 ZIP 中解出的 rg.exe 独立计算。升级
 * @vscode/ripgrep 时必须先人工核验新的上游资产，再新增映射。
 */
export const WINDOWS_RIPGREP_INTEGRITY = Object.freeze({
  'v15.0.0': Object.freeze({
    target: 'x86_64-pc-windows-msvc',
    zipSha256:
      '5b7f6a3020739ac4bdf2c32300f14388456361bea054d35270a18a3c9949b932',
    executableSha256:
      '331303d50b7cb4abe04ee549e57b04f65550ce936da1eeba4d4b05909c96eb29',
  }),
});

/**
 * macOS ripgrep 预编译包的固定供应链摘要。archiveSha256 取自
 * microsoft/ripgrep-prebuilt v15.0.0 Release 的 GitHub asset digest；
 * executableSha256 是在 archive 摘要通过后对其中唯一 rg 文件计算的摘要。
 */
export const MACOS_RIPGREP_INTEGRITY = Object.freeze({
  'v15.0.0': Object.freeze({
    arm64: Object.freeze({
      target: 'aarch64-apple-darwin',
      archiveSha256:
        '16ded8d87db15333e8c06188ea2635dcde7f9869412f843e463a290f9d7493f3',
      executableSha256:
        '6ef40346bf31fcce79d9614c7745c198542925a0c7d4911e1ffe794c53392ac1',
    }),
    x64: Object.freeze({
      target: 'x86_64-apple-darwin',
      archiveSha256:
        '9787387f2d01ee3382e5984c39beb457f445585d81f928a5b1a089706ffb6c8f',
      executableSha256:
        'f999495980a5e6f1e7d26461ef5768b4013a62df610ed7d77a8b2de247a5b228',
    }),
  }),
});
