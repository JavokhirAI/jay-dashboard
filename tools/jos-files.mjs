#!/usr/bin/env node
// JOS file registry — CLI.
//
//   node tools/jos-files.mjs add --path ./report.html --title "Отчёт"
//   node tools/jos-files.mjs add --url https://claude.ai/public/artifacts/... --title "Лендинг"
//   node tools/jos-files.mjs sweep ~/Desktop ~/Documents
//   node tools/jos-files.mjs list
//   node tools/jos-files.mjs export --md brain-digest.md
//   node tools/jos-files.mjs install-hooks --global
//
// Needs JOS_PASSPHRASE in the environment (same passphrase as the JOS pages).

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, basename, extname, dirname } from 'node:path';

import {
  TRACKED_EXTENSIONS, kindForPath, passphrase, publish, readPublished, locate,
  normalizeEntry, mergeEntries, targetBranch, repoRoot, encryptRegistry, decryptRegistry,
} from './jos-registry.mjs';

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.cache', 'dist', 'build', 'vendor', '.venv', 'venv',
  '__pycache__', '.next', 'coverage', 'Library', 'AppData', '.Trash', 'encrypted',
]);

// Files these pipelines regenerate constantly — noise, not artifacts worth an entry.
const SKIP_NAMES = new Set([
  'index.html', 'strategy.html', 'files.html', 'README.md', 'CLAUDE.md', 'CHANGELOG.md',
]);

function parseArgs(argv) {
  const out = { _: [], tags: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'tag') { out.tags.push(argv[++i]); continue; }
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = true;
    else out[key] = argv[++i];
  }
  return out;
}

function requirePassphrase() {
  const pass = passphrase();
  if (!pass) {
    console.error(
      'JOS_PASSPHRASE is not set. The registry is encrypted with the JOS passphrase;\n' +
      'export it in this environment (or pass it for a single run) and retry.'
    );
    process.exit(3);
  }
  return pass;
}

// --- commands ---------------------------------------------------------------

function cmdAdd(args) {
  const pass = requirePassphrase();
  const target = args.path || args._[0];
  if (!target && !args.url) {
    console.error('usage: jos-files add (--path <file> | --url <link>) [--title t] [--note n] [--tag x]');
    process.exit(2);
  }

  let entry = { title: args.title, note: args.note, tags: args.tags, source: args.source || 'manual', session: args.session };
  if (target) {
    const abs = resolve(target);
    if (!existsSync(abs)) { console.error(`no such file: ${abs}`); process.exit(2); }
    entry = { ...entry, ...locate(abs), kind: kindForPath(abs), size: statSync(abs).size };
    entry.title = args.title || basename(abs);
  }
  if (args.url) { entry.url = args.url; entry.kind = args.kind || entry.kind || 'link'; entry.title = entry.title || args.url; }
  if (args.kind) entry.kind = args.kind;

  // Deliberately does not name the file: commit messages are public.
  const result = publish([normalizeEntry(entry)], pass, { message: 'jos files: +1' });
  console.log(result.pushed
    ? `registered "${entry.title}" → ${targetBranch()} (${result.total} total)`
    : `"${entry.title}" already registered`);
}

function walk(dir, depth, out, sinceMs) {
  if (depth < 0) return out;
  let items;
  try { items = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const item of items) {
    if (item.name.startsWith('.') || SKIP_DIRS.has(item.name)) continue;
    const full = join(dir, item.name);
    if (item.isDirectory()) { walk(full, depth - 1, out, sinceMs); continue; }
    if (!TRACKED_EXTENSIONS.has(extname(item.name).toLowerCase())) continue;
    if (SKIP_NAMES.has(item.name)) continue;
    try {
      const st = statSync(full);
      if (sinceMs && st.mtimeMs < sinceMs) continue;
      out.push({ path: full, size: st.size, mtime: new Date(st.mtimeMs).toISOString() });
    } catch { /* unreadable — skip */ }
  }
  return out;
}

function cmdSweep(args) {
  const pass = requirePassphrase();
  const days = Number(args.days || 30);
  const depth = Number(args.depth || 3);
  const sinceMs = days > 0 ? Date.now() - days * 86400000 : 0;
  const roots = (args._.length ? args._ : [repoRoot()]).map((r) => resolve(r.replace(/^~/, homedir())));

  const found = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    walk(root, depth, found, sinceMs);
  }

  const entries = found.map((f) => normalizeEntry({
    ...locate(f.path),
    title: basename(f.path),
    kind: kindForPath(f.path),
    size: f.size,
    ts: f.mtime,
    source: 'sweep',
  }));

  if (!entries.length) { console.log('sweep: nothing new'); return; }
  const result = publish(entries, pass, { message: `jos files: sweep +${entries.length}` });
  console.log(result.pushed
    ? `sweep: ${result.added} new, ${result.total} total`
    : `sweep: nothing new (${entries.length} already registered)`);
}

function cmdList(args) {
  const pass = requirePassphrase();
  execFileSync('git', ['fetch', '--quiet', 'origin', targetBranch()], { cwd: repoRoot(), stdio: 'ignore' });
  const reg = readPublished(pass, `origin/${targetBranch()}`);
  if (args.json) { console.log(JSON.stringify(reg, null, 2)); return; }
  if (!reg.entries.length) { console.log('registry is empty'); return; }
  for (const e of reg.entries.slice(0, Number(args.limit || 40))) {
    console.log(`${e.ts.slice(0, 10)}  ${e.kind.padEnd(6)}  ${e.title}`);
    console.log(`            ${e.url || e.path}`);
  }
  console.log(`\n${reg.entries.length} entries · updated ${reg.updated}`);
}

// A digest the second brain can ingest as a plain note.
function cmdExport(args) {
  const pass = requirePassphrase();
  execFileSync('git', ['fetch', '--quiet', 'origin', targetBranch()], { cwd: repoRoot(), stdio: 'ignore' });
  const reg = readPublished(pass, `origin/${targetBranch()}`);
  const lines = ['# JOS — файлы и артефакты', '', `_обновлено: ${reg.updated}_`, ''];
  let day = null;
  for (const e of reg.entries) {
    const d = e.ts.slice(0, 10);
    if (d !== day) { day = d; lines.push('', `## ${d}`, ''); }
    lines.push(`- **${e.title}** (${e.kind}) — ${e.url || `\`${e.path}\``}${e.note ? ` — ${e.note}` : ''}`);
  }
  const out = args.md === true || !args.md ? 'jos-files.md' : args.md;
  writeFileSync(resolve(out), lines.join('\n') + '\n');
  console.log(`wrote ${resolve(out)} (${reg.entries.length} entries)`);
}

function cmdInstallHooks(args) {
  const root = repoRoot();
  const settingsPath = args.global
    ? join(homedir(), '.claude', 'settings.json')
    : join(args.project ? resolve(args.project) : root, '.claude', 'settings.json');

  // A global install runs against a fixed clone, so the hook needs an absolute
  // path; a project install stays relative to whatever repo it is dropped into.
  const base = args.global ? root : '$CLAUDE_PROJECT_DIR';
  const capture = `node "${base}/tools/hooks/capture-file.mjs"`;
  const flush = `node "${base}/tools/hooks/flush-files.mjs"`;
  const timeouts = { [capture]: 10, [flush]: 60 };

  let settings = {};
  if (existsSync(settingsPath)) {
    try { settings = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { settings = {}; }
  }
  settings.hooks ||= {};
  const put = (event, matcher, command) => {
    settings.hooks[event] ||= [];
    const already = settings.hooks[event].some((g) =>
      (g.hooks || []).some((h) => (h.command || '').includes(basename(command.split('"')[1] || command))));
    if (already) return false;
    const hook = { type: 'command', command, timeout: timeouts[command] };
    settings.hooks[event].push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
    return true;
  };

  const a = put('PostToolUse', 'Write|Edit|NotebookEdit|Artifact', capture);
  const b = put('Stop', null, flush);
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
  console.log(`${a || b ? 'installed' : 'already present'} → ${settingsPath}`);
}

// Round-trips the exact ciphertext layout files.html decrypts, so a green
// selftest means the browser side will open it too.
function cmdSelftest() {
  const pass = 'selftest-passphrase';
  const reg = { version: 1, updated: new Date().toISOString(), entries: [normalizeEntry({ path: '/tmp/a.html', title: 'a' })] };
  const blob = encryptRegistry(reg, pass);
  const back = decryptRegistry(blob, pass);
  if (JSON.stringify(back) !== JSON.stringify(reg)) { console.error('FAIL: round-trip mismatch'); process.exit(1); }
  try {
    decryptRegistry(blob, 'wrong');
    console.error('FAIL: wrong passphrase decrypted');
    process.exit(1);
  } catch { /* expected */ }
  const merged = mergeEntries(reg.entries, [normalizeEntry({ path: '/tmp/a.html', title: 'a renamed' })]);
  if (merged.length !== 1 || merged[0].title !== 'a renamed') { console.error('FAIL: merge/dedupe'); process.exit(1); }
  console.log('selftest ok — crypto round-trip, wrong-passphrase rejection, dedupe');
}

const COMMANDS = { add: cmdAdd, sweep: cmdSweep, list: cmdList, export: cmdExport, 'install-hooks': cmdInstallHooks, selftest: cmdSelftest };

const argv = process.argv.slice(2);
const command = argv[0];
if (!command || !COMMANDS[command]) {
  console.error(`usage: jos-files <${Object.keys(COMMANDS).join('|')}> [options]`);
  process.exit(2);
}
COMMANDS[command](parseArgs(argv.slice(1)));
