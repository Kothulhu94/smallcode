'use strict';

const { handlePlugin, handleSkill } = require('./commands_handlers/plugin_skill_commands');
const { handleSession, handleSessions } = require('./commands_handlers/session_commands');
const { handleTrace, handleContract } = require('./commands_handlers/trace_contract_commands');
const { handleModel, handleUndo, handleMemory, handleMcp, handleFiles } = require('./commands_handlers/misc_commands');

module.exports = {
  handleModel,
  handleTrace,
  handlePlugin,
  handleUndo,
  handleMemory,
  handleSkill,
  handleSession,
  handleSessions,
  handleMcp,
  handleContract,
  handleFiles
};
