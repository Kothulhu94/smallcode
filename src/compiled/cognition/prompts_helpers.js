// SmallCode — Prompt Parsing and Template Loading Helpers
// Extracted from prompts.js to keep file lengths under 500 lines.

'use strict';

// Extension-point templates — bodies live in src/extensions.ts and are
// preserved across recompilation. We refer to them by name to keep the
// compiled file decoupled from prompt wording.
function loadExtension(name) {
    // Late-bind so module load order doesn't matter.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ext = require("../extensions");
    const fn = ext[name];
    if (typeof fn !== "function") {
        throw new Error(`Extension point not implemented: ${name}. ` +
            `Open src/extensions.ts and fill in the body between the sentinel comments.`);
    }
    return fn;
}

function parseModelOutput(raw, expected) {
    if (expected === "string") {
        // For string outputs (typically code or markdown), strip surrounding
        // markdown fences if present so the consumer gets just the inner
        // content. Most models wrap their output in ```typescript ... ``` or
        // ```ts or just ``` — we handle all three. If multiple fences are
        // present, we pick the largest typescript-tagged one (or the largest
        // untagged fallback). If no fence at all, return raw unchanged.
        return extractLargestFencedBlock(raw);
    }
    if (expected === "unknown") {
        try {
            return JSON.parse(raw);
        }
        catch {
            return raw;
        }
    }
    if (expected === "file" || expected === "files") {
        // Multi-file output. The model should return JSON: a single
        // { path, content, kind? } record for `file`, or an array for
        // `files`. We strip a code fence first since models often wrap
        // structured output in ```json ... ```. If parsing fails entirely,
        // fall back to a single-file synthesis where the whole raw output
        // is the content and `path` is empty — the validator will reject
        // this and trigger repair, so we surface the issue without crashing.
        const cleaned = raw.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        }
        catch {
            return expected === "files" ? [{ path: "", content: raw }] : { path: "", content: raw };
        }
        if (expected === "files") {
            // Accept a bare array, OR an object with a top-level `files` field
            // (a common model framing — "here are the files: { files: [...] }").
            if (Array.isArray(parsed))
                return parsed;
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.files)) {
                return parsed.files;
            }
            // Last resort: single-record-into-list promotion.
            if (parsed && typeof parsed === "object" && "path" in parsed)
                return [parsed];
            return [{ path: "", content: String(parsed) }];
        }
        // expected === "file"
        if (Array.isArray(parsed) && parsed.length > 0)
            return parsed[0];
        return parsed;
    }
    // expected === json
    // Strip a markdown code fence if the model wrapped its JSON in ```json ... ```.
    const cleaned = raw.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
    return JSON.parse(cleaned);
}

function extractLargestFencedBlock(raw) {
    const fenceRe = /```([a-zA-Z]*)\s*\n([\s\S]*?)\n```/g;
    const tsFences = [];
    const untaggedFences = [];
    let m;
    while ((m = fenceRe.exec(raw)) !== null) {
        const lang = (m[1] || "").toLowerCase();
        const body = m[2];
        if (lang === "typescript" || lang === "ts" || lang === "tsx" || lang === "javascript" || lang === "js") {
            tsFences.push(body);
        }
        else if (lang === "") {
            untaggedFences.push(body);
        }
        else {
            // Other languages (markdown, python, etc.) — keep them in untagged
            // pool as a fallback so the validator at least sees something.
            untaggedFences.push(body);
        }
    }
    const pool = tsFences.length > 0 ? tsFences : untaggedFences;
    if (pool.length === 0)
        return raw;
    let best = pool[0];
    for (let i = 1; i < pool.length; i++) {
        if (pool[i].length > best.length)
            best = pool[i];
    }
    return best;
}

module.exports = {
  loadExtension,
  parseModelOutput,
  extractLargestFencedBlock
};
