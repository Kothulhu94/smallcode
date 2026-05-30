async function handleWebSearch(args) {
  if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
  const { webSearch } = require('../tools/builtin/web_browse');
  const results = await webSearch(args.query, 5);
  return { result: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n') || 'No results found.' };
}

async function handleWebFetch(args) {
  if (process.env.SMALLCODE_WEB_BROWSE !== 'true') return { error: 'Web browsing disabled. Set SMALLCODE_WEB_BROWSE=true.' };
  const { webFetch } = require('../tools/builtin/web_browse');
  const content = await webFetch(args.url, 5000);
  return { result: content || 'Failed to fetch URL.' };
}

module.exports = {
  handleWebSearch,
  handleWebFetch
};
