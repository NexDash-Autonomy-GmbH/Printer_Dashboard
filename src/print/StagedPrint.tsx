import { PrinterIcon, XIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useMemo, useState } from "react"

import { formatBytes } from "@/lib/format"

/**
 * What was dropped, before it is sent. Nothing reaches the printer until Print
 * is pressed, so a wrong file is a click to remove rather than a job to chase
 * out of the queue.
 *
 * The preview is the browser's own PDF viewer pointed at a blob URL. No
 * renderer is bundled for it: pdf.js would be ~350 KB to show what every
 * target browser already draws natively.
 */
export function StagedPrint({
  files,
  duplex,
  onDuplex,
  onRemove,
  onPrint,
  onDiscard,
  busy,
}: {
  files: File[]
  duplex: boolean
  onDuplex: (value: boolean) => void
  onRemove: (index: number) => void
  onPrint: () => void
  onDiscard: () => void
  busy: boolean
}) {
  const reduce = useReducedMotion() ?? false
  const [shown, setShown] = useState(0)
  const active = files[Math.min(shown, files.length - 1)]

  // One blob URL per file, revoked when the set changes. Without the revoke
  // the browser holds every previewed PDF in memory for the life of the tab.
  const urls = useMemo(() => files.map((f) => URL.createObjectURL(f)), [files])
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls])

  if (files.length === 0) return null
  const total = files.reduce((n, f) => n + f.size, 0)

  return (
    <motion.section
      aria-labelledby="staged-heading"
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
      className="border-border bg-card flex flex-col gap-4 rounded-2xl border p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="staged-heading" className="text-base font-semibold tracking-tight">
          {files.length === 1 ? "Ready to print" : `${files.length} files ready to print`}
        </h2>
        <span className="text-muted-foreground text-xs tabular-nums">{formatBytes(total)}</span>
      </div>

      {/* Which file the preview is showing. Only worth a row when there is a choice. */}
      {files.length > 1 ? (
        <ul className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <button
                type="button"
                onClick={() => setShown(i)}
                aria-pressed={i === shown}
                className={
                  "focus-visible:ring-ring/50 max-w-56 truncate rounded-xl px-3 py-1.5 text-xs outline-none focus-visible:ring-3 " +
                  (i === shown
                    ? "bg-primary text-primary-foreground font-medium"
                    : "bg-muted text-muted-foreground hover:text-foreground")
                }
              >
                {f.name}
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center justify-between gap-3">
        <p className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{active?.name}</p>
        <button
          type="button"
          aria-label={`Remove ${active?.name}`}
          disabled={busy}
          onClick={() => onRemove(Math.min(shown, files.length - 1))}
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 grid size-8 shrink-0 place-items-center rounded-lg outline-none focus-visible:ring-3 disabled:opacity-50"
        >
          <XIcon className="size-4" />
        </button>
      </div>

      {active ? (
        <iframe
          key={urls[Math.min(shown, urls.length - 1)]}
          title={`Preview of ${active.name}`}
          src={urls[Math.min(shown, urls.length - 1)]}
          className="border-border bg-muted h-80 w-full rounded-xl border"
        />
      ) : null}

      <Sides value={duplex} onChange={onDuplex} disabled={busy} reduce={reduce} />

      <div className="flex flex-wrap items-center gap-2">
        <motion.button
          type="button"
          disabled={busy}
          onClick={onPrint}
          whileTap={reduce ? undefined : { scale: 0.97 }}
          transition={{ type: "spring", stiffness: 500, damping: 30 }}
          className="bg-primary text-primary-foreground focus-visible:ring-ring/50 inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold outline-none focus-visible:ring-3 disabled:opacity-55"
        >
          <PrinterIcon className="size-4" />
          {busy ? "Sending…" : files.length === 1 ? "Print" : `Print ${files.length} files`}
        </motion.button>
        <button
          type="button"
          disabled={busy}
          onClick={onDiscard}
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 inline-flex h-10 items-center justify-center rounded-xl px-4 text-sm font-medium outline-none focus-visible:ring-3 disabled:opacity-55"
        >
          Cancel
        </button>
      </div>
    </motion.section>
  )
}

/**
 * One-sided or both. A segmented control rather than a switch: both options
 * are named, so nobody has to work out what the off position means.
 */
function Sides({
  value,
  onChange,
  disabled,
  reduce,
}: {
  value: boolean
  onChange: (v: boolean) => void
  disabled: boolean
  reduce: boolean
}) {
  const options: { label: string; duplex: boolean }[] = [
    { label: "One side", duplex: false },
    { label: "Both sides", duplex: true },
  ]
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground text-xs font-medium">Sides</span>
      <div role="group" aria-label="Sides" className="bg-muted/60 flex gap-1 rounded-xl p-1">
        {options.map((o) => {
          const on = o.duplex === value
          return (
            <button
              key={o.label}
              type="button"
              disabled={disabled}
              aria-pressed={on}
              onClick={() => onChange(o.duplex)}
              className="focus-visible:ring-ring/50 relative rounded-lg px-3 py-1.5 text-xs font-medium outline-none focus-visible:ring-3 disabled:opacity-55"
            >
              {on ? (
                <motion.span
                  aria-hidden
                  layoutId="sides-indicator"
                  transition={
                    reduce ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 34 }
                  }
                  className="bg-card absolute inset-0 rounded-lg shadow-sm"
                />
              ) : null}
              <span
                className={
                  "relative " + (on ? "text-foreground" : "text-muted-foreground")
                }
              >
                {o.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
