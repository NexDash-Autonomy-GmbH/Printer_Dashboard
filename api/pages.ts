import { degrees, PDFDocument } from "pdf-lib";

/**
 * Turning scanned pages the right way up, and nothing else.
 *
 * Only each page's /Rotate entry changes. The images inside are copied through
 * byte for byte, never decoded or re-encoded, so a turned page is exactly as
 * sharp and as large as it came off the glass. Redrawing the pages instead
 * would have meant re-compressing every one of them.
 *
 * This runs in the Worker, not the browser, so the page only ever sends a list
 * of angles. The alternative was the browser rewriting the PDF and uploading
 * it back: up to 20 MB again over office Wi-Fi, and the mail would carry
 * whatever the browser posted rather than the copy the scanner produced.
 */

/* A 20 MB scan cap at a few hundred KB a page is far below this. It only
   stops a hostile list from being walked. */
const MAX_PAGES = 1000;

/**
 * The review's rotation list: one clockwise angle per page, in page order, in
 * degrees. A shorter list leaves the pages after it alone. null means it is
 * malformed and nothing should be sent.
 */
export function parseTurns(value: unknown): number[] | null {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > MAX_PAGES) {
    return null;
  }
  const turns: number[] = [];
  for (const angle of value) {
    if (typeof angle !== "number" || !Number.isInteger(angle) || angle % 90 !== 0) {
      return null;
    }
    turns.push(normalise(angle));
  }
  return turns;
}

/** Nothing to turn, so the scan can go out exactly as it arrived. */
export function unchanged(turns: number[]): boolean {
  return turns.every((angle) => angle === 0);
}

/**
 * The same PDF with each page turned by its angle, added to whatever /Rotate
 * the page already carried. Throws on a PDF it cannot read, or on a list
 * longer than the document, since that means the list was made for some
 * other scan.
 */
export async function rotatePages(pdf: Uint8Array, turns: number[]): Promise<Uint8Array> {
  // updateMetadata off: the scanner's own Producer and dates stay, rather
  // than the file claiming pdf-lib made it.
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = doc.getPages();
  if (turns.length > pages.length) {
    throw new RangeError(`the scan has ${pages.length} pages, not ${turns.length}`);
  }
  turns.forEach((angle, index) => {
    if (angle === 0) {
      return;
    }
    const page = pages[index];
    page.setRotation(degrees(normalise(page.getRotation().angle + angle)));
  });
  // No object streams: the output keeps a plain cross-reference table like
  // the scanner writes, which every reader copes with, and there is no
  // deflate pass over objects that were never going to change.
  return doc.save({ useObjectStreams: false });
}

function normalise(angle: number): number {
  return ((angle % 360) + 360) % 360;
}
