/**
 * Which print jobs may an agent (a lab PC running the print program) take?
 *
 * Agents declare caps: "sheet" when the sheet printer is really connected to that PC,
 * "receipt" when the receipt printer is. A PC whose printer is unplugged sends neither
 * (e.g. "none"), so it must not grab a sheet and send it into a dead Windows queue while the
 * real print PC waits.
 *
 * Old agents (before caps) send nothing at all → they keep the old rule: sheets only.
 */

function parseCaps(raw) {
  return String(raw || '')
    .toLowerCase()
    .split(/[,\s]+/)
    .filter(Boolean);
}

/**
 * Job kinds an agent may print. "report" (A4 operations report) needs the sheet printer AND an
 * agent new enough to know reports (it declares "report"); older agents would print it as a case sheet.
 * @param {string[]|null} caps  null = old agent that never declared caps
 */
function allowedKinds(caps) {
  if (caps === null || caps === undefined) return ['sheet'];
  const out = [];
  if (caps.includes('sheet')) out.push('sheet');
  if (caps.includes('receipt')) out.push('receipt');
  if (caps.includes('sheet') && caps.includes('report')) out.push('report');
  return out;
}

function canTakeKind(caps, kind) {
  const k = String(kind || 'sheet');
  return allowedKinds(caps).includes(k === 'receipt' || k === 'report' ? k : 'sheet');
}

/** Mongo filter on PrintJob for jobs this agent may take. */
function jobKindFilterForCaps(caps) {
  const allowed = allowedKinds(caps);
  if (!allowed.length) return { _id: { $exists: false } }; // no printer connected → nothing
  if (!allowed.includes('sheet')) return { 'printData.jobKind': { $in: allowed } };
  // "sheet" also covers old jobs saved without a kind
  const blocked = ['receipt', 'report'].filter((k) => !allowed.includes(k));
  return blocked.length ? { 'printData.jobKind': { $nin: blocked } } : {};
}

/**
 * Old agents can't tell whether their printer is connected — that is how a laptop without the
 * printer kept stealing sheets. While a new agent with a connected sheet printer is online,
 * old agents get nothing. With no new agent online they keep working (fail-open).
 * @param {string[]|null} caps
 * @param {boolean} modernSheetAgentOnline
 */
function effectiveCaps(caps, modernSheetAgentOnline) {
  if ((caps === null || caps === undefined) && modernSheetAgentOnline) return [];
  return caps === undefined ? null : caps;
}

module.exports = { parseCaps, canTakeKind, jobKindFilterForCaps, effectiveCaps };
