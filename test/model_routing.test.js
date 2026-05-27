'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getModelTarget } = require('../bin/config');
const { routeTier } = require('../src/model/router');
const { AdaptiveModelRouter } = require('../src/model/adaptive_router');

test('complexity routing selects model and base URL for strong tier', () => {
  const config = {
    model: { name: 'local-default', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    models: {
      default: { name: 'local-default', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
      strong: { name: 'openrouter/large', baseUrl: 'https://openrouter.ai/api/v1', provider: 'openai' },
    },
  };

  const tier = routeTier('refactor this architecture across multiple files');
  const target = getModelTarget(config, tier);
  assert.equal(tier, 'strong');
  assert.equal(target.model, 'openrouter/large');
  assert.equal(target.baseUrl, 'https://openrouter.ai/api/v1');
});

test('adaptive routing selects medium and strong tier URLs', () => {
  const config = {
    model: { name: 'local-default', baseUrl: 'http://localhost:11434/v1', provider: 'openai' },
    models: {
      medium: { name: 'openrouter/medium', baseUrl: 'https://openrouter.ai/api/v1', provider: 'openai' },
      strong: { name: 'openrouter/large', baseUrl: 'https://openrouter.ai/api/v1', provider: 'openai' },
    },
  };

  const mediumRouter = new AdaptiveModelRouter();
  mediumRouter.recordCall('local-default', false);
  mediumRouter.recordCall('local-default', true);
  mediumRouter.recordCall('local-default', true);
  assert.deepEqual(mediumRouter.selectModel(config), {
    model: 'openrouter/medium',
    url: 'https://openrouter.ai/api/v1',
    tier: 'medium',
  });

  const strongRouter = new AdaptiveModelRouter();
  strongRouter.recordCall('local-default', false);
  strongRouter.recordCall('local-default', false);
  strongRouter.recordCall('local-default', false);
  assert.deepEqual(strongRouter.selectModel(config), {
    model: 'openrouter/large',
    url: 'https://openrouter.ai/api/v1',
    tier: 'strong',
  });
});
