const fs = require('fs');
const path = require('path');

const base = __dirname;
const requiredFiles = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'options.html',
  'options.js',
  'options.css',
  'checkpoints.html',
  'checkpoints.js',
  'ui-shared.js',
  'preview.html',
  'preview.js',
  'README.md'
];

let failed = false;

for (const file of requiredFiles) {
  const full = path.join(base, file);
  if (!fs.existsSync(full)) {
    console.error(`Missing file: ${file}`);
    failed = true;
  }
}

const manifestPath = path.join(base, 'manifest.json');
if (fs.existsSync(manifestPath)) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const requiredPermissions = ['tabs', 'storage', 'sessions'];
  for (const permission of requiredPermissions) {
    if (!manifest.permissions || !manifest.permissions.includes(permission)) {
      console.error(`Missing permission in manifest: ${permission}`);
      failed = true;
    }
  }

  if (manifest.manifest_version !== 3) {
    console.error('manifest_version must be 3');
    failed = true;
  }

  if (manifest.background?.service_worker !== 'background.js') {
    console.error('background.service_worker must be background.js');
    failed = true;
  }
}

if (failed) {
  process.exit(1);
}

console.log('Validation passed.');
