# Unified Design System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every client screen uses one font (Cairo) and one set of stage-color tokens (light beige + dark), with stat cards as lightly tinted cards, without moving anything on any screen.

**Architecture:** All color/font decisions move into `client/src/styles.css` as CSS custom properties, plus one global helper class family `.tone-<stage>` that sets local `--tone-*` variables. Screen CSS files then reference only tokens. A small Node script enforces "no raw hex in screen CSS" so each phase has a pass/fail check.

**Tech Stack:** Angular 20 (standalone components), plain CSS, Node (for the checker script).

**Spec:** `docs/superpowers/specs/2026-11-23-unified-design-system-design.md`

## Global Constraints

- Layout does not change: CSS edits, plus `class`/`[ngClass]` changes in HTML only. No template structure, bindings, or event changes.
- Do not touch `print-agent/`, `scan-agent/`, `exocad-agent/`, `backend/`, or anything inside `@media print`.
- Font stack: `'Cairo', 'IBM Plex Sans Arabic', 'Segoe UI', system-ui, sans-serif`; Cairo weights 400;600;700. Weights in use: 400 text, 600 headings/names, 700 stat numbers only.
- Stage names: `pending, design, khart, revision, finishing, finished, exited, urgent`. Values exactly as the spec table (bg / border / text per theme).
- Accent stays the existing `--accent-primary` (`#0f6e62` light, `#2dd4bf` dark).
- Red (`urgent`) only for emergency/overdue/errors; zero counts and normal states are neutral.
- Numbers ≥1000 shown with thousands separator, Latin digits (Angular `| number`).
- Both themes must work: `body.light-theme`, `body.dark-theme`, and OS preference when neither class is set.
- Work on a new branch `feat/unified-design` created from `main`. The current checkout has unrelated uncommitted changes in `print-agent/config.json` and `scan-agent/*.ps1`: never stage them.
- `npm run build` in `client/` passes after every task.
- Deployment: the client is on Vercel (builds `client/`, proxies `/api` to Railway); the backend is on Railway. This plan changes only the client, so Railway is untouched. Never push to or merge into `main` without the user's explicit OK — that ships to the lab. Pushing `feat/unified-design` (only when the user asks) gives a Vercel preview URL the lab can look at before release.
- Local and preview screens read the real production API through the proxy: during visual checks, look only — do not create, edit, pay, exit, or print cases.
- The app has a service worker (`scripts/stamp-sw.js` stamps it on build); after release, tell the user a browser refresh may be needed on lab PCs to see the new look.

## Review Focus

1. Light theme readability: tinted bg + text pairs must stay readable on beige `#f3efe6`; check each finished screen in light mode, not only dark.
2. OS-dark with no theme chosen: the `@media (prefers-color-scheme: dark)` block must carry every token (accent, badge, stage, tone), or screens go half-light.
3. Hover/active/focus states that had their own hex (buttons, chips, rows) must still be visibly different from rest state after conversion.
4. Overdue/urgent cards keep a visible red edge in both themes; exited cards stay clickable-looking (they open the original entry).
5. Elements rendered inside dialogs/overlays (bill dialog, create-case dialog, notifications panel) are part of the same CSS files — convert and check them, not only the main list.

Each task's verification step covers these for its own screens.

---

### Task 1: Branch and hex checker

**Files:**
- Create: `client/scripts/check-hex-colors.js`

**Interfaces:**
- Produces: `node scripts/check-hex-colors.js <file.css...>` (run from `client/`). Prints `path:line: #hex` for every hex color outside allowed places, then `OK (n files)` or `FAIL (n hits)`. Exit code 0/1.
- Allowed places: lines inside an `@media print { ... }` block (track brace depth), and lines ending with a comment containing `hex-ok:` followed by a reason.

- [ ] **Step 1:** `git switch main && git pull && git switch -c feat/unified-design` (if `git switch main` refuses because of the agent file changes, use `git stash push print-agent/config.json scan-agent/install-background.ps1 scan-agent/setup-this-pc.ps1` first and tell the user they are stashed).
- [ ] **Step 2:** Write the script. Hex regex: `/#[0-9a-fA-F]{3,8}\b/g`. Strip `/* ... */` comments from a line before matching except when checking for `hex-ok:`.
- [ ] **Step 3:** Verify it catches: `node scripts/check-hex-colors.js src/app/app.css` → expected `FAIL` with 6 hits listed.
- [ ] **Step 4:** Verify the escape hatches: make a temp file in the scratchpad with one hex inside `@media print { a { color:#000 } }` and one line `color:#fff; /* hex-ok: brand logo */` → expected `OK`.
- [ ] **Step 5:** Commit `client/scripts/check-hex-colors.js` — message `chore: add hex color checker for design token migration`.

### Task 2: Foundation — font, tokens, tone classes

**Files:**
- Modify: `client/src/index.html:10` (Google Fonts link)
- Modify: `client/src/styles.css:1-120` (token blocks + body font)

**Interfaces:**
- Produces (used by every later task):
  - `--font-sans`
  - `--stage-<name>-bg`, `--stage-<name>-border`, `--stage-<name>-text`, `--stage-<name>-solid` for the 8 stage names, in `:root` (light), `body.dark-theme`, and the prefers-color-scheme block.
  - `--stage-total-*` = neutral card (light: `--bg-card` / `--border-primary` / `--text-secondary`; dark: `#1c2027` / `#2a2d33` / `#9aa0a8`).
  - Global classes `.tone-<name>` (8 stages + `total`) that set `--tone-bg`, `--tone-border`, `--tone-text`, `--tone-solid` from the matching stage tokens. Screens style with `var(--tone-*)`.
  - Shared global classes: `.stat-tile` (bg `--tone-bg`, border `1px solid var(--tone-border)`, radius 14px; label color `--tone-text`; `.stat-tile__value` color `--text-primary`, weight 700) and `.stage-pill` (bg `--tone-bg`, color `--tone-text`, radius 6px, padding 2px 8px, weight 600).
  - `--badge-green-*` → finished tokens, `--badge-amber-*` → finishing, `--badge-red-*` → urgent (aliases via `var()`).

- [ ] **Step 1:** `index.html`: replace the font link with Cairo 400;600;700 + IBM Plex Sans Arabic 400;500;600 (fallback); drop Tajawal.
- [ ] **Step 2:** `styles.css`: add `--font-sans`; `body { font-family: var(--font-sans); }`.
- [ ] **Step 3:** Add stage tokens to `:root` (light values) and `body.dark-theme` (dark values) exactly from the spec table. `solid`: dark = the dark `text` value; light = the light `text` value.
- [ ] **Step 4:** Make the `@media (prefers-color-scheme: dark)` block a full copy of the `body.dark-theme` token set (including accent, badge, stage) — the Review Focus #2 case.
- [ ] **Step 5:** Add `.tone-*`, `.stat-tile`, `.stage-pill` classes.
- [ ] **Step 6:** `node scripts/check-hex-colors.js src/styles.css` is allowed to FAIL here (tokens live here); instead verify `npm run build` passes.
- [ ] **Step 7:** Start `ng serve` via the browser pane (`preview_start` with a `.claude/launch.json` entry: `npm --prefix client start`, port 4200). The user signs in themselves. Screenshot the reception screen in light, dark, and OS-dark (no class) — text is Cairo everywhere; nothing else should have moved.
- [ ] **Step 8:** Commit `client/src/index.html client/src/styles.css` — `feat(ui): Cairo font and stage color tokens`.

### Task 3: Reception (secretary)

**Files:**
- Modify: `client/src/app/modules/secretary/secretary.css` (282 hex)
- Modify: `client/src/app/modules/secretary/secretary.html` (stat cards ~line 160, phase badge, filter tabs)
- Modify: `client/src/app/modules/secretary/secretary.ts:500-505` (stat `color` → stage key)

**Interfaces:**
- Consumes: Task 2 tokens and classes.
- Produces: stat items now `{ label, value, tone: 'total' | 'pending' | 'design' | 'finishing' | 'finished' | 'exited' }` (rename `color` → `tone` in `stats()`): total→`total`, new→`pending`, design→`design`, finishing→`finishing`, finished→`finished`, exited→`exited`.

- [ ] **Step 1:** In `secretary.ts` change the `stats()` entries as above; update the type wherever `stat.color` was used.
- [ ] **Step 2:** `secretary.html`: stat card gets `class="stat-tile tone-{{ stat.tone }}"`, value `{{ stat.value | number }}`; filter tab counts `{{ filterCounts().x | number }}`; phase badge gets `stage-pill tone-{{ casePhaseBadge(c).color }}` (its `color` already returns stage names; map `'pending'`→`pending` etc. unchanged); urgent card edge uses `--stage-urgent-solid`.
- [ ] **Step 3:** `secretary.css`: delete `.stat-value--*` color variants; replace every remaining hex with the token of the same *meaning* (spec "متروك للمنفّذ"). Selected filter tab and primary buttons use `--accent-primary`. Remove `.dark-theme ...` overrides that only re-set colors now provided by tokens.
- [ ] **Step 4:** `node scripts/check-hex-colors.js src/app/modules/secretary/secretary.css` → `OK`.
- [ ] **Step 5:** `npm run build` → passes.
- [ ] **Step 6:** Screenshots, light + dark: dashboard top, case list (one urgent, one finished with exit button, one exited), bill dialog, create-case dialog, notifications panel. Check Review Focus 1, 3, 4, 5. "الخارجة 0" is grey, not red.
- [ ] **Step 7:** Show the user before/after screenshots; wait for OK.
- [ ] **Step 8:** Commit the three files — `feat(ui): reception uses unified tokens`.

### Tasks 4–8: Remaining screens

Same steps as Task 3 (convert hex → tokens; stat/badge markup → `stat-tile`/`stage-pill` + `tone-*` where the screen shows stages or counts; `| number` on counts; checker OK; build; light+dark screenshots including dialogs; user OK; commit). One task per group:

| Task | Files (`client/src/app/…`) | Commit message |
|---|---|---|
| 4 Print + scan | `modules/entry/entry.{css,html}`, `modules/station-scan/station-scan.{css,html}` | `feat(ui): print and scan screens use unified tokens` |
| 5 Design + finishing | `modules/design/design.*`, `modules/finishing/finishing.*`, `modules/case-management/case-management.*` | `feat(ui): design and finishing screens use unified tokens` |
| 6 Admin + finance | `modules/admin/admin.*`, `modules/admin/finance-panel/finance-panel.*`, `modules/secretary-dashboard/secretary-dashboard.*` | `feat(ui): admin and finance use unified tokens` |
| 7 Doctor portal | `modules/doctor/*.css` + their html, `modules/for-doctors/*`, `modules/requester/*` | `feat(ui): doctor portal uses unified tokens` |
| 8 Login + shared | `modules/login/*`, `shared/app-overflow-menu/*`, `shared/brand-lockup/*`, `shared/case-barcode/*`, `shared/tooth-chart/*`, `app.css` | `feat(ui): login and shared components use unified tokens` |

Task-specific notes:
- Task 5/8: remove the `font-family: 'Cairo', ...` lines in `design.css` (now inherited).
- Task 8: `tooth-chart` and `case-barcode` colors that encode tooth state or must stay black for scanning may keep hex with `/* hex-ok: <reason> */`.
- Task 8 final check: `node scripts/check-hex-colors.js $(git ls-files 'src/app/**/*.css')` → `OK`; `grep -rn "Tajawal\|font-family: 'Cairo'" src/app` → no output.
