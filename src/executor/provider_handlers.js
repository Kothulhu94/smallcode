async function handleConfigureProvider(args) {
  const { runWizard } = require('../../bin/provider-wizard/wizard');
  const hasAnyParam = args.provider || args.baseUrl || args.model || args.apiKey;
  let result;
  if (!hasAnyParam) {
    result = await runWizard({ interactive: true });
  } else {
    result = await runWizard({
      interactive: false,
      provider: args.provider,
      baseUrl: args.baseUrl,
      model: args.model,
      apiKey: args.apiKey,
      escalationProvider: args.escalationProvider,
      escalationModel: args.escalationModel,
    });
  }
  if (result.success) {
    return { result: `Provider configured: ${result.provider} (${result.baseUrl}) model=${result.model}${result.escalation ? ` escalation=${result.escalation}` : ''}. Restart SmallCode to apply.` };
  }
  return { error: result.error };
}

async function handleProviderStatus() {
  const { getStatus, formatStatus } = require('../../bin/provider-wizard/status');
  return { result: formatStatus(getStatus()) };
}

module.exports = {
  handleConfigureProvider,
  handleProviderStatus
};
