# Workspace Environment & Development Guide (GEMINI.md)

Welcome to the local agentic model harness development workspace. This document serves as the guide for anyone (or any AI agent) operating within this codebase.

## 1. Project Purpose & Vision

The core purpose of this workspace is to **modify, expand, and build an AGI (Artificial General Intelligence) out of the Gemma 4 model**. 

We achieve this by building the perfect local agentic coding harness. The plan is to research and combine the best design patterns from various agent harnesses—starting with **SmallCode**—and providing the model with robust, self-improving tools to:
* **Remember**: Persistent state, memory graph indexing, context pruning/injection, session recovery, and compaction.
* **Learn**: Self-healing verification loops, test/check gates, error correction feedback loops, and failure classification.
* **Execute**: Multi-agent orchestration (via file-based tasks, state machines, worktree isolation), sandboxed code execution with local approval gates, and a lightweight observability UI (prompts, tool calls, token metrics, and task states).

---

## 2. Portable Runtime & Tool Locations

Because this is a restricted local environment, standard global paths may not exist. Always reference these exact absolute paths when running or invoking runtimes:

* **Node.js**: `%~d0\PortableNode\node.exe` (v20.11.1)
  * NPM Global Prefix: `%~d0\PortableApps\npm-global`
* **Python**: `%~d0\PortablePython\python.exe` (v3.14.2)
* **Git**: `%~d0\PortableGit\cmd\git.exe` (v2.43.0)

> [!TIP]
> Since this is a portable flash drive environment, the drive letter may change between workstations. In batch scripts, use the `%~d0` modifier to dynamically resolve the current drive letter (e.g. `%~d0\PortableNode` instead of `D:\PortableNode`).

---

## 3. Launch Scripts (.bat)

We have created three helper scripts to manage the local model server and the agent:

* **`run_kobold.bat`**
  * Launches the local Kobold.cpp model server on CPU (using AVX2 optimizations).
  * Loads the `google_gemma-4-E4B-it-Q4_K_M.gguf` model on port `5001`.
* **`run_smallcode_source.bat`**
  * Invokes the locally cloned version of SmallCode (`bin/smallcode.js`) using the portable Node binary.
  * Allows passing command line arguments (e.g. `--prompt "..."`).
* **`start_harness.bat`**
  * **Unified launcher**: Starts Kobold.cpp in a separate background cmd window, and immediately opens the SmallCode interactive agent loop in the current terminal.

---

## 4. Coding Standards & Guidelines

To maintain clean architecture and ensure smaller LLMs can reliably parse and navigate the codebase, all code modifications must adhere to the following rules:

### 1. File Naming
* New files must be named **based exactly on what is in them**. Use specific, descriptive nouns (e.g., `git_diff_parser.js` or `memory_store.ts`).
* **No "bootstrap" names**: Avoid generic names like `bootstrap.js`, `init.js`, `utils.js`, `helper.js`, or `setup.js`. Be specific.

### 2. File Length Limit
* **Maximum 500 lines**: No file may exceed 500 lines of code. If a component grows past this limit, it must be modularized and decomposed into smaller, dedicated files.

### 3. Portable Execution
* Any script running child processes or terminal commands must prepend `d:\PortableNode` to the environment `PATH` (or explicitly call the absolute path of Node/Python/Git) so that sub-processes can locate the runtimes.
