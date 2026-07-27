#!/usr/bin/env node
// PostToolUse hook — notices artifacts as they are produced and queues them.
//
// Deliberately does no network and no crypto: it runs after every Write/Edit,
// so it must stay in the sub-millisecond range and must never fail a tool call.
// The queue is drained once per session by flush-files.mjs.

import { appendFileSync, mkdirSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, basename, resolve } from 'node:path';

const QUEUE_DIR = join(tmpdir(), 'jos-file-queue');

const TRACKED = new Set(['.html', '.htm', '.docx', '.doc', '.dotx', '.pdf', '.pptx', '.potx', '.xlsx', '.xlsm']);
const SKIP_NAMES = new Set(['index.html', 'strategy.html', 'files.html']);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin() || '{}');
  } catch {
    return;
  }

  const session = payload.session_id || 'unknown';
  const tool = payload.tool_name || '';
  const input = payload.tool_input || {};
  const response = payload.tool_response || {};
  const queued = [];

  // Files written to disk.
  const filePath = input.file_path || input.notebook_path;
  if (filePath && TRACKED.has(extname(filePath).toLowerCase()) && !SKIP_NAMES.has(basename(filePath))) {
    const abs = resolve(payload.cwd || process.cwd(), filePath);
    // Scratchpad and temp files disappear with the container — not artifacts.
    if (!abs.startsWith(tmpdir()) && !abs.includes('/scratchpad/')) {
      let size = null;
      try { size = statSync(abs).size; } catch { /* deleted already */ }
      queued.push({ path: abs, size, source: 'claude-code', session, tool });
    }
  }

  // Published artifacts: the deliverable is the URL, not a local file.
  if (tool === 'Artifact') {
    const blob = typeof response === 'string' ? response : JSON.stringify(response);
    const url = (blob.match(/https:\/\/[^\s"'<>)]+/) || [])[0];
    if (url) {
      queued.push({
        url,
        kind: 'artifact',
        title: input.title || (input.file_path ? basename(input.file_path) : null),
        note: input.description || null,
        source: 'artifact',
        session,
      });
    }
  }

  if (!queued.length) return;
  mkdirSync(QUEUE_DIR, { recursive: true });
  const now = new Date().toISOString();
  appendFileSync(
    join(QUEUE_DIR, `${session}.jsonl`),
    queued.map((q) => JSON.stringify({ ...q, ts: now })).join('\n') + '\n'
  );
}

try { main(); } catch { /* a hook must never break the session */ }
process.exit(0);
