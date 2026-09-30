const assert = require('node:assert/strict');
const { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const installFiles = [
  'manifest.json',
  'core.js',
  'content-script.js',
  'service-worker.js',
  'site-bridge.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'images/sorsa-logo.svg',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'README.txt',
];
const archivePath = path.join(root, 'dist', 'sorsa-score-extension.zip');
const expectedContentScript = [{
  matches: ['https://x.com/*', 'https://twitter.com/*'],
  js: ['core.js', 'content-script.js'],
  run_at: 'document_idle',
}, {
  matches: ['https://app.sorsa.io/*'],
  js: ['site-bridge.js'],
  run_at: 'document_idle',
}];

function archiveEntries() {
  return execFileSync('unzip', ['-Z1', archivePath], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean)
    .sort();
}

function assertStrictManifest(manifest) {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ['storage']);
  assert.ok(
    !Object.hasOwn(manifest, 'optional_permissions') ||
      (Array.isArray(manifest.optional_permissions) && manifest.optional_permissions.length === 0),
    'optional_permissions must be absent or empty',
  );
  assert.deepEqual(manifest.host_permissions, ['https://app.sorsa.io/*']);
  assert.equal(manifest.background?.service_worker, 'service-worker.js');
  assert.deepEqual(manifest.icons, {
    16: 'icons/icon-16.png',
    32: 'icons/icon-32.png',
    48: 'icons/icon-48.png',
    128: 'icons/icon-128.png',
  });
  assert.deepEqual(manifest.action?.default_icon, manifest.icons);
  assert.deepEqual(manifest.content_scripts, expectedContentScript);
}

function createPackagedFixture(manifest) {
  const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'sorsa-package-'));
  try {
    for (const filename of installFiles) {
      const destination = path.join(fixtureRoot, filename);
      mkdirSync(path.dirname(destination), { recursive: true });
      copyFileSync(path.join(root, filename), destination);
    }
    writeFileSync(path.join(fixtureRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    mkdirSync(path.join(fixtureRoot, 'dist'));
    execFileSync('zip', ['-X', '-q', 'dist/sorsa-score-extension.zip', ...installFiles], { cwd: fixtureRoot });
    return fixtureRoot;
  } catch (error) {
    rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

test('package has the complete explicit install-file allowlist and no development entries', () => {
  assert.equal(existsSync(archivePath), true, 'distribution ZIP must exist');
  assert.deepEqual(archiveEntries(), [...installFiles].sort());
  assert.ok(readFileSync(archivePath).length > 0, 'distribution ZIP must not be empty');
});

test('package verifier is present and accepts the packaged extension', () => {
  const verifier = path.join(root, 'scripts', 'verify-package.sh');
  assert.equal(existsSync(verifier), true, 'package verifier must exist');
  assert.doesNotThrow(() => {
    execFileSync('sh', [verifier], { cwd: root, stdio: 'pipe' });
  });
});

test('package manifest has exact permissions, host access, and X/Twitter content-script allowlists', () => {
  const manifestPath = path.join(root, 'manifest.json');
  assert.equal(existsSync(manifestPath), true, 'manifest must exist');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  assertStrictManifest(manifest);
});

test('package rejects optional tabs and broad content-script match regressions', (t) => {
  const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const optionalTabs = structuredClone(manifest);
  optionalTabs.optional_permissions = ['tabs'];
  assert.throws(() => assertStrictManifest(optionalTabs), /optional_permissions/);

  const broadMatch = structuredClone(manifest);
  broadMatch.content_scripts[0].matches = ['<all_urls>'];
  assert.throws(() => assertStrictManifest(broadMatch));

  const verifier = path.join(root, 'scripts', 'verify-package.sh');
  for (const invalidManifest of [optionalTabs, broadMatch]) {
    const fixtureRoot = createPackagedFixture(invalidManifest);
    t.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
    assert.throws(() => {
      execFileSync('sh', [verifier], {
        cwd: root,
        env: { ...process.env, PACKAGE_ROOT: fixtureRoot },
        stdio: 'pipe',
      });
    }, /package verification failed/);
  }
});

test('package readme is concise, English-only, and accurately describes privacy', () => {
  const readme = readFileSync(path.join(root, 'README.txt'), 'utf8');
  assert.match(readme, /reads only account handles displayed in X identity areas/i);
  assert.match(readme, /does not read or transmit post content/i);
  assert.match(readme, /does not read or store the cookies, passwords, or API keys/i);
  assert.doesNotMatch(readme, /chrome:\/\/extensions|installation|how to install/i);
  assert.doesNotMatch(readme, /[А-Яа-яЁё]/);
  assert.ok(readme.length < 1200, 'README must stay concise');
});

test('package installable sources contain no capture scripts, config reads, or token-shaped strings', () => {
  const forbiddenNames = /(?:^|\/)(?:capture-token|capture-bridge|config)\.js(?:on)?$/i;
  const forbiddenToken = /(?:\bBearer\s+[A-Za-z0-9._~+\/-]{8,}|\b(?:api[_-]?key|guest[_-]?token|access[_-]?token)\s*[:=]\s*['"][^'"]{8,}|\b(?:sk|pk|ghp|xox[bps])_[A-Za-z0-9_-]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
  const forbiddenCapture = /(?:webRequest|onBeforeSendHeaders|onHeadersReceived|XMLHttpRequest\.prototype\.open)/;
  const executableFiles = ['core.js', 'content-script.js', 'service-worker.js', 'site-bridge.js', 'popup.js'];

  for (const filename of installFiles) {
    assert.equal(forbiddenNames.test(filename), false, `${filename} must not be a capture/config file`);
    const source = readFileSync(path.join(root, filename), 'utf8');
    assert.equal(forbiddenToken.test(source), false, `${filename} must not contain a credential`);
    assert.equal(forbiddenCapture.test(source), false, `${filename} must not capture browser traffic`);
  }
  for (const filename of executableFiles) {
    assert.equal(/config\.json|readFile(?:Sync)?\([^)]*config|require\([^)]*config/i.test(readFileSync(path.join(root, filename), 'utf8')), false,
      `${filename} must not read configuration`);
  }
});
