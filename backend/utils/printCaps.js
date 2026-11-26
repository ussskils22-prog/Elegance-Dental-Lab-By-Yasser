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

/** @param {string[]|null} caps  null = old agent that never declared caps */
function canTakeKind(caps, kind) {
  const isReceipt = String(kind || '') === 'receipt';
  if (caps === null || caps === undefined) return !isReceipt;
  return caps.includes(isReceipt ? 'receipt' : 'sheet');
}

/** Mongo filter on PrintJob for jobs this agent may take. */
function jobKindFilterForCaps(caps) {
  if (caps === null || caps === undefined) return { 'printData.jobKind': { $ne: 'receipt' } };
  const sheet = caps.includes('sheet');
  const receipt = caps.includes('receipt');
  if (sheet && receipt) return {};
  if (sheet) return { 'printData.jobKind': { $ne: 'receipt' } };
  if (receipt) return { 'printData.jobKind': 'receipt' };
  return { _id: { $exists: false } }; // no printer connected → nothing
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
