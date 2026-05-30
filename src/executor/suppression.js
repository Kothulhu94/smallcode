const _successfulRunCalls = new Map(); // runId -> Set of hashes
let _fallbackTurnCalls = new Set();

function resetTurnFallback() {
  _fallbackTurnCalls.clear();
}

function checkDuplicateToolCall(ctx, name, args) {
  const callHash = `${name}::${JSON.stringify(args || {})}`;
  let callSet = null;
  if (ctx && ctx._ledgerRunId) {
    callSet = _successfulRunCalls.get(ctx._ledgerRunId);
    if (!callSet) {
      callSet = new Set();
      _successfulRunCalls.set(ctx._ledgerRunId, callSet);
    }
  } else {
    callSet = _fallbackTurnCalls;
  }

  if (callSet.has(callHash)) {
    return { error: `Duplicate tool call suppressed: You have already successfully executed ${name} with these exact arguments in this run. Do not repeat successful actions.` };
  }
  return { ok: true, callHash, callSet };
}

function recordSuccessfulToolCall(callSet, callHash) {
  if (callSet) {
    callSet.add(callHash);
  }
}

module.exports = {
  resetTurnFallback,
  checkDuplicateToolCall,
  recordSuccessfulToolCall,
  _successfulRunCalls,
  _fallbackTurnCalls
};
