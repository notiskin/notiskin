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

// a tiny real Electron Framework.framework, signed on its own like Notion's. Needs macOS and a C compiler, returns its path
function makeElectronFramework(frameworksDir) {
  const framework = join(frameworksDir, 'Electron Framework.framework');
  const version = join(framework, 'Versions', 'A');
  mkdirSync(join(version, 'Resources'), { recursive: true });
  execFileSync('cc', ['-x', 'c', '-dynamiclib', '-o', join(version, 'Electron Framework'), '-'], {
    input: 'void electron(void) {}\n',
    stdio: ['pipe', 'ignore', 'ignore'],
  });
  writeFileSync(join(version, 'Resources', 'Info.plist'), infoPlist('com.github.Electron.framework', 'Electron Framework', 'FMWK'));
  symlinkSync('A', join(framework, 'Versions', 'Current'));
  symlinkSync('Versions/Current/Electron Framework', join(framework, 'Electron Framework'));
  symlinkSync('Versions/Current/Resources', join(framework, 'Resources'));
  execFileSync('codesign', ['--force', '--sign', '-', framework], { stdio: 'ignore' });
  return framework;
}

module.exports = { dataDir: process.env.NOTISKIN_DIR, infoPlist, makeElectronFramework };
