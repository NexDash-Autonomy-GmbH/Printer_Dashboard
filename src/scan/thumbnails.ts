import { getDocument, GlobalWorkerOptions } from "pdfjs-dist"
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url"

/**
 * Page thumbnails for the scan review, drawn by pdf.js.
 *
 * StagedPrint gets away with the browser's own PDF viewer, but that shows a
 * document, not pages: there is no way to put a rotate button under page 3
 * of it. So this module does bundle a renderer. It is only ever loaded with
 * import() when a review opens, which keeps pdf.js (~450 KB, plus its 1.2 MB
 * worker) out of the dashboard's first load.
 */

GlobalWorkerOptions.workerSrc = workerUrl

export type Thumbnails = {
  count: number
  /**
   * One page as a JPEG, drawn as the scan has it now (any /Rotate it already
   * carries included), its longest side `px` pixels.
   */
  render: (index: number, px: number) => Promise<Blob>
  destroy: () => void
}

export async function openThumbnails(pdf: ArrayBuffer): Promise<Thumbnails> {
  const task = getDocument({ data: new Uint8Array(pdf) })
  const doc = await task.promise
  return {
    count: doc.numPages,
    async render(index, px) {
      const page = await doc.getPage(index + 1)
      const natural = page.getViewport({ scale: 1 })
      const viewport = page.getViewport({ scale: px / Math.max(natural.width, natural.height) })
      const canvas = document.createElement("canvas")
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      try {
        await page.render({ canvas, viewport }).promise
        // A JPEG blob rather than the canvas itself. A 200-page feeder scan
        // is 200 thumbnails, and 200 live canvases at retina size would be
        // hundreds of MB of pixels held for as long as the dialog is open.
        return await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("could not draw the page"))),
            "image/jpeg",
            0.85
          )
        )
      } finally {
        page.cleanup()
        canvas.width = 0
        canvas.height = 0
      }
    },
    destroy() {
      void task.destroy()
    },
  }
}
