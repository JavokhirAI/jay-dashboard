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

## Architecture
- **Source:** `index.plaintext.html` (gitignored — rebuild from sources / restore from Jay's Desktop staging)
- **Published:** `index.html` (encrypted)
- **Host:** GitHub Pages on this repo
- **Hardening:** `robots: noindex,nofollow,noarchive` baked in pre-encryption

> Do not document the passphrase, internal contents, or anything sensitive in this README — the repo is public.
