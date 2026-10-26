/** Local equivalents of PHP's separate own-pipeline and agent-search pages.
 * These select a UI filter only; authenticated API scope remains authoritative.
 * Repeated or unknown query values cannot select an unexpected route state.
 */
export function pipelineEntry(parameters: { scope?: string | string[]; view?: string | string[] }) {
  return { own: parameters.scope === "own", agents: parameters.view === "agents" };
}
