"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadExtension = loadExtension;
exports.parseModelOutput = parseModelOutput;
exports.extractLargestFencedBlock = extractLargestFencedBlock;
function loadExtension(name) {
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
        const cleaned = raw.replace(/^```[a-zA-Z]*\n?/, "").replace(/```\s*$/, "").trim();
        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        }
        catch {
            return expected === "files" ? [{ path: "", content: raw }] : { path: "", content: raw };
        }
        if (expected === "files") {
            if (Array.isArray(parsed))
                return parsed;
            if (parsed && typeof parsed === "object" && Array.isArray(parsed.files)) {
                return parsed.files;
            }
            if (parsed && typeof parsed === "object" && "path" in parsed)
                return [parsed];
            return [{ path: "", content: String(parsed) }];
        }
        if (Array.isArray(parsed) && parsed.length > 0)
            return parsed[0];
        return parsed;
    }
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
