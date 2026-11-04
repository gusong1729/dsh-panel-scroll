#!/usr/bin/env node
/**
 * Push the current HEAD commit to GitHub through the Git Data API.
 *
 * Why this exists: on some networks `git push` to github.com:443 is blocked
 * while api.github.com still works. This script uploads the commit tree and
 * moves the branch without using the git smart-HTTP transport.
 *
 * It reproduces the local commit exactly — same blobs, same tree, same author
 * and committer timestamps — so the resulting SHA equals your local HEAD.
 *
 * Requirements: `gh` (authenticated: `gh auth login`).
 * Usage: node scripts/push-api.mjs [branch]
 */
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const branch = process.argv[2] || 'main'
const tmp = mkdtempSync(join(tmpdir(), 'dsh-push-'))

function sh(cmd, args, options = {}) {
  return execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, ...options })
}

function git(args, encoding = 'utf8') {
  return sh('git', args, { encoding }).trim()
}

// owner/repo from the origin URL (https or ssh)
const remote = git(['remote', 'get-url', 'origin'])
const match = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)(?:\.git)?$/)
if (!match) throw new Error(`cannot parse GitHub remote: ${remote}`)
const [, OWNER, REPO] = match
console.log(`repo: ${OWNER}/${REPO}  branch: ${branch}`)

function gh(args, body) {
  const full = ['api', ...args]
  if (body !== undefined) {
    const file = join(tmp, `body-${Date.now()}-${Math.random().toString(16).slice(2)}.json`)
    writeFileSync(file, JSON.stringify(body), 'utf8')
    full.push('--input', file)
  }
  const out = sh('gh', full, { encoding: 'utf8' })
  if (!out.trim()) return null
  return args.includes('--jq') ? out.trim() : JSON.parse(out)
}

const head = git(['rev-parse', 'HEAD'])
const files = git(['ls-tree', '-r', 'HEAD'])
  .split('\n')
  .filter(Boolean)
  .map((line) => {
    const [meta, path] = line.split('\t')
    const [, , sha] = meta.split(/\s+/)
    return { path, sha }
  })
console.log(`files: ${files.length}`)

// The blobs endpoint refuses an empty repository, so seed one file first. The
// seed commit becomes unreachable once the real ref moves below.
try {
  gh([`repos/${OWNER}/${REPO}/git/ref/heads/${branch}`])
} catch {
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
  if (blob.sha !== file.sha) throw new Error(`blob sha mismatch for ${file.path}`)
  tree.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha })
}
console.log('blobs uploaded, shas match local')

const createdTree = gh(['--method', 'POST', `repos/${OWNER}/${REPO}/git/trees`], { tree })
const localTree = git(['rev-parse', 'HEAD^{tree}'])
if (createdTree.sha !== localTree) throw new Error(`tree mismatch: ${createdTree.sha} vs ${localTree}`)

const commit = gh(['--method', 'POST', `repos/${OWNER}/${REPO}/git/commits`], {
  // git() trims; the commit object stores the message with one trailing \n.
  message: `${git(['log', '-1', '--format=%B'])}\n`,
  tree: createdTree.sha,
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
  ...(git(['rev-list', '--max-count=2', 'HEAD']).split('\n').length > 1
    ? { parents: [git(['rev-parse', 'HEAD~1'])] }
    : {}),
})

if (commit.sha !== head) throw new Error(`commit sha mismatch: ${commit.sha} vs local ${head}`)
console.log(`commit ${commit.sha} (matches local HEAD)`)

try {
  gh(['--method', 'POST', `repos/${OWNER}/${REPO}/git/refs`], { ref: `refs/heads/${branch}`, sha: commit.sha })
} catch {
  gh(['--method', 'PATCH', `repos/${OWNER}/${REPO}/git/refs/heads/${branch}`], { sha: commit.sha, force: true })
}

const remoteHead = gh([`repos/${OWNER}/${REPO}/commits/${branch}`, '--jq', '.sha'])
console.log(remoteHead === commit.sha ? `PUSHED ${branch} = ${commit.sha}` : `MISMATCH remote=${remoteHead}`)
if (remoteHead !== commit.sha) process.exit(1)
