#!/usr/bin/env node
/**
 * Push the current HEAD commit to GitHub through the Git Data API.
 *
 * Why this exists: on some networks `git push` to github.com:443 is blocked
 * while api.github.com still works. This script uploads the commit tree and
 * moves the branch without using the git smart-HTTP transport.
 *
 * It reproduces the local commit exactly — same blobs, same tree, same modes,
 * same parents, same author/committer timestamps — so the resulting SHA equals
 * your local HEAD. If anything does not match it aborts instead of writing a
 * different commit.
 *
 * Requirements: `gh` authenticated (`gh auth login`). Pushing `.github/workflows`
 * also needs the `workflow` scope (`gh auth refresh -s workflow`).
 *
 * Usage:
 *   node scripts/push-api.mjs [branch] [--dry-run]
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const branch = args.find((arg) => !arg.startsWith('--')) || 'main'
const tmp = mkdtempSync(join(tmpdir(), 'dsh-push-'))

function sh(cmd, cmdArgs, options = {}) {
  // stderr is captured, not inherited: expected failures (e.g. the 422 when the
  // ref already exists) must not look like crashes in the user's terminal.
  return execFileSync(cmd, cmdArgs, {
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
}

function git(gitArgs, encoding = 'utf8') {
  return sh('git', gitArgs, { encoding }).trim()
}

function fail(message) {
  rmSync(tmp, { recursive: true, force: true })
  console.error(`error: ${message}`)
  process.exit(1)
}

// owner/repo from the origin URL (https or ssh)
const remote = git(['remote', 'get-url', 'origin'])
const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?$/)
if (!match) fail(`cannot parse a GitHub remote from: ${remote}`)
const [, OWNER, REPO] = match
console.log(`repo: ${OWNER}/${REPO}  branch: ${branch}${dryRun ? '  (dry run)' : ''}`)

function gh(ghArgs, body) {
  const full = ['api', ...ghArgs]
  if (body !== undefined) {
    const file = join(tmp, `body-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(body), 'utf8')
    full.push('--input', file)
  }
  const out = sh('gh', full, { encoding: 'utf8' })
  if (!out.trim()) return null
  // --jq prints a bare value, not JSON
  return ghArgs.includes('--jq') ? out.trim() : JSON.parse(out)
}

const head = git(['rev-parse', 'HEAD'])
const files = git(['ls-tree', '-r', 'HEAD'])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t')
    const [mode, type, sha] = meta.split(/\s+/)
    return { path, mode, type, sha }
  })

const unsupported = files.find((file) => file.type !== 'blob')
if (unsupported) {
  fail(
    `unsupported tree entry (${unsupported.type}) at ${unsupported.path} — ` +
      'submodules and gitlinks cannot be recreated by this script; push normally instead',
  )
}

// Every parent, not just the first: merge commits have more than one.
const parentLine = git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(/\s+/)
const parents = parentLine.slice(1)
const localTree = git(['rev-parse', 'HEAD^{tree}'])

console.log(`files: ${files.length}  parents: ${parents.length}  tree: ${localTree.slice(0, 10)}`)

if (dryRun) {
  for (const file of files) console.log(`  ${file.mode} ${file.sha.slice(0, 8)} ${file.path}`)
  console.log('dry run: nothing uploaded')
  rmSync(tmp, { recursive: true, force: true })
  process.exit(0)
}

try {
  // The blobs endpoint refuses an empty repository, so seed one file first. The
  // seed commit becomes unreachable once the real ref moves below.
  let hasHead = true
  try {
    gh([`repos/${OWNER}/${REPO}/git/ref/heads/${branch}`])
  } catch {
    hasHead = false
  }
  if (!hasHead) {
    gh(['--method', 'PUT', `repos/${OWNER}/${REPO}/contents/README.md`], {
      message: 'chore: bootstrap repository',
      content: Buffer.from('# bootstrap\n', 'utf8').toString('base64'),
      branch,
    })
    console.log('bootstrapped an empty repository')
  }

  const tree = []
  for (const file of files) {
    // Read from git, not the working tree: .gitattributes may normalise endings.
    const bytes = sh('git', ['cat-file', 'blob', file.sha])
    const blob = gh(['--method', 'POST', `repos/${OWNER}/${REPO}/git/blobs`], {
      content: bytes.toString('base64'),
      encoding: 'base64',
    })
    if (blob.sha !== file.sha) fail(`blob sha mismatch for ${file.path}`)
    // Keep the original mode (100644 / 100755) or the rebuilt tree differs.
    tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha })
  }
  console.log('blobs uploaded, shas match local')

  const createdTree = gh(['--method', 'POST', `repos/${OWNER}/${REPO}/git/trees`], { tree })
  if (createdTree.sha !== localTree) fail(`tree mismatch: ${createdTree.sha} vs ${localTree}`)

  const commit = gh(['--method', 'POST', `repos/${OWNER}/${REPO}/git/commits`], {
    // git() trims; the commit object stores the message with one trailing \n.
    message: `${git(['log', '-1', '--format=%B'])}\n`,
    tree: createdTree.sha,
    parents,
    author: {
      name: git(['log', '-1', '--format=%an']),
      email: git(['log', '-1', '--format=%ae']),
      date: git(['log', '-1', '--format=%aI']),
    },
    committer: {
      name: git(['log', '-1', '--format=%cn']),
      email: git(['log', '-1', '--format=%ce']),
      date: git(['log', '-1', '--format=%cI']),
    },
  })

  if (commit.sha !== head) fail(`commit sha mismatch: ${commit.sha} vs local ${head}`)
  console.log(`commit ${commit.sha} (matches local HEAD)`)

  try {
    gh(['--method', 'POST', `repos/${OWNER}/${REPO}/git/refs`], {
      ref: `refs/heads/${branch}`,
      sha: commit.sha,
    })
  } catch {
    gh(['--method', 'PATCH', `repos/${OWNER}/${REPO}/git/refs/heads/${branch}`], {
      sha: commit.sha,
      force: true,
    })
  }

  const remoteHead = gh([`repos/${OWNER}/${REPO}/commits/${branch}`, '--jq', '.sha'])
  if (remoteHead !== commit.sha) fail(`remote ${branch} is ${remoteHead}, expected ${commit.sha}`)
  console.log(`PUSHED ${branch} = ${commit.sha}`)
} catch (error) {
  // gh reports the interesting part in stderr; execFileSync strips it otherwise.
  const detail = error?.stderr ? String(error.stderr).trim().split('\n').pop() : String(error)
  fail(detail || 'push failed')
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
