/**
 * Otto Green keeps one source tree with Otto while owning a separate install,
 * user-data, protocol and update identity.
 */

const packageJson = require('./package.json');
const base = packageJson.build;

module.exports = {
  ...base,
  appId: 'ai.otto.green.desktop',
  productName: 'Otto Green',
  executableName: 'Otto Green',
  protocols: [
    {
      name: 'Otto Green 企业邀请',
      schemes: ['otto-green'],
    },
  ],
  directories: {
    ...base.directories,
    output: 'release-green',
  },
  extraMetadata: {
    ...base.extraMetadata,
    productName: 'Otto Green',
    ottoDistributionId: 'otto-green',
  },
  mac: {
    ...base.mac,
    artifactName: 'Otto.green-${version}-${arch}.${ext}',
  },
  nsis: {
    ...base.nsis,
    shortcutName: 'Otto Green',
    artifactName: 'Otto.green-${version}.${ext}',
  },
};
