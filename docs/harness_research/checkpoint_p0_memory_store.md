# Checkpoint: Tiered Memory Store (P0-1)

This checkpoint document records the successful implementation and verification of the Tiered Memory Store module.

## 1. What Was Implemented

### P0-1: Tiered Memory Store
- **Mechanism**: A persistent, structured memory manager backing up memories in a local SQLite database (`.smallcode/memory/memory.db`).
- **Features**:
  - Categorizes memories into `decision`, `convention`, `gotcha`, `workflow`, and `context`.
  - Integrates an FTS5 virtual table for indexing memory text and keyword metadata.
  - Implements stopword-filtered tokenization and custom keyword overlap, recency decay, and frequency use ranking.
  - Automatic TTL-based decay (`expireOld`), delete operations (`deleteMemory`), and safe empty query recall (`recall("")`).
  - Graceful fallback to custom-scored SQL `LIKE` queries if FTS5 is not compiled in the native SQLite binary.

---

## 2. Files Added

- **Source File**: [src/memory/memory_store.js](file:///d:/LocalAgentHarness/src/memory/memory_store.js) (292 lines)
- **Unit Test File**: [test/memory_store.test.js](file:///d:/LocalAgentHarness/test/memory_store.test.js) (221 lines)

---

## 3. Exported API Summary

```javascript
const { MemoryStore, CATEGORIES } = require('./src/memory/memory_store');

// CATEGORIES: DECISION, CONVENTION, GOTCHA, WORKFLOW, CONTEXT
```

---

## 4. Test Verification Result

All unit tests pass successfully. The repository-wide test suite runs clean:
- **Command**: `d:\PortableNode\node.exe --test (Get-ChildItem test/*.test.js | Select-Object -ExpandProperty FullName)`
- **Result**: **187/187 tests passed** (including 16 event journal, 17 sentinel loop, 10 verification loop, 10 approval policy, and 10 memory store tests).

---

## 5. FTS5 / Fallback Behavior Summary

1. **FTS5 Creation & Query**: Enabled by default and verified operational in tests.
2. **LIKE Query Fallback**: Traps any table creation or query MATCH execution failures with a try-catch, degrading safely to SQL `LIKE` search.
3. **Identical Scoring**: Fallback mode is validated by a dedicated test case that forces `useFts = false`, proving FTS5 and LIKE queries resolve to identical relevance and recency rankings.

---

## 6. Runtime Isolation Confirmation

The memory store module is strictly isolated. No other runtime files (e.g. `src/api/index.js`, `bin/smallcode.js`, or `bin/memory.js`) import or consume the new files. Existing execution paths and behaviors remain completely unchanged.

---

## 7. Recommended Next Step

- **Next Action**: **Integration Planning for all P0 modules**
- **Details**: Now that all 5 critical P0 modules are complete and individually tested (Memory Store, Event Journal, Sentinel Loop, Verification Loop, and Approval Policy System), the next step is to formulate a unified integration plan to wire them into the active runtime loops (`src/api/index.js` and `bin/smallcode.js`) and tool execution suites. No further isolated modules should be created until the integration of these P0 modules is planned and approved.
