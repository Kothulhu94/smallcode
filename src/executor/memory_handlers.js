async function handleMemoryLoad(args, memoryStore, ctx) {
  const task = args.task || '';
  const maxTokens = args.max_tokens || 2000;
  const raw = memoryStore.loadForTask(task, maxTokens, { taskType: ctx.currentTaskType, runId: ctx._ledgerRunId });
  const objects = Array.isArray(raw) ? raw : (raw?.objects || []);
  const tokens_used = Array.isArray(raw) ? objects.length * 50 : (raw?.tokens_used || 0);
  if (objects.length === 0) return { result: 'No relevant memory found.' };
  const formatted = objects.map(o => `[${o.type}] ${o.title}: ${o.content}`).join('\n\n');
  return { result: `Loaded ${objects.length} memories (${tokens_used} tokens):\n\n${formatted}` };
}

async function handleMemoryRemember(args, memoryStore) {
  let obj;
  if (typeof memoryStore.remember === 'function' && memoryStore.remember.length >= 3) {
    obj = memoryStore.remember(args.type || 'context', args.title || '', args.content || '', { tags: args.tags || [] });
  } else {
    obj = memoryStore.remember({ type: args.type || 'context', title: args.title || '', content: args.content || '', tags: args.tags || [], symbols: args.symbols || [], files: args.files || [] });
  }
  if (obj.duplicate) return { result: `Already known (confirmed existing: ${obj.existing_id})` };
  if (obj.rejected) return { result: `Rejected: ${obj.reason}` };
  return { result: `Remembered [${obj.type}] "${obj.title}" (${obj.id})` };
}

async function handleMemoryList(args, memoryStore) {
  const objects = args.type ? memoryStore.byType(args.type) : memoryStore.all();
  if (objects.length === 0) return { result: 'No memory stored.' };
  return { result: objects.map(o => `[${o.id}] (${o.type}) ${o.title}`).join('\n') };
}

async function handleMemoryForget(args, memoryStore) {
  const ok = memoryStore.forget(args.id);
  return { result: ok ? `Deleted ${args.id}` : `Not found: ${args.id}` };
}

module.exports = {
  handleMemoryLoad,
  handleMemoryRemember,
  handleMemoryList,
  handleMemoryForget
};
