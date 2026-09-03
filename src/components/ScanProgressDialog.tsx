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
 * The stages, as the job actually happens.
 *
 * Three, not four, because the bridge stopped storing the scan: it now relays
 * the pages to the Worker while the printer is still producing them. Scanning
 * and sending are one act, and showing them as two steps made the bar appear
 * to skip -- the server's "scanning" phase lasts about as long as it takes to
 * claim the job.
 *
 * The server still reports four phases and is right to: it distinguishes
 * having claimed the job from having started to move bytes. This is the
 * presentation, and it maps both onto the stage a person can see happening.
 *
 * Deliberately not a byte percentage. The Worker's front door buffers request
 * bodies before the Durable Object sees them, so a byte counter there would
 * sit at zero and jump to done.
 */
const STAGES = [
  { key: "queued", label: "Queued", detail: "Waiting for the office bridge", pct: 10 },
  {
    key: "running",
    label: "Scanning",
    detail: "Scanning and sending at the same time",
    pct: 62,
  },
  { key: "email", label: "Email", detail: "Emailing it", pct: 92 },
] as const

/** Which visible stage a reported phase belongs to. */
function stageOf(phase: string | undefined) {
  if (phase === "waiting") return STAGES[0]
  if (phase === "scanning" || phase === "uploading") return STAGES[1]
  if (phase === "emailing") return STAGES[2]
  return undefined
}

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
  const stage = stageOf(remote?.stage)
  const pct = stage?.pct ?? 10
  const heading = stage?.detail ?? "Talking to the Xerox…"

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
          {stage ? heading : state.jobMessage || heading}
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
          {STAGES.map((st) => {
            const done = pct > st.pct
            const here = stage?.key === st.key
            return (
              <li
                key={st.key}
                aria-current={here ? "step" : undefined}
                className={here ? "text-foreground font-medium" : done ? "text-foreground/70" : ""}
              >
                {st.label}
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
