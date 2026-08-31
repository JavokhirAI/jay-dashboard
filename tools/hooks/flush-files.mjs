#!/usr/bin/env node
// Stop hook — drains this session's queue into the published JOS registry.
//
// Runs once when the turn ends rather than per-write, so a session that
// produces ten files costs one fetch/push instead of ten. Always exits 0:
// a registry problem must never hold up the session.

import { existsSync, readFileSync, rmSync, mkdirSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoRoot, passphrase, publish, normalizeEntry, kindForPath, locate } from '../jos-registry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUEUE_DIR = join(tmpdir(), 'jos-file-queue');
const PARKED = join(QUEUE_DIR, 'unsent.jsonl');

function say(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

function main() {
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* no payload */ }

  const session = payload.session_id || 'unknown';
  const queueFile = join(QUEUE_DIR, `${session}.jsonl`);

  // Anything a previous turn could not send (no passphrase, network down) rides
  // along with the next successful flush.
  const sources = [queueFile, PARKED].filter(existsSync);
  if (!sources.length) return;

  const raw = sources.flatMap((f) => readFileSync(f, 'utf8').split('\n').filter(Boolean));
  if (!raw.length) return;

  const pass = passphrase();
  if (!pass) {
    mkdirSync(QUEUE_DIR, { recursive: true });
    if (existsSync(queueFile)) {
      appendFileSync(PARKED, readFileSync(queueFile, 'utf8'));
      rmSync(queueFile, { force: true });
    }
    say(`JOS: ${raw.length} файл(ов) ждут отправки в реестр — не задан JOS_PASSPHRASE.`);
    return;
  }

  // Seed the repo root from this script's own location: when the hook is
  // installed globally it fires inside other projects, and the registry still
  // has to be written to the jay-dashboard clone that owns this file.
  repoRoot(join(HERE, '..', '..'));

  const entries = raw.map((line) => {
    const item = JSON.parse(line);
    // locate() runs here rather than at capture time: by the end of the turn the
    // file has usually been committed, so it can resolve to a real link.
    const where = item.path ? locate(item.path) : {};
    return normalizeEntry({
      ...item,
      ...where,
      title: item.title || (item.path ? basename(item.path) : item.url),
      kind: item.kind || (item.path ? kindForPath(item.path) : 'link'),
    });
  });

  const result = publish(entries, pass, {
    message: `jos files: session ${session.slice(0, 8)} +${entries.length}`,
  });

  for (const f of sources) rmSync(f, { force: true });
  if (result.pushed && result.added > 0) {
    say(`JOS: +${result.added} в реестре файлов (всего ${result.total}) → /files.html`);
  }
}

try {
  main();
} catch (err) {
  say(`JOS: реестр файлов не обновлён (${String(err.message || err).slice(0, 160)})`);
}
process.exit(0);
