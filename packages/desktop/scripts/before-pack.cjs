/** Copyright 2026 Otto. SPDX-License-Identifier: Apache-2.0 */
/* global module */
module.exports = async context => {
  const { prepareInstallerRecovery } = await import('./installer-recovery-build.mjs');
  await prepareInstallerRecovery(context);
  const { prepareDesktopSharp } = await import('./sharp-packaging.mjs');
  await prepareDesktopSharp(context);
};
