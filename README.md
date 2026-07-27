# Jay OS

**INTERNAL.** Live URL: <https://javokhirai.github.io/jay-dashboard/>

Protected by AES-256 client-side encryption (`staticrypt`, PBKDF2 600k iterations). The encrypted blob is what's served publicly; without the passphrase the content cannot be decrypted in-browser.

## Access

The passphrase is **not stored in this repo**. It is shared privately, person-to-person, only with people who need access. There's no server to check against — it's set at encryption time and lives only in users' heads.

To rotate the passphrase, re-encrypt and update the two routines that re-encrypt on a schedule (`jay-self-report-daily`, `jay-weekly-report-thu`) so they don't revert it:

```bash
npx staticrypt index.plaintext.html -p "<new-passphrase>" --short
mv encrypted/index.plaintext.html index.html && rmdir encrypted
git add index.html && git commit -m "rotate passphrase" && git push
# then update the -p "..." value in both scheduled-task SKILL.md files
```

## File registry (`files.html`)

Every artifact produced in a Claude session — HTML pages, Word docs, PDFs, decks,
sheets, published artifact links — is registered automatically and listed at
`/files.html`, each with a live link where one exists and its absolute location
where it doesn't.

- `files/registry.enc.json` — the registry, AES-256-GCM under a PBKDF2-SHA256
  600k key derived from the **main JOS passphrase**. Only the encrypted blob is
  ever committed; `files.html` decrypts it in the browser.
- `tools/hooks/capture-file.mjs` (`PostToolUse`) queues artifacts as they are
  written; `tools/hooks/flush-files.mjs` (`Stop`) merges the queue into the
  registry once per turn and pushes only that one file straight to `main`.
- `tools/jos-files.mjs` — CLI for manual entries, the sweep safety net, listing,
  a Markdown digest for the second brain, and installing the hooks elsewhere.

**Setup:** the tooling reads the passphrase from `JOS_PASSPHRASE` in the
environment — set it in the Claude Code web environment and in the local shell
profile. Without it, captured entries are parked rather than written. Details and
troubleshooting live in the `jos-file-registry` skill in `.claude/skills/`.

## Architecture
- **Source:** `index.plaintext.html` (gitignored — rebuild from sources / restore from Jay's Desktop staging)
- **Published:** `index.html` (encrypted)
- **Strategy Room:** embedded as a native tab inside `index.html` (isolated frame; updated via the `strategic-report` skill in `.claude/skills/`). Standalone `strategy.html` (separately encrypted) kept as fallback.
- **Host:** GitHub Pages on this repo
- **Hardening:** `robots: noindex,nofollow,noarchive` baked in pre-encryption

> Do not document the passphrase, internal contents, or anything sensitive in this README — the repo is public.
