// release script: npm run publish (or npm run publish -- --dry-run to check everything without publishing)
require('dotenv').config();
const { execFileSync } = require('child_process');
const https = require('https');

const owner = 'notiskin';
const repo = 'notiskin';
const dryRun = process.argv.includes('--dry-run');
const token = process.env.GH_TOKEN;

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { stdio: 'inherit', ...opts });
}

function output(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf-8' }).trim();
}

function fail(msg) {
  console.error(`\n✖ ${msg}`);
  process.exit(1);
}

function api(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'User-Agent': 'notiskin-publish',
        Accept: 'application/vnd.github+json',
      },
    }, res => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(`GitHub API ${method} ${path} → ${res.statusCode}: ${data}`));
        resolve(data ? JSON.parse(data) : null);
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function preflight(tag) {
  if (!token && !dryRun) fail('GH_TOKEN is not set. Put a token with "contents: write" on notiskin/notiskin in .env.');

  const branch = output('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch !== 'main') fail(`Releases are cut from main, you're on ${branch}.`);

  if (output('git', ['status', '--porcelain'])) fail('Working tree has uncommitted changes. Commit or stash them first.');

  // never delete or move an existing tag, users may already have that version installed
  if (output('git', ['tag', '--list', tag])) fail(`Tag ${tag} already exists locally. Bump the version in package.json.`);
  if (output('git', ['ls-remote', '--tags', 'origin', `refs/tags/${tag}`])) {
    fail(`Tag ${tag} already exists on GitHub. Bump the version in package.json.`);
  }
}

// electron-builder occasionally creates a second release for the same tag, fold them into one
async function warnAboutDuplicateReleases(tag) {
  const releases = await api('GET', `/repos/${owner}/${repo}/releases?per_page=100`);
  const matching = releases.filter(r => r.tag_name === tag);
  if (matching.length > 1) {
    console.warn(`\n⚠ ${matching.length} releases exist for ${tag}. Keep the one with all assets and delete the rest on GitHub.`);
  }
}

async function main() {
  const { version } = require('./package.json');
  const tag = `v${version}`;
  console.log(`Preparing ${tag}${dryRun ? ' (dry run)' : ''}...`);

  preflight(tag);

  run('npm', ['run', 'lint']);
  run('npm', ['test']);

  if (dryRun) {
    // full build including the afterPack secret check, nothing leaves this machine
    run('npx', ['electron-builder', '--mac', '--publish', 'never']);
    console.log(`\n✔ Dry run passed. ${tag} is ready to publish.`);
    return;
  }

  run('git', ['tag', '-a', tag, '-m', `Release ${version}`]);
  run('git', ['push', 'origin', tag]);

  console.log('Building and publishing...');
  run('npx', ['electron-builder', '--mac', '--publish', 'always']);

  await warnAboutDuplicateReleases(tag);
  console.log(`\n✔ Published ${tag}.`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
