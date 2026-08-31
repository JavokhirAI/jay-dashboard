// JOS file registry — core library.
//
// The registry is a JSON document that lists every artifact (html/docx/pdf/...)
// produced across Claude sessions. This repo is public, so the document is
// never committed in the clear: it is stored as `files/registry.enc.json`,
// AES-256-GCM encrypted under a PBKDF2 key derived from the JOS passphrase.
// `files.html` derives the same key in the browser and renders the list.

import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname, extname, relative, resolve } from 'node:path';

export const REGISTRY_PATH = 'files/registry.enc.json';
export const KDF_ITERATIONS = 600000;
export const MAX_ENTRIES = 1000;

export const TRACKED_EXTENSIONS = new Set([
  '.html', '.htm', '.docx', '.doc', '.dotx', '.pdf', '.pptx', '.potx', '.xlsx', '.xlsm', '.csv', '.md',
]);

const KIND_BY_EXT = {
  '.html': 'html', '.htm': 'html',
  '.docx': 'word', '.doc': 'word', '.dotx': 'word',
  '.pdf': 'pdf',
  '.pptx': 'slides', '.potx': 'slides',
  '.xlsx': 'sheet', '.xlsm': 'sheet', '.csv': 'sheet',
  '.md': 'note',
};

export function kindForPath(p) {
  return KIND_BY_EXT[extname(p).toLowerCase()] || 'file';
}

// --- crypto -----------------------------------------------------------------

export function passphrase() {
  const p = process.env.JOS_PASSPHRASE || process.env.JOS_FILES_PASSPHRASE;
  return p && p.trim() ? p : null;
}

export function encryptRegistry(registry, pass) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = pbkdf2Sync(pass, salt, KDF_ITERATIONS, 32, 'sha256');
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(registry), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    alg: 'AES-GCM',
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: salt.toString('base64') },
    iv: iv.toString('base64'),
    // ciphertext with the 16-byte GCM tag appended, the layout WebCrypto expects
    data: Buffer.concat([body, cipher.getAuthTag()]).toString('base64'),
  }, null, 0) + '\n';
}

export function decryptRegistry(blobText, pass) {
  const blob = JSON.parse(blobText);
  const salt = Buffer.from(blob.kdf.salt, 'base64');
  const iv = Buffer.from(blob.iv, 'base64');
  const key = pbkdf2Sync(pass, salt, blob.kdf.iterations, 32, 'sha256');
  const raw = Buffer.from(blob.data, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(raw.subarray(raw.length - 16));
  const plain = Buffer.concat([decipher.update(raw.subarray(0, raw.length - 16)), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

// --- registry model ---------------------------------------------------------

export function emptyRegistry() {
  return { version: 1, updated: new Date().toISOString(), entries: [] };
}

// Identity of an entry: the file it points at, falling back to the link for
// entries that have no file. Keyed on the path rather than the URL because the
// URL appears only once the file is committed — keying on it would file the
// same document twice, once before and once after it went live.
export function entryId(entry) {
  const seed = entry.path || entry.url || '';
  return createHash('sha256').update(seed.toLowerCase()).digest('hex').slice(0, 16);
}

export function normalizeEntry(input) {
  const now = new Date().toISOString();
  const entry = {
    title: input.title || (input.path ? basename(input.path) : input.url) || 'untitled',
    kind: input.kind || (input.path ? kindForPath(input.path) : 'link'),
    path: input.path || null,
    url: input.url || null,
    repo: input.repo || null,
    branch: input.branch || null,
    project: input.project || null,
    source: input.source || 'manual',
    session: input.session || null,
    size: typeof input.size === 'number' ? input.size : null,
    note: input.note || null,
    tags: Array.isArray(input.tags) ? input.tags : [],
    ts: input.ts || now,
  };
  entry.id = input.id || entryId(entry);
  return entry;
}

// Union by id, newest first, capped. Later-seen metadata wins but the original
// first-seen timestamp is preserved so the feed stays chronologically stable.
export function mergeEntries(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const raw of list || []) {
      const entry = normalizeEntry(raw);
      const prev = byId.get(entry.id);
      if (!prev) { byId.set(entry.id, entry); continue; }
      // Field-wise, keeping what we already know: a file registered before it
      // was committed has no URL yet, and a later sighting must not erase the
      // URL that a sweep has since resolved for it.
      const merged = { ...prev };
      for (const [k, v] of Object.entries(entry)) {
        if (v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
        merged[k] = v;
      }
      merged.ts = prev.ts < entry.ts ? prev.ts : entry.ts;
      merged.updated = prev.ts > entry.ts ? prev.ts : entry.ts;
      merged.tags = [...new Set([...(prev.tags || []), ...(entry.tags || [])])];
      byId.set(entry.id, merged);
    }
  }
  return [...byId.values()]
    .sort((a, b) => (b.updated || b.ts).localeCompare(a.updated || a.ts))
    .slice(0, MAX_ENTRIES);
}

// --- git plumbing -----------------------------------------------------------

function git(args, opts = {}) {
  const env = { ...process.env };
  if (opts.indexFile) env.GIT_INDEX_FILE = opts.indexFile;
  else delete env.GIT_INDEX_FILE;
  return execFileSync('git', args, {
    cwd: opts.cwd || repoRoot(),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    input: opts.input,
    env,
  }).trim();
}

function sleepSync(seconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

let cachedRoot = null;
export function repoRoot(from = process.env.CLAUDE_PROJECT_DIR || process.cwd()) {
  if (cachedRoot) return cachedRoot;
  cachedRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: from, encoding: 'utf8' }).trim();
  return cachedRoot;
}

export function targetBranch() {
  return process.env.JOS_REGISTRY_BRANCH || 'main';
}

function fetchTarget() {
  const branch = targetBranch();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      git(['fetch', '--quiet', 'origin', branch]);
      return `origin/${branch}`;
    } catch (err) {
      if (attempt === 2) throw err;
      sleepSync(2 ** (attempt + 1));
    }
  }
}

// Read the registry as it exists on the published branch (not the working tree),
// so concurrent sessions on feature branches all merge against the same base.
export function readPublished(pass, ref) {
  try {
    const blob = git(['show', `${ref}:${REGISTRY_PATH}`]);
    return decryptRegistry(blob, pass);
  } catch {
    return emptyRegistry();
  }
}

/**
 * Add entries to the published registry and push the result straight to the
 * target branch, without touching the current checkout. Only REGISTRY_PATH is
 * ever written, so this can never carry unrelated work-in-progress along.
 */
export function publish(newEntries, pass, opts = {}) {
  const branch = targetBranch();
  const message = opts.message || `jos files: +${newEntries.length}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const ref = fetchTarget();
    const base = readPublished(pass, ref);
    const merged = mergeEntries(base.entries, newEntries);

    const added = merged.length - base.entries.length;
    const changed = added > 0 || JSON.stringify(merged) !== JSON.stringify(mergeEntries(base.entries));
    if (!changed) return { pushed: false, added: 0, total: merged.length };

    const blob = encryptRegistry({ version: 1, updated: new Date().toISOString(), entries: merged }, pass);
    const indexFile = join(mkdtempSync(join(tmpdir(), 'jos-idx-')), 'index');
    try {
      const blobSha = git(['hash-object', '-w', '--stdin'], { input: blob });
      git(['read-tree', ref], { indexFile });
      git(['update-index', '--add', '--cacheinfo', `100644,${blobSha},${REGISTRY_PATH}`], { indexFile });
      const tree = git(['write-tree'], { indexFile });
      const parent = git(['rev-parse', ref]);
      const commit = git([
        '-c', 'user.name=Claude', '-c', 'user.email=noreply@anthropic.com',
        'commit-tree', tree, '-p', parent, '-m', message,
      ]);
      git(['push', '--quiet', 'origin', `${commit}:refs/heads/${branch}`]);
      return { pushed: true, added, total: merged.length, commit };
    } catch (err) {
      if (attempt === 3) throw err;
    } finally {
      rmSync(join(indexFile, '..'), { recursive: true, force: true });
    }
  }
}

function tryGit(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

function githubSlug(cwd) {
  const remote = tryGit(['remote', 'get-url', 'origin'], cwd);
  if (!remote) return null;
  // Direct GitHub remote, or the local git proxy that Claude Code on the web
  // rewrites origin to (http://…/git/<owner>/<repo>).
  const m = remote.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/)
    || remote.match(/\/git\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * Give an entry the most useful address available: the live GitHub Pages URL
 * for HTML already published on the target branch, a GitHub blob URL for
 * anything else under version control, and otherwise the absolute path on the
 * machine that produced it. Falls back to the bare path outside git.
 */
export function locate(absPath) {
  const dir = dirname(absPath);
  const root = tryGit(['rev-parse', '--show-toplevel'], dir);
  if (!root) return { path: absPath, url: null, repo: null, branch: null, project: basename(dir) };

  const slug = githubSlug(dir);
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD'], dir);
  const rel = relative(root, absPath).split('\\').join('/');
  const published = targetBranch();

  let url = null;
  if (slug) {
    // Presence on the published branch is what decides whether a link is live —
    // the branch that happens to be checked out says nothing about that.
    const onPublished = tryGit(['cat-file', '-e', `origin/${published}:${rel}`], root) !== null;
    const onBranch = tryGit(['ls-files', '--error-unmatch', rel], root) !== null;
    if (onPublished && /\.html?$/i.test(absPath)) {
      url = `https://${slug.owner.toLowerCase()}.github.io/${slug.repo}/${rel}`;
    } else if (onPublished) {
      url = `https://github.com/${slug.owner}/${slug.repo}/blob/${published}/${rel}`;
    } else if (onBranch && branch) {
      url = `https://github.com/${slug.owner}/${slug.repo}/blob/${branch}/${rel}`;
    }
  }

  return { path: absPath, url, repo: slug ? `${slug.owner}/${slug.repo}` : null, branch, project: basename(root) };
}

export function writeLocal(registry, pass, outPath) {
  const target = resolve(outPath);
  writeFileSync(target, encryptRegistry(registry, pass));
  return target;
}

export function readLocal(pass, inPath) {
  try {
    return decryptRegistry(readFileSync(resolve(inPath), 'utf8'), pass);
  } catch {
    return emptyRegistry();
  }
}
