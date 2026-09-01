import { Upload } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useId, useRef, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Drag-and-drop or browse for PDFs. The interaction model follows the beUI
 * attachment dropzone — a depth counter so leaving a child element does not
 * end the drag, copy as the drop effect, a lifted icon while dragging — cut
 * down to the one file type the printer can actually take, and painted with
 * this app's tokens rather than the kit's neutrals.
 */
export function PdfDropzone({
  onFiles,
  disabled = false,
  maxBytes,
}: {
  onFiles: (files: File[]) => void
  disabled?: boolean
  maxBytes: number
}) {
  const id = useId()
  const input = useRef<HTMLInputElement>(null)
  const depth = useRef(0)
  const reduce = useReducedMotion() ?? false
  const [dragging, setDragging] = useState(false)

  const accept = (list: FileList | null) => {
    depth.current = 0
    setDragging(false)
    if (!list || disabled) return
    onFiles(Array.from(list))
  }

  return (
    <>
      <input
        ref={input}
        id={id}
        type="file"
        accept="application/pdf,.pdf"
        multiple
        disabled={disabled}
        tabIndex={-1}
        className="sr-only"
        aria-label="Choose PDFs to print"
        onChange={(event) => {
          accept(event.currentTarget.files)
          event.currentTarget.value = ""
        }}
      />
      <motion.button
        type="button"
        disabled={disabled}
        data-dragging={dragging || undefined}
        animate={reduce ? undefined : { scale: dragging ? 1.006 : 1 }}
        whileTap={reduce ? undefined : { scale: 0.995 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
        onClick={() => input.current?.click()}
        onDragEnter={(event) => {
          if (disabled) return
          event.preventDefault()
          depth.current += 1
          setDragging(true)
        }}
        onDragOver={(event) => {
          if (disabled) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
        }}
        onDragLeave={(event) => {
          if (disabled) return
          event.preventDefault()
          depth.current = Math.max(0, depth.current - 1)
          if (depth.current === 0) setDragging(false)
        }}
        onDrop={(event) => {
          if (disabled) return
          event.preventDefault()
          accept(event.dataTransfer.files)
        }}
        className={cn(
          "group bg-muted/60 relative isolate flex min-h-48 w-full flex-col items-center justify-center overflow-hidden rounded-2xl p-2 text-center outline-none",
          "hover:bg-muted/80 focus-visible:ring-ring/50 focus-visible:ring-3",
          "data-[dragging]:bg-muted",
          "disabled:pointer-events-none disabled:opacity-55",
        )}
      >
        <span
          aria-hidden
          className="border-border bg-background group-hover:border-muted-foreground/50 group-data-[dragging]:border-primary group-data-[dragging]:bg-primary/5 absolute inset-2 -z-10 rounded-xl border border-dashed"
        />
        <motion.span
          aria-hidden
          animate={reduce ? undefined : { y: dragging ? -4 : 0, scale: dragging ? 1.08 : 1 }}
          transition={{ duration: 0.2 }}
          className="bg-muted text-foreground group-data-[dragging]:bg-primary group-data-[dragging]:text-primary-foreground mb-3 grid size-11 place-items-center rounded-2xl"
        >
          <Upload className="size-[18px]" />
        </motion.span>
        <span className="text-foreground text-sm font-semibold tracking-tight">
          Drop PDFs here, or click to browse
        </span>
        <span className="text-muted-foreground mt-1 text-xs leading-5">
          Up to {Math.round(maxBytes / 1024 / 1024)} MB each. For anything else, press{" "}
          <kbd className="bg-muted rounded px-1 font-sans text-[11px]">⌘P</kbd> and choose{" "}
          <span className="text-foreground">Save as PDF</span> first.
        </span>
      </motion.button>
    </>
  )
}
