// electron-builder afterPack hook: fails the build if a secret or dev-only file got packed into the app,
// runs before the dmg/zip are made, so nothing leaky can ever be published
const { join } = require('path');
const { existsSync } = require('fs');
const asar = require('@electron/asar');

const FORBIDDEN = [
  /^\/\.env(\..*)?$/,
  /^\/\.git(\/|$)/,
  /^\/docs\//,
  /^\/supabase\//,
  /^\/release\//,
  /^\/src\/.*\.ts$/,
  /\.pem$/,
  /\.key$/,
];

exports.default = async function checkBundle(context) {
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const archive = join(context.appOutDir, appName, 'Contents', 'Resources', 'app.asar');
  if (!existsSync(archive)) throw new Error(`[check-bundle] app.asar not found at ${archive}`);

  const leaked = asar.listPackage(archive, { isPack: false }).filter(f => FORBIDDEN.some(re => re.test(f)));
  if (leaked.length > 0) {
    throw new Error(`[check-bundle] refusing to ship these files:\n  ${leaked.join('\n  ')}`);
  }
  console.log('[check-bundle] app.asar contains no secrets or dev-only files.');
};
