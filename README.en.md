# dsh-memory-layer

> **A memory layer for DeepSeek Harness**: one local file, zero services, zero API calls — recall driven by **trigger signals**, so the right memory shows up at the right moment.

**v0.11.2** · MIT License · DSH 0.2.x (`>=0.2.0-rc.2 <0.3.0-0`, tested on the 0.2.1-rc.3 desktop app) · Node >= 22.19.0

---

## What it is

In one line: **a memory layer, not a memory platform.**

- **Not**: external service, vector search, embedding models, knowledge graphs, cloud sync, web UI.
- **Is**: one SQLite file plus a deterministic rule set for "when should what be recalled".

The difference from a memory platform is not the feature count — it is that **there is nothing extra to run**. Install the plugin; the data lives in `.dsh/biomemory/biomemory.db` on your machine, and copying that file migrates your memory.

## Four layers

### 1. Storage: single-file SQLite

| Field | Meaning |
|---|---|
| `realm` | Isolation: `user` or `project:<cwd>` |
| `mtype` | Memory type: `workflow` / `error` / `decision` / `fact` |
| `trigger` | Trigger signal string (below) |
| `mkey` | Topic key used for same-key overwrite |
| `text` | The memory itself |
| `created_at` / `last_accessed` / `hits` | Lifecycle: created / last used / use count |
| `status` | `active` / `archived` / `deleted` (deletion is a **tombstone**) |

Two helper tables: `chains` (workflow chains) and `trigger_counts` (repetition counter for workflow promotion).

### 2. Recall: driven by trigger signals

The plugin does not wait for the model to "remember". It watches what is happening:

- Signals: the session working directory (`session.cwd`) plus the last 12 tool calls (names and arguments — file paths, commands, error codes).
- Three trigger shapes only, readable and explainable:
  - `file:<name>` — e.g. `file:package.json`
  - `tool:<tool>` — e.g. `tool:pwsh`
  - `err:<CODE>` — e.g. `err:MODULE_NOT_FOUND`
- On a hit, memories are injected ordered **workflow > error > decision > fact**, then by last-used time; if a workflow chain matches, the **whole chain** is injected.
- **Injection budget**: at most 8 items / 1200 characters per recall. No signal, no injection — and no tokens spent.

### 3. Cleanup: five explainable rules

Run `/memory compact`; every eviction is written to `compact.log`:

1. A newer memory with the same `realm + type + key` overwrites the older one (tombstoned) on the write path;
2. `fact`: unused (use count <= 1) for more than 30 days -> tombstone;
3. `workflow` / `error` / `decision`: no TTL, but unused for more than 90 days -> half weight;
4. `error` and `decision` are **never auto-deleted**;
5. Every eviction/demotion is logged (time, fingerprint, rule, summary).

### 4. Adaptation: workflows emerge from repetition

When the same trigger appears **more than 3 times**, related memories are promoted to `workflow` and ordered into a chain:

```
when file:package.json: read package.json -> run tests -> then edit code
```

A chain records **order, not causation** — it does not pretend to know why, only what you actually did last time.

## Install

### Desktop app: install by package name (recommended)

1. Open the DSH desktop app → **Plugins** in the sidebar → **Add plugin**;
2. Type the package name `dsh-memory-layer` and click **Install** (it is enabled automatically).

CLI equivalent:

```bash
# replace desktop with your profile name
dsh plugin --profile desktop add dsh-memory-layer
```

### Local development (link)

```bash
dsh plugin --profile desktop add link:./dsh-memory-layer
```

Restart DSH afterwards (profiles with HMR hot-mount it).

## Usage

### Tool `memory`

| action | Description |
|---|---|
| `add` | Write a memory (`text` required; `track=user|agent`; `source` for provenance) |
| `query` | Keyword query (`text`/`topK`/`fragmentTypes`/`includeArchived`) |
| `used` | Mark "this was actually used just now" (advances `hits` / `last_used`) |
| `list` / `update` | Browse / edit |
| `remove` | Tombstone (row stays; `restore` brings it back) |
| `purge` | **Physical delete** (irreversible; auto-backs-up the DB first) |
| `restore` / `pin` / `unpin` | Roll back / pin / unpin |
| `compact` | Run the five rules (`dryRun=true` to preview; auto-backs-up before writing) |
| `dump` | Export human-readable Markdown (keeps the latest 10) |

A second tool, `memory_recall`, is available for explicit "do you remember..." lookups.

### Command `/memory`

```
/memory list | query <words> | add <text> | edit <fp> <text> | entries [words]
/memory remove <fp> | purge <fp> | undo <fp> | unarchive <fp> | used <fp>
/memory pin <fp> | unpin <fp>
/memory stats | why <fp> | preview
/memory compact [--dry-run] | dump | help
```

`stats` reports health including **trigger coverage** (how many memories have no trigger and can therefore never be recalled proactively). `why <fp>` explains why a memory is (not) injected. `preview` shows what would be injected right now.

### Write approval

Important memories (user preferences / decisions / corrections) go through DSH's official approval. Approval is required before storing, and when the approval service is unavailable writes are **denied by default** (fail-closed; set `approvalFallback=auto` to relax).

## Data and privacy

- Fully local: no network requests, no external APIs, no telemetry.
- Database: `<DSH_BIOMEMORY_DIR || ~/.dsh/biomemory>/biomemory.db` (SQLite, WAL).
- Deletion is a tombstone (recoverable); `compact` only changes status inside the file. Use `dump` when you want a Markdown copy.
- Env vars: `DSH_BIOMEMORY_DIR` (data dir), `DSH_MEMORY_ROOT` (Markdown backup/log dir).
- **Config location**: `<DSH_MEMORY_ROOT || ~/.dsh/memory>/biomemory.config.json`
  (v0.11 fix: the docs previously said `~/.dsh/biomemory/`, which does not match the code).
- **Local HTTP endpoints** (`/biomemory/api`, registered when the host exposes a web server):
  only local origins are accepted, cross-site requests get 403. Use `DSH_MEMORY_API_ORIGINS`
  to allow specific origins, or `DSH_MEMORY_API_NOAUTH=1` to disable the check (not recommended).

## Configuration

`<DSH_MEMORY_ROOT || ~/.dsh/memory>/biomemory.config.json` (or bundle config) can override:

| Key | Default | Meaning |
|---|---|---|
| `nearDuplicateThreshold` | 0.7 | Similarity threshold for write dedupe (0 = off) |
| `nearDuplicateAction` | merge | On near-duplicate: merge, or `skip` (report only) |
| `approvalFallback` | deny | Deny when approval is unavailable, or `auto` |
| `decayThreshold` | 3 | "Low weight" warning threshold |
| `hotTokenLimit` | 2000 | Token cap for the always-on snapshot (v0.11: 5000 → 2000) |
| `maxQueryResults` | 20 | Query result cap |
| `weightCap` | 20 | Weight ceiling |
| `sinkWindowMinutes` | 5 | Window (minutes) for the "please summarise" nudge |
| `decisionChannelMax` | 3 | Max items per turn in the preference/decision channel (0 = off) |
| `decisionChannelChars` | 400 | Char budget for that channel (0 = off) |
| `coldStartFallbackMax` | 3 | Cold-start fallback items (0 = off) |

## Deliberately not done

- **No vector/embedding search**: same input, same result; retrieval must be explainable.
- **No automated "reflection"**: without a model it does not pretend to generalise; workflows only emerge from repetition.
- **No delete-means-gone**: every deletion leaves a tombstone and can be rolled back.
- **No cross-machine sync**: that is a different product; here the file itself is portable.

## Version history

| Version | Date | Changes |
|---|---|---|
| **v0.11.2** | 2026-10-31 | **Repository re-baselined on the released 0.11.1 tarball** (the 0.11.0/0.11.1 source tree was lost; module code is byte-identical to 0.11.1). Dev-side fixes: README version exposure, ARCHITECTURE test reference, SECURITY supported versions / false `audit.log` claim, CI Node 22.19 matrix, `.gitignore`; two pre-0.11 test cases removed and the same-key case switched to exact keys; stale `pnpm-lock.yaml` deleted. No functional change. See `CHANGELOG.md` |
| **v0.11.1** | 2026-10-28 | **No automatic DB copies on any write path + tests shipped**: `compact` / `purge` / fingerprint migration all stop writing backup copies (tombstones are revived by `restore`; `purge` must not leave a copy behind; `backupDb()` stays as a manual entry point); `files` now ships `tests/core.test.mjs` so `npm test` works after install. See `CHANGELOG.md` |
| **v0.11.0** | 2026-10-27 | **Correctness & observability**: fixed `includeArchived` returning deleted tombstones; `remove` is now a real tombstone (physical delete moved to `purge`); fingerprints are now full-text hashes (the old first-20-chars hash collided and silently dropped memories) with a one-shot re-migration; same-key overwrite is now an exact match (prefix matching tombstoned unrelated entries); injection and real usage are counted separately (`last_accessed` vs `last_used`) so cleanup rules are no longer starved by self-feedback; realm is inferred from the session cwd on write; session state and signals are per-session; local HTTP endpoints validate origin; `selfHeal` no longer throws; `compact` backs up before writing. **Added**: preference/decision channel, cold-start fallback, `/memory stats` (incl. trigger coverage) / `why` / `preview` / `used` / `purge` / `unarchive` / `help`, snapshot caching, dump rotation |
| **v0.10.2** | 2026-10-25 | Rewrote the intro line; tested desktop version is now 0.2.1-rc.3. No functional change |
| **v0.10.1** | 2026-10-25 | Rewrote the plugin card copy: localized title and one-line summary in `locale` `meta`, and a `description` without the version prefix or feature dump; no functional changes |
| **v0.10.0** | 2026-10-05 | **Rebuilt as a memory layer**: trigger-driven recall (`trigger`/`realm`/`mtype`/`mkey` columns), type-priority ordering, five cleanup rules with tombstones and `compact.log`, workflow promotion and chains, injection budget (<=8 items / <=1200 chars), `compact`/`dump`; **removed** dream/reflect/conflict-adjudication/audit and the automatic Markdown mirror |
| v0.9.2 | 2026-09-29 | Removed dead modules and config keys; docs aligned with implementation |
| v0.9.1 | 2026-09-29 | Removed the management UI; plugin became host-only |
| v0.9.0 | 2026-09-29 | Removed embeddings and semantic/hybrid retrieval |
| v0.8.2 | 2026-09-20 | Compliance batch: audit fixes, typed config persistence, near-duplicate dedupe |
| v0.8.0 | 2026-09-16 | Write dedupe (bigram similarity) with merge/skip strategies |
| v0.7.0 | 2026-09-17 | Mirror-sync hook (removed in v0.10.0) |
| v0.6.4 | 2026-09-06 | Single source of truth: SQLite; Markdown became read-only backup |
| v0.6.0 | 2026-08-19 | Architecture split (shared/store/retrieve/snapshot/gate) + session sediment |
| v0.5.0 | 2026-08-15 | Data layer moved to SQLite (`node:sqlite`) |

## License

MIT — see [LICENSE](LICENSE).
