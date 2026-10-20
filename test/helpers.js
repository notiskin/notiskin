// every test file gets its own throwaway data folder, real ~/.notiskin is never touched
const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } = require('fs');
const { execFileSync } = require('child_process');
const { join } = require('path');
const { tmpdir } = require('os');

process.env.NOTISKIN_DIR = mkdtempSync(join(tmpdir(), 'notiskin-test-'));

function infoPlist(id, executable, type = 'APPL') {
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    `<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string>` +
    `<key>CFBundleExecutable</key><string>${executable}</string><key>CFBundlePackageType</key><string>${type}</string></dict></plist>\n`;
}

// a tiny real framework (versioned, with a one-function dylib), signed on its own like Notion's.
// files: extra files to put in its Resources before signing, { name: source path }. Needs macOS and a C compiler
function makeFramework(frameworksDir, name, files = {}) {
  const framework = join(frameworksDir, `${name}.framework`);
  const version = join(framework, 'Versions', 'A');
  mkdirSync(join(version, 'Resources'), { recursive: true });
  execFileSync('cc', ['-x', 'c', '-dynamiclib', '-o', join(version, name), '-'], {
    input: 'void framework(void) {}\n',
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  writeFileSync(join(version, 'Resources', 'Info.plist'), infoPlist(`com.example.${name.replace(/ /g, '')}`, name, 'FMWK'));
  for (const [file, source] of Object.entries(files)) execFileSync('cp', [source, join(version, 'Resources', file)]);
  symlinkSync('A', join(framework, 'Versions', 'Current'));
  symlinkSync(`Versions/Current/${name}`, join(framework, name));
  symlinkSync('Versions/Current/Resources', join(framework, 'Resources'));
  execFileSync('codesign', ['--force', '--sign', '-', framework], { stdio: 'ignore' });
  return framework;
}

// what tells an Electron Notion apart from a native one, returns its path
function makeElectronFramework(frameworksDir) {
  return makeFramework(frameworksDir, 'Electron Framework');
}

module.exports = { dataDir: process.env.NOTISKIN_DIR, infoPlist, makeFramework, makeElectronFramework };
