# Architecture

A short map of the code. ~2.4k lines across 11 modules, no runtime dependencies.

## Three invariants

1. **SQLite is the single source of truth.** Markdown is a read-only artifact (`dump`), never a
   runtime input. The only time Markdown is read is the one-shot historical import.
2. **Deletion leaves a tombstone.** `remove` flips `status`; only `purge` physically deletes, and
   it backs up first. Recovery is the default, destruction is explicit.
3. **Retrieval is deterministic.** No vectors, no embeddings, no model in the retrieval path.
   Same input → same output, always explainable.

## Modules

| File | Responsibility |
|---|---|
| `index.mjs` | Wiring only: tool/command/HTTP registration, session-signal collection, `apply()` |
| `shared.mjs` | Config + defaults, paths, fingerprints, token estimate, bigram similarity |
| `db.mjs` | SQLite schema, migrations, CRUD, backup/restore, chains, trigger counts, health |
| `store.mjs` | Write path (dedupe, same-key overwrite, workflow promotion), pin/remove/restore |
| `retrieve.mjs` | Deterministic keyword retrieval, scoring, "real usage" accounting |
| `trigger.mjs` | Trigger-string extraction (`file:`/`tool:`/`err:`), type inference, priority |
| `recall.mjs` | What to inject right now: trigger hits, preference channel, cold start, `why` |
| `snapshot.mjs` | Always-on snapshot rendering (cached) + session-settle prompt |
| `compact.mjs` | The five cleanup rules, `compact.log`, `dump` export |
| `gate.mjs` | Write approval gate (fail-closed) + startup self-heal |
| `session-state.mjs` | Per-session "pending settle" flag (kept separate to avoid cycles) |

## Data model

`entries` — one row per memory. Key columns:

| Group | Columns |
|---|---|
| Identity | `entry_id`, `fp` (full-text hash, unique) |
| Recall | `realm`, `mtype`, `trigger`, `mkey` |
| Content | `text`, `summary`, `entities`, `kind`, `memory_class`, `source_ref` |
| Lifecycle | `created_at`, `last_accessed`, `last_used`, `hits`, `weight`, `pinned` |
| Status | `status` (`active` / `archived` / `deleted`) |

Two helper tables: `chains` (workflow chains), `trigger_counts` (per `trigger`+`realm` counts).

### `last_accessed` vs `last_used`

These two must stay apart. `last_accessed` = "was injected/shown" (drives recall ordering);
`last_used` = "was actually used" (drives cleanup). Collapsing them means every prompt assembly
refreshes the cleanup clock, and nothing is ever cleaned up.

### Classification columns

A row carries `layer`, `fragment_type`, `kind`, `memory_class` and `mtype`. This is historical
accumulation, not design — `layer` is effectively always `longterm` today. Treat `mtype`
(workflow/error/decision/fact) and `memory_class` (user_decision/user_preference/fact/
model_suggestion/model_inference) as the meaningful ones.

## Injection pipeline (per prompt assembly)

```
renderSnapshot()            always-on, token-capped, cached
  + buildInjection()
      ├── decisionChannel()     preferences/decisions, independent small budget
      ├── recallBySignals()     trigger hits + chains, ≤8 items / ≤1200 chars
      └── coldStartFallback()   only when small store & zero hits
```

Signals come from `session/event`: the session cwd and the last 12 tool calls. If the host does
not deliver `session/event`, this whole path silently produces nothing — hence the one-shot
warning and `/memory preview` / `/memory stats` for self-checking.

## Host contracts worth verifying

- `ctx.on('session/event', ...)` and `rawEvent.type === 'tool/call'` — signal source.
- `ctx.get('approval')` — write gate (absent → fail closed by default).
- `ctx.systemPrompt.context({ text })` — the text callback receives **no session argument**, which
  is why recall uses the most recently active session's signal bucket.

## Testing

`npm test` (needs Node ≥ 22.19; `node:sqlite` requires no flag from 22.13 on). Tests run against
a temp dir via `DSH_MEMORY_ROOT` / `DSH_BIOMEMORY_DIR`. `tests/core.test.mjs` holds the
correctness regressions for the v0.11 fixes; the older suites cover the pre-0.11 surface.
