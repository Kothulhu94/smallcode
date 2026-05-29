// SmallCode — Memory Write Policy
//
// Prevents low-value memory pollution by:
// 1. Restricting automatic evidence capture to specific allowed task types.
// 2. Rejecting empty/invalid title or content.
// 3. Rejecting duplicate content and superseding existing high-value or evidence memories by title.
// 4. Applying default TTLs (7 days for evidence, 30 days for manual context, 0/never for high-value).

'use strict';

const ALLOWED_AUTO_TASK_TYPES = new Set(['coding', 'editing', 'backend', 'debugging']);
const HIGH_VALUE_CATEGORIES = new Set(['decision', 'convention', 'gotcha', 'workflow']);
const VALID_CATEGORIES = new Set(['decision', 'convention', 'gotcha', 'workflow', 'context', 'source']);

/**
 * Validate and process a memory write request.
 * Returns { rejected: true, reason } or { duplicate: true, existing_id } or { allowed: true, ttlDays, supersededId }.
 *
 * @param {object} store - MemoryStore instance
 * @param {string} type - Memory category
 * @param {string} title - Memory title
 * @param {string} content - Memory content/text
 * @param {object} [opts={}]
 * @param {string[]} [opts.tags]
 * @param {number} [opts.ttlDays]
 * @param {boolean} [opts.isAutomatic]
 * @param {string} [opts.taskType]
 */
function validateAndProcessWrite(store, type, title, content, opts = {}) {
  const normalizedType = (type || 'context').toLowerCase().trim();
  const normalizedTitle = (title || '').trim();
  const normalizedContent = (content || '').trim();
  const tags = opts.tags || [];
  const isAutomatic = !!(opts.isAutomatic || tags.includes('evidence'));
  const taskType = opts.taskType || 'coding';

  // 1. Check if automatic write is allowed for the task type
  if (isAutomatic) {
    if (!ALLOWED_AUTO_TASK_TYPES.has(taskType)) {
      return {
        rejected: true,
        reason: `Automatic memory writes are not allowed for task type '${taskType}'.`
      };
    }
    if (normalizedType !== 'context') {
      return {
        rejected: true,
        reason: `Automatic memory writes must be of category 'context'.`
      };
    }
  }

  // 2. Minimum fields validation
  if (normalizedTitle.length < 1) {
    return {
      rejected: true,
      reason: 'Memory title cannot be empty.'
    };
  }
  if (normalizedContent.length < 1) {
    return {
      rejected: true,
      reason: 'Memory content cannot be empty.'
    };
  }

  // 3. Category validation
  if (!VALID_CATEGORIES.has(normalizedType)) {
    return {
      rejected: true,
      reason: `Invalid category '${normalizedType}'. Must be one of decision, convention, gotcha, workflow, context.`
    };
  }

  // 4. Duplicate/Supersede check
  const existingMemories = store.all ? store.all() : [];

  for (const existing of existingMemories) {
    // Exact text match -> duplicate
    if (existing.content && existing.content.trim().toLowerCase() === normalizedContent.toLowerCase()) {
      return {
        duplicate: true,
        existing_id: existing.id
      };
    }

    // Same category + same title match
    if (existing.type === normalizedType && existing.title.trim().toLowerCase() === normalizedTitle.toLowerCase()) {
      if (HIGH_VALUE_CATEGORIES.has(normalizedType)) {
        return {
          allowed: true,
          ttlDays: 0,
          supersededId: existing.id
        };
      } else if (isAutomatic) {
        return {
          allowed: true,
          ttlDays: 7,
          supersededId: existing.id
        };
      }
    }
  }

  // 5. Default TTL assignment
  let ttlDays = opts.ttlDays;
  if (ttlDays === undefined) {
    if (HIGH_VALUE_CATEGORIES.has(normalizedType)) {
      ttlDays = 0; // Permanent
    } else if (isAutomatic) {
      ttlDays = 7; // 7 days for auto-evidence
    } else {
      ttlDays = 30; // 30 days default for manual context
    }
  }

  return {
    allowed: true,
    ttlDays
  };
}

module.exports = { validateAndProcessWrite };
