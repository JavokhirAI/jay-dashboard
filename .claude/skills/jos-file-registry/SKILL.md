---
name: jos-file-registry
description: Register a file, document, or published link in the JOS file registry so it shows up on the Файлы page. Use when Jay asks "добавь этот файл в JOS", "почему файла нет в JOS", "покажи последние файлы", when a session produced an artifact outside this repo (Desktop docs, another project, a Claude chat artifact), or when running the scheduled sweep that catches anything the hooks missed.
---

# JOS file registry

Every artifact Jay produces with Claude — HTML pages, Word docs, PDFs, decks,
sheets, published artifact links — lands in one encrypted registry and shows up
at <https://javokhirai.github.io/jay-dashboard/files.html> with a clickable link
(when the file is reachable) or its absolute location on disk (when it isn't).

- **Registry:** `files/registry.enc.json` on `main` — AES-256-GCM, PBKDF2-SHA256
  600k, keyed by the **main JOS passphrase**. Never commit it decrypted.
- **Page:** `files.html` — plaintext shell, decrypts the registry in-browser.
- **Tools:** `tools/jos-files.mjs` (CLI), `tools/hooks/*.mjs` (automatic capture).

The passphrase comes from `JOS_PASSPHRASE` in the environment. It is not stored
in this repo and must never be written into a committed file.

## How entries arrive

1. **Automatically, in any session where the hooks are installed.** A
   `PostToolUse` hook queues every `.html/.docx/.pdf/.pptx/.xlsx` write and every
   published Artifact URL; the `Stop` hook flushes the queue into the registry
   once per turn and pushes straight to `main`. Only `files/registry.enc.json` is
   ever committed by the hooks, so in-progress work is never dragged along.
2. **On request, from anywhere.** Run the CLI against a clone of this repo.
3. **By sweep**, as a safety net for files the hooks never saw.

## Registering something by hand

```bash
node tools/jos-files.mjs add --path ~/Desktop/отчёт.docx --title "Отчёт за июль" --note "для Сардора"
node tools/jos-files.mjs add --url https://claude.ai/public/artifacts/... --kind artifact --title "Лендинг"
node tools/jos-files.mjs list
```

`add` figures out the best address itself: a GitHub Pages URL for HTML published
on `main`, a GitHub blob URL for anything else under version control, otherwise
the absolute path. Re-adding the same file updates its row instead of duplicating it.

## Sweep (scheduled safety net)

```bash
node tools/jos-files.mjs sweep ~/Desktop ~/Documents --days 30 --depth 3
```

Walks the given roots for recently-modified documents and adds whatever is
missing. Safe to run repeatedly — entries dedupe by target. Good candidate to
hang off the existing daily routine.

## Installing the hooks somewhere new

```bash
node tools/jos-files.mjs install-hooks --global            # every local session, any project
node tools/jos-files.mjs install-hooks --project ~/code/x  # one other repo
```

A global install writes absolute paths into `~/.claude/settings.json` pointing at
this clone, so sessions in other projects still write to the same registry. On
Claude Code web, hooks only exist for repos that carry them in
`.claude/settings.json`, so add them per repo there.

## Troubleshooting

- **"не задан JOS_PASSPHRASE"** — the entries were parked in
  `$TMPDIR/jos-file-queue/unsent.jsonl` and will ride along with the next
  successful flush in that container. Set the env var and the queue drains.
  In an ephemeral web container, the parked queue dies with the container: fix
  the env var, then re-register with `add`.
- **Page says the registry is empty** — either nothing has been registered on
  `main` yet, or the browser passphrase differs from the one used to write it.
  `node tools/jos-files.mjs list` settles which.
- **Nothing appears after a session** — the hooks skip `index.html`,
  `strategy.html`, `files.html` (pipeline output, not artifacts) and anything
  under the temp/scratchpad directories, since those files do not survive.
- **Push rejected** — `publish()` refetches and re-merges up to four times; a
  persistent failure means credentials, not a conflict.

## Guardrails

- This repo is public. Titles, notes, and paths are content — they only ever
  land in the encrypted blob, never in a commit message, README, or this file.
- Commit messages the tooling generates are deliberately dull (`jos files: …`).
  Keep them that way.
- Do not touch `index.html` or `strategy.html` from this tooling — they belong to
  the daily/weekly routines and the `strategic-report` skill.
