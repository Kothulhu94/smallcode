# Checkpoint: Slice 2B (Dual-Delete)

## Integrated
- Dual-delete support in legacy memory store (`bin/memory.js`).
- Caller-provided ID preservation when saving memory to the legacy store.

## Files Modified/Added
- `bin/memory.js` (patched to support custom ID and SQLite try/catch dual writes/deletes)
- `src/memory/memory_store.js` (stub implementations)
- `test/memory_sqlite_slice2a.test.js` (added)
- `test/memory_sqlite_slice2b.test.js` (added)
- `test/memory_store.test.js` (added)
- `docs/harness_research/checkpoint_memory_store_slice2b_dual_delete.md` (this file)

## Behavior Added
- `MemoryStore.saveMemory` accepts optional caller-provided id.
- Existing `saveMemory` without id still auto-generates.
- `forget(id)` deletes from both legacy JSON/Markdown and SQLite memory.
- SQLite delete failures are contained and don't break legacy `forget()`.

## Explicitly Not Changed
- `bin/smallcode.js`, `src/api/index.js`, `bin/commands.js` are untouched.
- `memory_load` and `loadForTask` remain on legacy.
- Runtime reads stay untouched.
- No dependencies added.
- No migration/status commands added yet.

## Test Result
- All memory store tests, dual-write/delete tests pass.
- `node --test test/*.test.js` runs cleanly.

## Rollback Note
- To undo, remove `src/memory/memory_store.js` and revert `bin/memory.js` via `git checkout master -- bin/memory.js`.

## Recommended Next Slice
- Slice 2C: Begin redirecting runtime reads to SQLite.
