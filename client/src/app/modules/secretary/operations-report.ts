/**
 * The operations report page itself is built by the server (GET /api/print/operations-report)
 * and printed by the print PC. Here we only count its A4 pages so the secretary knows how much
 * paper to load before it prints.
 */

const MM_TO_PX = 96 / 25.4;

/**
 * Lays the page out off-screen at the printable A4 width and counts pages the way the printer
 * breaks them: rows never split, so a row that would cross the page edge starts the next page.
 */
export async function countA4Pages(html: string, marginMm = 12): Promise<number> {
  const frame = document.createElement('iframe');
  const widthMm = 210 - 2 * marginMm;
  const pageHeightPx = (297 - 2 * marginMm) * MM_TO_PX;
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${widthMm}mm;height:${297 - 2 * marginMm}mm;border:0;visibility:hidden`;
  document.body.appendChild(frame);
  try {
    const doc = frame.contentDocument;
    if (!doc) return 1;
    doc.open();
    doc.write(html);
    doc.close();
    try {
      await (doc as Document & { fonts?: FontFaceSet }).fonts?.ready;
    } catch {
      /* fonts are optional */
    }
    await new Promise((r) => setTimeout(r, 50));

    // Walk the blocks top to bottom: when one would cross the page edge, it moves to the next page.
    const blocks = Array.from(doc.body.querySelectorAll('h1, .meta, h2, tr')) as HTMLElement[];
    let pages = 1;
    let pageTop = 0;
    for (const el of blocks) {
      const rect = el.getBoundingClientRect();
      const top = rect.top + (doc.defaultView?.scrollY || 0);
      const bottom = top + rect.height;
      if (bottom - pageTop > pageHeightPx) {
        pages += 1;
        pageTop = top;
      }
    }
    return pages;
  } finally {
    frame.remove();
  }
}
