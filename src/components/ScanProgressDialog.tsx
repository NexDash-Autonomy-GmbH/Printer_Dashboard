import { PrintingAnimation } from "@/components/PrintingAnimation"
import { useRecipients } from "@/recipients/context"

/**
 * Covers the screen while a scan runs. jobStatus stays "scanning" for the whole
 * operation — the scan itself and the mail that follows — so this is up until
 * the job resolves either way. Modal on purpose: the job is tied to this tab,
 * and leaving mid-scan loses the result.
 */
export function ScanProgressDialog() {
  const { state } = useRecipients()
  // Two reasons to be up. jobStatus is this tab's own scan. remoteScan is the
  // server saying one is running, which is what restores this dialog after the
  // tab was closed and reopened -- the scan never needed the page to be open,
  // only the view of it did.
  const mine = state.jobStatus === "scanning"
  const restored = !mine && state.remoteScan !== null
  if (!mine && !restored) {
    return null
  }

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
        {/* The message names the current step, so announce it as it changes.
            The generic "Scanning…" would only repeat the heading. */}
        <p aria-live="polite" className="text-muted-foreground mt-1 text-sm">
          {restored
            ? state.remoteScan?.stage === "waiting"
              ? "Waiting for the office bridge to pick it up…"
              : "Already running — started from another tab or before this page was reopened."
            : state.jobMessage && state.jobMessage !== "Scanning…"
              ? state.jobMessage
              : "Talking to the Xerox…"}
        </p>
        {/* The old copy said to keep the page open. That was wrong, and it is
            worth saying so plainly: the scan and the mail both run on the
            server, so closing this tab does not stop either. */}
        <p className="text-muted-foreground/80 mt-4 text-xs">
          Safe to close this page — the scan and the email finish without it.
        </p>
      </div>
    </div>
  )
}
