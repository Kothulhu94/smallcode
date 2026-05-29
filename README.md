# Local Agent Harness

Local Agent Harness (LAH) is a local-first agent harness designed for running specialist AI agents over a local code/workspace environment. It is optimized to run on consumer hardware using small/local models (typically 8B–35B parameters) and KoboldCPP-style local inference setups. By decomposing tasks, strictly capping context budgets, and utilizing highly-scoped specialist agents with dedicated tool permissions, the harness extracts reliable, productive work from local models without overwhelming their limited reasoning capacity or context windows.

> [!NOTE]
> **Origin & History:** Local Agent Harness began as a derivative of the SmallCode terminal-native coding agent runtime. It has since evolved from a single-agent loop into a multi-agent, local-first orchestration harness featuring specialist routing, model preset mapping, SQLite-backed memory systems, safety permission enforcement, failure recovery escalation, and observability dashboard tracking.

---

## Project Goal

The north-star goal of the Local Agent Harness is to provide a robust, structured environment where:
* **Conductor-Led Routing:** A human-facing conductor routes incoming tasks to narrow, highly-specialized agents rather than letting a single model attempt all activities.
* **Highly Scoped Specialists:** Specialist agents are granted limited tools, limited memory access, and restricted context, preventing model confusion.
* **Context Budget Control:** The system avoids wasting tokens on irrelevant context by applying strict read/write policies and budget caps.
* **Ledger & Auditing:** The harness records every tool execution, authorization event, and memory loading event in an authoritative, structured run ledger/dashboard.
* **Controlled Delegation:** The long-term path is sequential, deterministic multi-agent delegation, deliberately avoiding uncontrolled autonomous swarm behavior.

---

## Key Capabilities (What It Does Today)

* **SQLite-First Memory Backend:** Authoritative memory store using SQLite (with FTS5 full-text search where supported) and an automatic JSON fallback for environments lacking native sqlite compilation.
* **Structured Memory Operations:** Supports memory recall, listing, deletion, categorizations (decision, convention, gotcha, workflow, context, source), and schema validations.
* **Memory Policies & Write Filters:** Prevents database pollution by enforcing strict read/write permission scopes per active agent.
* **Duplicate Rejection & TTL Defaults:** Short-circuits duplicate memories and automatically manages Time-To-Live (TTL) decays on cached events.
* **Compact Memory Formatting:** Formats memory injections into clean, token-efficient system prompts.
* **Agent Registry:** A central configuration system in [agent_registry.js](file:///d:/LocalAgentHarness/src/governor/agent_registry.js) defining agent identities, tool permissions, and context budgets.
* **Tool Permission Enforcement:** Intercepts and denies unauthorized tool calls (e.g., preventing read-only agents from executing shell commands or modifying files).
* **Task-to-Agent Routing:** Automatically maps task types (coding, design, debugging, etc.) to the appropriate specialist agent.
* **Active Specialist Execution:** Dynamically loads the specific system prompt, allowed tools, and model presets for the running specialist.
* **Model Preset Routing:** Routes agents to different model configurations (`fast`, `default`, `medium`, `strong`) mapping to specific backend model endpoints.
* **Run Ledger & Trace Store:** Automatically writes run steps, tool calls, authorizations, and memory events to a local SQLite run ledger.
* **Observability Dashboard:** A local web interface to visualize recent runs, step timelines, tool calls, and detailed token metrics.
* **Unified Launcher Script:** Simple batch script in [Launch_LAH.bat](file:///d:/LocalAgentHarness/Launch_LAH.bat) to bootstrap local servers, the dashboard, and the terminal agent in one step.
* **Vision & Screenshot Capture:** Capture system screenshots, store visual artifacts, and run vision analysis.
* **Vision Capability Fallback:** Implements honest unsupported-capability behaviors; if the local model endpoint lacks vision capability, the harness returns a clear unsupported warning instead of pretending to see the image.
* **Failure Recovery & Escalation Policy:** Detailed in [escalation_policy.js](file:///d:/LocalAgentHarness/src/governor/escalation_policy.js), the module automatically detects repetitions, repeated tool errors, permission denials, and test failures. It escalates to an orchestrator (`architect` or `conductor`) or triggers terminal human review instead of entering infinite loops.

---

## Specialist Agents

The harness divides work among eight specialized agents, each with a narrow set of allowed tools and memory filters:

* **`conductor`**: Responsible for task planning, orchestration, and routing delegation or querying the user.
* **`repo_navigator`**: Explores the codebase structure, lists files, and searches symbols or code graphs.
* **`code_editor`**: Writes new code files and applies search-and-replace patches.
* **`qa_tester`**: Runs test suites, executes validation scripts, and monitors command exit statuses.
* **`researcher`**: Queries external documentation, fetches URLs, and searches the web.
* **`memory_curator`**: Stores, lists, and purges memories in the SQLite/JSON system.
* **`architect`**: Reviews high-level design constraints and coordinates plan-level escalations.
* **`visual_observer`**: Captures and inspects UI state screenshots, visual layout changes, and image assets.

---

## How to Launch

The harness can be launched fully locally via a unified launcher script.

### Using the Launcher
Run the launcher script from the project root:
```batch
Launch_LAH.bat
```
This batch script automatically starts the following components:
1. **KoboldCPP Server** (in a separate background command window to host the local model).
2. **Observability Dashboard Server** (on port `3000` via [dashboard_server.js](file:///d:/LocalAgentHarness/src/governor/dashboard_server.js)).
3. **Dashboard Web App** (attempts to open `http://localhost:3000` in Edge/Chrome in app mode, falling back to your default browser).
4. **Foreground TUI** (launches the interactive terminal agent loop in your active terminal).

### Manual Dashboard Launch
If you want to run the dashboard server independently:
```bash
d:\PortableNode\node.exe src\governor\dashboard_server.js 3000
```
Once started, navigate to:
**Dashboard URL:** [http://localhost:3000](http://localhost:3000)

---

## Observability Dashboard

The dashboard provides a real-time, visual trace of the agent harness's actions. It displays:
* **Recent Runs:** A historical list of tasks executed by the harness.
* **Run Timeline:** A step-by-step sequential timeline of active agents and their turns.
* **Tool Calls:** The exact tools invoked, arguments passed, and execution outcomes.
* **Authorization Events:** A record of tool authorizations, warnings, and strict-mode denials.
* **Memory Context Events:** Details of which memory items were queried, loaded, or written.
* **Model/Agent Metadata:** Information about the active agent, selected model preset, and target endpoint.
* **Token/Timing Data:** Metrics tracking execution durations and token usage per turn.

---

## Memory System

The memory system governs how agents store and recall information without cluttering the context window:
* **Authoritative Storage:** SQLite is the primary backend, utilizing SQLite FTS5 for fast indexing and text searches.
* **Human-Readable Fallback:** Standard JSON and markdown sidecars are maintained as fallbacks for environments without compiled SQLite binaries, and to allow direct human inspection of memories.
* **Task/Agent Filtering:** Memory retrieval is policy-filtered. Agents only receive memory categories they have permission to read (e.g., `qa_tester` only loads `workflow` and `gotcha` memories).
* **Controlled Writing:** Agents are restricted to write to specific memory categories (e.g., `code_editor` can only write to `gotcha` memories), preventing noise and database pollution.

---

## Project Workspaces

The harness provides a structured project workspace system under `.smallcode/workspaces/<projectId>/` to organize project-specific metadata, tasks, plans, and execution history.
* **Workspace Directory Structure:** Each project workspace is initialized with:
  * `project.json` / `project.md`: Project identity, status, active goal, and metadata.
  * `goals.md` / `constraints.md`: Structured goals and constraints files.
  * `tasks/` / `plans/`: Folder categories for staging task checklists and implementation plans.
  * `handoffs/` / `runs/`: Compact serialized specialist handoffs and run execution references.
  * `artifacts/` / `screenshots/` / `scratch/` / `checkpoints/`: Text artifacts, screenshot pointers, and temporary scratch notes.
* **Active Workspace Context:** The active workspace ID is globally tracked in `.smallcode/workspaces/active.txt`. When active, the project name and active goal are compactly injected into system prompts.
* **Auto-Linking:** Started runs, specialist handoffs, and captured screenshots are automatically linked under the active workspace's subfolders without duplicate files.

---

## Vision & Screenshot Support

The harness supports capturing and inspecting visual elements:
* **Screenshot Capture:** The `vision_screenshot` tool takes a system screenshot and stores it in the run's visual artifact directory.
* **Screenshot Indexing:** The `vision_list` tool lists all available screenshot artifacts for the current session.
* **Visual Queries:** The `vision_ask` and `vision_describe` tools query the model to describe or inspect an image.
* **Honest Fallbacks:** Because local models running on KoboldCPP vary in vision capability, the harness explicitly checks for vision endpoint support. If unsupported, it returns a direct fallback response explaining that vision capability is unavailable rather than hallucinating visual contents.

---

## Safety & Control Philosophy

Local Agent Harness adheres to a strict containment philosophy:
* **Scoped Permissions:** Tool execution is permission-gated. A specialist agent cannot run tools outside its whitelisted set.
* **Containment Policies:** Shell execution (`bash`) and file modification (`write_file`, `patch`) can be completely disabled or restricted per agent.
* **Immutable Logs:** All execution actions, authorization outcomes, and system events are written to the database run ledger, creating an auditable trace.
* **Escalation vs. Loops:** If an agent encounters repeated errors, failures are caught by the escalation policy module. Instead of looping autonomously, the system shifts control to the `architect` or `conductor`, or halts for human intervention.
* **No Swarm Autonomy:** Multi-agent actions are orchestrated sequentially, ensuring the human remains in control and the system does not trigger recursive, runaway autonomous behaviors.

---

## Current Limitations

* **No Parallel Multi-Agent Spawning:** The system currently runs agents sequentially; parallel execution of specialists is not supported.
* **No Sequential Delegation Queue Yet:** Multi-agent actions are staged via manual escalation rather than a dedicated staging queue.
* **Vision Endpoint Dependence:** Visual tools (`vision_ask`, `vision_describe`) require a vision-capable model hosted on the backend endpoint.
* **Screenshot OS Dependencies:** Screenshot capture relies on the local environment having `PortablePython` and the `Pillow` library installed.
* **Hardware & Model Sensitivity:** Performance and quality are heavily dependent on the chosen local model size, quantization format, and available GPU/CPU hardware.

---

## Roadmap

* **Sequential Delegation Queue:** A formal queue for staging multi-agent delegation steps.
* **Better Dashboard Image Previews:** Integrated image rendering for visual artifacts in the dashboard run viewer.
* **Model Capability Probing:** Active startup probing of endpoints to detect thinking, tool-calling, and vision support.
* **Semantic Duplicate Detection:** Vector-based or LLM-assisted duplicate detection for the SQLite memory database.
* **Low-RAM Model Presets:** Pre-configured settings optimized for highly quantized models running on low-resource machines.

---

## Development & Testing

Unit tests are written using Node's native test runner. To execute the entire test suite, run the following command from the project root:

```bash
d:\PortableNode\node.exe -e "const { spawnSync } = require('child_process'); const fs = require('fs'); const files = fs.readdirSync('test').filter(f => f.endsWith('.test.js')).map(f => 'test/' + f); const res = spawnSync('d:\\PortableNode\\node.exe', ['--test', ...files], { stdio: 'inherit' }); process.exit(res.status);"
```
