require('dotenv').config();
const { execSync } = require('child_process');
const https = require('https');

const token = process.env.GH_TOKEN;
const owner = 'notiskin';
const repo = 'notiskin';

function api(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'notiskin-publish',
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function getReleases() {
  const { body } = await api('GET', `/repos/${owner}/${repo}/releases`);
  return body;
}

async function deleteRelease(id) {
  await api('DELETE', `/repos/${owner}/${repo}/releases/${id}`);
}

async function deleteTag(tag) {
  await api('DELETE', `/repos/${owner}/${repo}/git/refs/tags/${tag}`);
}

async function getAssets(releaseId) {
  const { body } = await api('GET', `/repos/${owner}/${repo}/releases/${releaseId}/assets`);
  return body;
}

async function transferAsset(assetId, targetReleaseId) {
  // GitHub API doesn't support moving assets directly, so we re-upload
  // Instead, we use the upload URL from the target release
  const { body: asset } = await api('GET', `/repos/${owner}/${repo}/releases/assets/${assetId}`);
  return asset;
}

async function cleanup() {
  console.log('Checking for duplicate releases...');
  const releases = await getReleases();
  
  // group by tag name
  const byTag = {};
  for (const r of releases) {
    if (!byTag[r.tag_name]) byTag[r.tag_name] = [];
    byTag[r.tag_name].push(r);
  }

  for (const [tag, group] of Object.entries(byTag)) {
    if (group.length < 2) continue;
    console.log(`Found ${group.length} releases for ${tag}, merging...`);

    // sort so the one with more assets is "primary"
    group.sort((a, b) => b.assets.length - a.assets.length);
    const primary = group[0];
    const duplicates = group.slice(1);

    for (const dup of duplicates) {
      const assets = await getAssets(dup.id);
      for (const asset of assets) {
        console.log(`  Moving asset: ${asset.name}`);
        // download the asset
        const downloaded = await downloadAsset(asset.url);
        // upload to primary
        await uploadAsset(primary.upload_url, asset.name, downloaded, asset.content_type);
        console.log(`  Uploaded ${asset.name} to primary release`);
      }
      console.log(`  Deleting duplicate release ${dup.id}`);
      await deleteRelease(dup.id);
      await deleteTag(dup.tag_name + '-duplicate').catch(() => {});
    }
    console.log(`Done merging ${tag}`);
  }
}

function downloadAsset(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/octet-stream',
        'User-Agent': 'notiskin-publish',
      }
    }, (res) => {
      if (res.statusCode === 302 || res.statusCode === 301) {
        https.get(res.headers.location, (res2) => {
          const chunks = [];
          res2.on('data', c => chunks.push(c));
          res2.on('end', () => resolve(Buffer.concat(chunks)));
          res2.on('error', reject);
        });
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
  });
}

function uploadAsset(uploadUrl, name, buffer, contentType) {
  const url = uploadUrl.replace('{?name,label}', '') + `?name=${encodeURIComponent(name)}`;
  const parsed = new URL(url);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'notiskin-publish',
        'Content-Type': contentType || 'application/octet-stream',
        'Content-Length': buffer.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(buffer);
    req.end();
  });
}

async function main() {
  // run electron-builder
  console.log('Building and publishing...');
  execSync('electron-builder --mac --publish always', { stdio: 'inherit', env: process.env });

  // merge any duplicate releases
  await cleanup();
  console.log('Publish complete.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});