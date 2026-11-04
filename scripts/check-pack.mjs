// Verify that `npm publish` would ship everything the README needs.
// `files` in package.json is a whitelist, and a typo there silently ships a
// package whose README images 404 — this catches that in CI.
import { execFileSync } from 'node:child_process'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
// Node refuses to spawn `.cmd` files directly on Windows (EINVAL), so go
// through cmd.exe there; CI runs on Linux and takes the direct path.
const raw =
  process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], { encoding: 'utf8' })
    : execFileSync(npm, ['pack', '--dry-run', '--json'], { encoding: 'utf8' })
const [info] = JSON.parse(raw)
const shipped = new Set(info.files.map((file) => file.path))

const REQUIRED = [
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'client.js',
  'index.js',
  'cordis.patch.yml',
  'icon.svg',
  'docs/left-panel.png',
  'docs/right-panel.png',
]

const missing = REQUIRED.filter((path) => !shipped.has(path))
if (missing.length > 0) {
  console.error(`missing from the published package: ${missing.join(', ')}`)
  process.exit(1)
}

// Tests and CI config must not leak into the tarball.
const leaks = [...shipped].filter((path) => path.startsWith('tests/') || path.startsWith('.github/'))
if (leaks.length > 0) {
  console.error(`unexpected files in the published package: ${leaks.join(', ')}`)
  process.exit(1)
}

console.log(`package contains ${shipped.size} files — required set present, no test/CI leakage`)
