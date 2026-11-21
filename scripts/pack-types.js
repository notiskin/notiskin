// Gets types/ ready to pack or publish as @notiskin/types: copies notiskin.d.ts and LICENSE from the repository
// root into types/. The root notiskin.d.ts stays the only real copy (the docs and the starter repository link to
// it), the copies in types/ are gitignored. It refuses when the API version on the first line of notiskin.d.ts
// isn't the version in types/package.json, so the package's version is always the API version it describes.
// Run by hand (`node scripts/pack-types.js`) and by types/package.json's prepack, so `npm pack ./types` and
// `npm publish ./types` never pick up an old copy
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const typesDir = path.join(root, 'types');

function apiVersion(dtsText) {
  const match = dtsText.split('\n')[0].match(/version (\d+\.\d+\.\d+)$/);
  return match ? match[1] : null;
}

const dtsText = fs.readFileSync(path.join(root, 'notiskin.d.ts'), 'utf-8');
const version = apiVersion(dtsText);
const pkg = JSON.parse(fs.readFileSync(path.join(typesDir, 'package.json'), 'utf-8'));

if (!version) {
  console.error('The first line of notiskin.d.ts has no "version X.Y.Z" at the end.');
  process.exit(1);
}
if (pkg.version !== version) {
  console.error(`notiskin.d.ts is API version ${version} but types/package.json says ${pkg.version}. Make them the same first.`);
  process.exit(1);
}

fs.copyFileSync(path.join(root, 'notiskin.d.ts'), path.join(typesDir, 'notiskin.d.ts'));
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(typesDir, 'LICENSE'));
// on stderr, so `npm pack --json` (which shows what prepack prints) stays valid JSON
console.error(`types/ is ready to pack as ${pkg.name}@${version}`);
