---
name: strategic-report
description: Rebuild/update the encrypted strategic report page (strategy.html) in JOS. Use when Jay asks to "обнови стратегический отчёт", "update the strategy report/page", refresh the Strategy Room, add a strategy session log entry, or rotate the strategy page passphrase.
---

# Strategic Report (JOS Strategy Room)

`strategy.html` is a standalone, staticrypt-encrypted page in this repo (published via GitHub Pages next to `index.html`). It holds Jay's executive-level strategic report: meeting screen, diagnosis, 6-month strategy gantt, venture portfolio, budget frame, problems→decisions, meeting cadence, report script, and a session log.

**The passphrase is NOT stored in this repo.** It is separate from the main JOS passphrase and is shared privately in chat. Ask Jay for it only if re-encrypting and it wasn't provided; never write it to any committed file.

## Update procedure

1. **Gather fresh data** (parallel subagents work well):
   - Read AI (`mcp__Read_AI__list_meetings` / `get_meeting_by_id`, expand summary/action_items/transcript) — weekly reporting meetings, planning meetings, strategy reviews since the last update. Fireflies as fallback for meetings Read AI missed.
   - Slack: the private dev/product and onboarding channels + leadership DMs — directives, project status, blockers.
   - Google Drive: the weekly 1:1 sheet (rows = fields, columns = weeks), monthly report, roadmap sheets, Gemini meeting notes.
   - Note: Uzbek-language transcripts are noisy — flag numbers from them as "verify against source".
2. **Rebuild the page.** The plaintext source is NOT in the repo (gitignored pattern `*.plaintext.html`). Reconstruct by decrypting the published `strategy.html` is impossible — instead keep the working plaintext in the session scratchpad, or rebuild from the structure above plus fresh data. Keep the existing tab structure and dark styling; update facts, dates, the "Экран мита" decisions list, and append a new entry to the "Сессии" tab (baked into HTML, since localStorage entries are per-browser).
3. **Report format rules (what the stakeholder expects):** fact → plan → decision; budget in two mirrored views (cost categories vs support/R&D allocation) that reconcile; a gantt with owner / % complete / end date per project; per-project economics (CAC/LTV, breakeven) and kill/scale criteria; a numbered "decisions needed" list up front. No operational task lists — those live in the daily EOD bot and the weekly sheet.
4. **Encrypt & publish:**
   ```bash
   npx staticrypt strategy.html -p "<strategy passphrase>" --short   # run against the plaintext
   # inject robots meta into the wrapper:
   sed -i 's|<title>Protected Page</title>|<meta name="robots" content="noindex,nofollow,noarchive"/><title>JOS</title>|' encrypted/strategy.html
   mv encrypted/strategy.html <repo>/strategy.html && rmdir encrypted
   ```
5. **Verify no plaintext leak** before committing: `grep -c "Сардор\|Sardor" strategy.html` must be 0.
6. Commit with a message like `strategy room update: YYYY-MM-DD` and push. Never commit any `*.plaintext.html`.

## Guardrails

- This repo is public — nothing sensitive goes into committed files unencrypted (including this skill: keep it procedural, no strategy content, no names beyond what's already in git history).
- Do not touch `index.html` (owned by the daily/weekly routines) unless explicitly asked.
- The Google Sheets weekly report is the stakeholder's database — read it for data, don't restructure it.
