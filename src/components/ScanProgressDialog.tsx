import { useState } from "react"

import { PrintingAnimation } from "@/components/PrintingAnimation"
import { formatBytes } from "@/lib/format"
import { useRecipients } from "@/recipients/context"

/**
 * Covers the screen while a scan runs.
 *
 * Two reasons to be up. A scan this tab started, which is modal because the
 * outcome is about to arrive here. Or the server reporting one already in
 * flight, which is how this comes back after the tab was closed and reopened
 * -- the scan never needed the page to be open, only the view of it did.
 */

/**
 * The phases, in order, with how far through each one is.
 *
 * Deliberately phase-based rather than a byte percentage. The Worker's front
 * door buffers request bodies before the Durable Object sees them, so it
 * cannot watch the upload arrive; a byte counter there would sit at zero and
 * then jump to done. These four are real transitions the bridge and the
 * Worker actually observe, so the bar never invents movement it cannot see.
 */
const PHASES = [
  { id: "waiting", label: "Waiting for the office bridge", pct: 8 },
  { id: "scanning", label: "Scanning at the printer", pct: 42 },
  { id: "uploading", label: "Sending the scan on", pct: 78 },
  { id: "emailing", label: "Emailing it", pct: 94 },
] as const

export function ScanProgressDialog() {
  const { state } = useRecipients()
  const [dismissed, setDismissed] = useState(0)

  const mine = state.jobStatus === "scanning"
  // Already filtered for staleness upstream: the context drops a reported
  // scan older than the Worker's own timeout, so anything here is live.
  const remote = state.remoteScan
  // Dismissing hides that scan, not every future one, so the next scan shows
  // normally rather than being silently suppressed.
  const restored = !mine && remote !== null && remote.since !== dismissed

  if (!mine && !restored) {
    return null
  }

  // The phase comes from the server whoever started the scan. Using it only
  // for a restored view meant the person who pressed Scan watched a bar that
  // never moved, while someone who merely reopened the tab got the live one.
  // The context re-reads state every few seconds, so this advances for both.
  const phase = PHASES.find((p) => p.id === remote?.stage)
  const pct = phase?.pct ?? 8
  const heading = phase?.label ?? "Talking to the Xerox…"

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-progress-title"
      className="bg-background/80 fixed inset-0 z-50 grid place-items-center p-6 backdrop-blur-sm"
    >
      <div className="border-border bg-card w-full max-w-sm rounded-2xl border p-8 text-center shadow-lg">
        <PrintingAnimation className="mx-auto" />
        <p id="scan-progress-title" className="text-lg font-semibold">
          Scanning
        </p>

        {/* The server's phase wins over the local message: it says where the
            job actually is, whereas jobMessage is whatever this tab last set
            before it lost track. */}
        <p aria-live="polite" className="text-muted-foreground mt-1 text-sm">
          {phase ? heading : state.jobMessage || heading}
        </p>

        <div
          role="progressbar"
          aria-label="Scan progress"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          className="bg-muted mt-5 h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${pct}%` }}
          />
        </div>

        <ol className="text-muted-foreground/90 mt-3 flex justify-between text-[11px]">
          {PHASES.map((p) => {
            const done = pct > p.pct
            const here = remote?.stage === p.id
            return (
              <li
                key={p.id}
                aria-current={here ? "step" : undefined}
                className={here ? "text-foreground font-medium" : done ? "text-foreground/70" : ""}
              >
                {p.id === "waiting"
                  ? "Queued"
                  : p.id === "scanning"
                    ? "Scanning"
                    : p.id === "uploading"
                      ? "Sending"
                      : "Email"}
              </li>
            )
          })}
        </ol>

        {remote?.bytes ? (
          <p className="text-muted-foreground/80 mt-3 text-xs tabular-nums">
            {formatBytes(remote.bytes)} scanned
          </p>
        ) : null}

        <p className="text-muted-foreground/80 mt-4 text-xs">
          Safe to close this page — the scan and the email finish without it.
        </p>

        {/* Only the restored view can be dismissed. A scan this tab started is
            about to report its outcome here, so closing it would throw away
            the only place that result is shown. A restored one has no outcome
            coming, and without this a stuck job trapped the whole page. */}
        {restored ? (
          <button
            type="button"
            onClick={() => setDismissed(remote.since)}
            className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 mt-4 rounded-xl px-3 py-1.5 text-xs font-medium outline-none focus-visible:ring-3"
          >
            Hide this
          </button>
        ) : null}
      </div>
    </div>
  )
}
