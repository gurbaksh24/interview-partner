// electron-builder afterPack hook: harden the packaged Electron binary.
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPack(context) {
  const name = context.packager.appInfo.productFilename;
  const file = {
    win32: () => `${name}.exe`,
    darwin: () => `${name}.app`,
    linux: () => context.packager.executableName,
  }[context.electronPlatformName]();
  const binary = path.join(context.appOutDir, file);

  await flipFuses(binary, {
    version: FuseVersion.V1,
    resetAdHocDarwinSignature: context.electronPlatformName === 'darwin',
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
  });
};
