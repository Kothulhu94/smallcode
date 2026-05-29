// SmallCode — Memory Context Policy
//
// Governs token budgets and category filtering based on the current task classification
// (or agent role) to prevent token waste and reduce prompt noise.

'use strict';

const POLICY = {
  backend: {
    maxTokensLimit: 1000,
    categories: ['decision', 'convention', 'gotcha', 'workflow', 'context']
  },
  coding: {
    maxTokensLimit: 800,
    categories: ['decision', 'convention', 'gotcha', 'workflow', 'context']
  },
  editing: {
    maxTokensLimit: 800,
    categories: ['decision', 'convention', 'gotcha', 'workflow', 'context']
  },
  debugging: {
    maxTokensLimit: 1000,
    categories: ['gotcha', 'decision', 'workflow', 'context']
  },
  shell: {
    maxTokensLimit: 600,
    categories: ['workflow', 'gotcha']
  },
  explanation: {
    maxTokensLimit: 500,
    categories: ['context', 'decision', 'convention']
  },
  search: {
    maxTokensLimit: 500,
    categories: ['context', 'decision']
  }
};

const DEFAULT_POLICY = {
  maxTokensLimit: 800,
  categories: ['decision', 'convention', 'gotcha', 'workflow', 'context']
};

/**
 * Get raw policy configuration for a task type.
 * @param {string} taskType
 * @returns {object}
 */
function getPolicy(taskType) {
  return POLICY[taskType] || DEFAULT_POLICY;
}

/**
 * Resolve context window budgets and category lists.
 * @param {string} taskType - Classification of the current task
 * @param {number} baseMaxTokens - Base token budget
 * @returns {object} { maxTokens, categories }
 */
function applyPolicy(taskType, baseMaxTokens) {
  const policy = getPolicy(taskType);
  const maxTokens = typeof baseMaxTokens === 'number'
    ? Math.min(baseMaxTokens, policy.maxTokensLimit)
    : policy.maxTokensLimit;
  return {
    maxTokens,
    categories: policy.categories
  };
}

module.exports = { getPolicy, applyPolicy };
