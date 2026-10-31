# Changelog

All notable changes to dsh-memory-layer. The canonical history also lives in the README
version-history table; this file exists so the changes are visible on npm and in the tarball.

## v0.11.2 — 2026-10-31

### Changed (repository re-baselined; no functional change)

- The repository was restored from the released 0.11.1 tarball: the 0.11.0/0.11.1 source tree was lost,
  and the published package was the only surviving copy. Module code is byte-identical to 0.11.1; only
  version metadata and dev-side files changed, hence the version bump (never ship different content
  under an already published version).
- `README.md` / `README.en.md` version banner → v0.11.2; the English history gains the missing v0.11.1
  row; both histories gain this entry.
- `ARCHITECTURE.md` now points at `tests/core.test.mjs` (it referenced a non-existent
  `tests/v011.test.mjs`).
- `SECURITY.md`: supported versions 0.9.x → 0.11.x; removed the false `audit.log` claim (there has been
  no audit writer since v0.10.0 — deletion is a tombstone, `purge` is the only irreversible operation).
- CI matrix covers the declared Node floor 22.19.x alongside 24.x; stale onnxruntime/sharp comment removed.
- `.gitignore` now ignores `*.tgz`, `*.log`, `backups/` and `dump-*.md`.
- `pnpm-lock.yaml` deleted (stale 0.1.1-rc.2-era lock; CI uses npm and `package-lock.json`, regenerated).

### Removed / adjusted (tests encoding pre-0.11 semantics)

- `tests/memory.test.mjs`: "removeEntry：删除条目并自动备份数据库（v0.5：SQLite）" removed — since
  v0.11.0 `remove` is a tombstone and writes no backup; covered by `tests/core.test.mjs`
  ("remove 是墓碑：行仍在库里，restore 能复活" and "purge 是真删，且不落备份副本").
- `tests/v05.test.mjs`: "restoreEntry：从备份回滚单条目，保留元数据" removed — `restore` now revives
  the tombstoned row instead of reading a backup; covered by `tests/core.test.mjs`
  ("remove 是墓碑：行仍在库里，restore 能复活").
- `tests/v2-core.test.mjs`: the same-key overwrite case now uses exactly equal `mkey`s (v0.11.0 replaced
  prefix matching with exact matching); the assertion itself is unchanged.

## v0.11.1 — 2026-10-28

### Changed (no automatic DB copies on any write path)

- `compact` no longer takes a full backup. It only flips `status` to `deleted` and tombstones are
  revived by `restore`, so a copy is pure redundancy; this also made the previous release
  inconsistent (the fingerprint migration never backed up either).
- `purge` (the one truly destructive action) no longer backs up first: the backup dir sits next to
  the database, so a copy would keep exactly the content purge is supposed to erase.
- `backupDb()` stays exported as a manual / tooling entry point; `restore` still reads any backups
  that already exist.
- Docs corrected where they claimed automatic backups (`README.md` §3, action table, data section,
  version-history row, `db.mjs` header).

### Added (tests are shipped)

- `tests/core.test.mjs` (zero dependencies, `npm test`). The manifest declared a test script while
  the tarball carried no tests, so `npm test` failed for anyone who installed the package. It now
  runs against a temp `DSH_BIOMEMORY_DIR` and covers tombstone semantics, purge/compact producing
  no backup files, the one-shot fingerprint migration and the deleted-never-surfaces retrieval rule.

## v0.11.0 — 2026-10-27

### Fixed (correctness)

- `includeArchived=true` no longer returns **deleted (tombstoned)** entries. The "keep exact
  keyword hits that fell outside top-N" path skipped status filtering entirely, so removed
  memories could re-enter the model's context. `archived` is now visible only when explicitly
  requested; `deleted` never is.
- `remove` is now a real tombstone. It used to `DELETE` the row, contradicting both the README
  ("deletion is a tombstone, never physical") and the v0.10.1 tombstone-restore fix, which
  therefore only ever worked for `compact`. Irreversible removal moved to a separate `purge`
  action that backs the database up first.
- Fingerprints are now full-text SHA-1 instead of a djb2 over the first 20 characters. The old
  hash collided on any two memories sharing a 20-character prefix, and a collision silently
  discarded the second memory. A one-shot migration recomputes existing fingerprints (and
  tombstones entries whose content is byte-identical).
- Same-key overwrite is now an **exact** `mkey` match. It used bidirectional prefix matching, so
  a short key tombstoned any longer key that merely started with it.
- Injection and real usage are counted separately. Injection only refreshes `last_accessed`;
  only keyword-query hits and `memory action=used` advance `hits` / `last_used`. Previously every
  prompt assembly counted as "used", so anything ever recalled stayed perpetually fresh and the
  30/90-day cleanup rules never fired.
- `stats().total` counts only active entries (it used to include tombstones and archived rows).
- `selfHeal()` can no longer throw and take the whole plugin down with it.
- `compact` backs up the database before writing — it is the only operation that changes many
  rows at once, yet it was the one operation without a backup.

### Fixed (multi-session / security)

- Session signals and the "pending summary" flag are per-session instead of a single module-level
  global: one session's files no longer leak into another session's recall, and a write in one
  session no longer clears another session's pending-settle marker.
- Realm is now inferred from the session working directory on write. Previously every memory was
  written with `realm='user'`, so the documented `project:<cwd>` isolation never existed.
- Local HTTP endpoints validate request origin/host; cross-site requests get 403. They previously
  had no check at all.
- Approval-service absence is reported once with an actionable hint instead of failing silently
  under the default `approvalFallback=deny`.
- The trigger-recall signal path warns once when no `session/event` has ever been received,
  instead of silently doing nothing.

### Added

- **Preference/decision channel**: decisions and preferences are pure natural language and
  usually carry no trigger (6 of 8 samples had none), so they could only ride the always-on
  snapshot. They now get a small independent budget (≤3 items / ≤400 chars by default).
- **Cold-start fallback**: when the store is still small and nothing was triggered, recent
  memories are injected instead of nothing.
- **`/memory stats`** — health incl. **trigger coverage**: how many memories can never be
  proactively recalled.
- **`/memory why <fp>`** — why a memory is (not) being injected.
- **`/memory preview`** — what would be injected right now.
- **`/memory used <fp>`**, **`purge <fp>`**, **`unarchive <fp>`**, **`help`**.
- Snapshot caching (it was recomputed on every prompt assembly despite being documented as
  "frozen"), dump-file rotation (keeps the latest 10), length pre-filter for near-duplicate
  comparison.

### Changed

- `hotTokenLimit` default 5000 → 2000, so trigger-driven recall — not the always-on snapshot —
  is the main channel.
- The `memory` tool description was cut from 14 lines to 7: it is injected into every prompt,
  and ~300 tokens per turn is a poor fit for a plugin that advertises token savings.

### Docs / housekeeping

- SECURITY.md updated (supported versions were stuck at 0.9.x; the audit-log claim was false
  since v0.10.0). README config table completed and the config path corrected
  (`~/.dsh/memory/`, not `~/.dsh/biomemory/`). Stale comments fixed (0.1.x runtime, vector
  column, removed embedding model, "bio-mimetic" name). Stale `pnpm-lock.yaml` removed.
  CI matrix now covers the declared Node floor 22.19.x.

## v0.10.2 — 2026-10-25

Intro line rewritten; tested desktop version bumped to 0.2.1-rc.3. No functional change.

## v0.10.1 — 2026-10-25

Plugin card copy rewritten (localized `meta`); `description` no longer carries a version or a
feature dump. Pinned entries are exempt from cleanup; tombstones can be revived. No other
functional change.

## v0.10.0 — 2026-10-05

Rebuilt as a memory layer: trigger-driven recall (`trigger`/`realm`/`mtype`/`mkey`), type-priority
ordering, five cleanup rules with tombstones and `compact.log`, workflow promotion and chains,
injection budget, `compact`/`dump`. Removed dream/reflect/conflict adjudication/audit and the
automatic Markdown mirror.
