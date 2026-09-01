import { CheckIcon, CircleAlertIcon, FileTextIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"

import { PdfDropzone } from "@/components/PdfDropzone"
import { PrintingAnimation } from "@/components/PrintingAnimation"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import {
  cancelPrint,
  fetchPrintQueue,
  PRINT_MAX_BYTES,
  type PrintJob,
  type PrintQueue,
  uploadPrint,
} from "@/lib/api"
import { formatWhen } from "@/lib/format"
import { useRecipients } from "@/recipients/context"

// The queue moves when the bridge finishes a page, not when this tab does
// anything, so it is re-read on a timer while the page is open.
const POLL_MS = 4000

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function ownerLabel(job: PrintJob): string {
  if (job.mine) return "You"
  return job.owner.split("@")[0] || "Someone"
}

function JobRow({
  job,
  onCancel,
  busy,
  printerBusy,
}: {
  job: PrintJob
  onCancel: (id: string) => void
  busy: boolean
  printerBusy: boolean
}) {
  const reduce = useReducedMotion() ?? false
  const printing = job.status === "printing"
  const finished = job.status === "done" || job.status === "failed"

  return (
    <motion.li
      layout={!reduce}
      initial={reduce ? { opacity: 0 } : { opacity: 0, y: -12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={reduce ? { opacity: 0 } : { opacity: 0, y: -4 }}
      transition={{ duration: 0.2 }}
      className="bg-muted/60 flex min-h-14 items-center gap-1 rounded-2xl p-1"
    >
      <div className="bg-card relative flex min-w-0 flex-1 items-center gap-3 self-stretch overflow-hidden rounded-xl px-3 py-2">
        {printing ? (
          <span
            aria-hidden
            className="bg-primary/10 pointer-events-none absolute inset-0 -z-10"
          />
        ) : null}

        <span
          aria-hidden
          className={
            "grid size-8 shrink-0 place-items-center rounded-lg " +
            (job.status === "failed"
              ? "bg-status-down/15 text-status-down"
              : job.status === "done"
                ? "bg-status-ok/15 text-status-ok"
                : "bg-muted text-muted-foreground")
          }
        >
          {job.status === "done" ? (
            <CheckIcon className="size-4" />
          ) : job.status === "failed" ? (
            <CircleAlertIcon className="size-4" />
          ) : (
            <FileTextIcon className="size-4" />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span className="text-foreground block truncate text-sm font-medium">{job.name}</span>
          <span className="text-muted-foreground block truncate text-xs">
            {ownerLabel(job)} · {formatBytes(job.size)}
            {job.status === "failed" && job.error ? ` · ${job.error}` : null}
            {finished && job.finished_at ? ` · ${formatWhen(job.finished_at)}` : null}
          </span>
        </span>

        <span className="shrink-0 text-xs tabular-nums">
          {printing ? (
            <span className="text-primary inline-flex items-center gap-1.5 font-medium">
              <LoaderCircleIcon className={reduce ? "size-3.5" : "size-3.5 animate-spin"} />
              {printerBusy ? "Printing" : "Sending to printer"}
            </span>
          ) : job.status === "queued" ? (
            <span className="text-muted-foreground">#{job.position} in line</span>
          ) : job.status === "done" ? (
            <span className="text-status-ok">Printed</span>
          ) : (
            <span className="text-status-down">Failed</span>
          )}
        </span>
      </div>

      {job.status === "queued" && job.mine ? (
        <button
          type="button"
          aria-label={`Remove ${job.name} from the queue`}
          disabled={busy}
          onClick={() => onCancel(job.id)}
          className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 grid size-9 shrink-0 place-items-center rounded-xl outline-none focus-visible:ring-3 disabled:opacity-50"
        >
          <XIcon className="size-4" />
        </button>
      ) : (
        <span aria-hidden className="size-9 shrink-0" />
      )}
    </motion.li>
  )
}

export function PrintView() {
  // What the Xerox itself reports over SNMP, via the bridge. The animation
  // follows this, not our queue: "printing" here means paper is moving.
  const { state: desk } = useRecipients()
  const printerStatus = (desk.supplies?.status || "").toLowerCase()
  const printerBusy = printerStatus === "printing" || printerStatus === "warmup"
  const [queue, setQueue] = useState<PrintQueue | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(0)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setQueue(await fetchPrintQueue())
      setLoadError(null)
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Could not load the print queue")
    }
  }, [])

  useEffect(() => {
    // First read on the next tick rather than synchronously in the effect, which
    // is what the set-state-in-effect rule is guarding against.
    const first = window.setTimeout(() => void refresh(), 0)
    const timer = window.setInterval(() => void refresh(), POLL_MS)
    return () => {
      window.clearTimeout(first)
      window.clearInterval(timer)
    }
  }, [refresh])

  const addFiles = useCallback(
    async (files: File[]) => {
      const pdfs = files.filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name))
      const rejected = files.length - pdfs.length
      if (rejected > 0) {
        toast.error(
          rejected === 1
            ? "That file is not a PDF. Press ⌘P and choose Save as PDF first."
            : `${rejected} files are not PDFs. Press ⌘P and choose Save as PDF first.`,
        )
      }
      for (const file of pdfs) {
        setUploading((n) => n + 1)
        try {
          const next = await uploadPrint(file)
          setQueue(next)
          const me = next.jobs.find((j) => j.id === next.id)
          toast.success(
            me?.position && me.position > 1
              ? `${file.name} queued — #${me.position} in line`
              : `${file.name} queued`,
          )
        } catch (error) {
          toast.error(error instanceof Error ? error.message : `Could not queue ${file.name}`)
        } finally {
          setUploading((n) => n - 1)
        }
      }
    },
    [],
  )

  const cancel = useCallback(async (id: string) => {
    setBusyId(id)
    try {
      setQueue(await cancelPrint(id))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that job")
    } finally {
      setBusyId(null)
    }
  }, [])

  const jobs = queue?.jobs ?? []
  const nowPrinting = jobs.find((j) => j.status === "printing") ?? null
  // A claimed job stays in the list until the printer itself confirms it is
  // working; then the card above carries it.
  const live = jobs.filter((j) => j.status === "queued" || (j.status === "printing" && !printerBusy))
  const history = jobs.filter((j) => j.status === "done" || j.status === "failed").slice(-8).reverse()
  const someoneElsePrinting = nowPrinting !== null && !nowPrinting.mine
  const myQueued = live.filter((j) => j.mine && j.status === "queued")
  const bridgeOffline = queue !== null && !queue.bridge_online

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      {loadError ? (
        <Alert>
          <AlertTitle>{loadError}</AlertTitle>
          <AlertDescription>The queue below may be out of date.</AlertDescription>
        </Alert>
      ) : null}

      {bridgeOffline ? (
        <Alert>
          <AlertTitle>The printer bridge is offline</AlertTitle>
          <AlertDescription>
            You can still queue PDFs. They start printing the moment the office box comes back.
          </AlertDescription>
        </Alert>
      ) : null}

      {printerBusy ? (
        <section
          aria-live="polite"
          className="border-border bg-card flex items-center gap-5 rounded-2xl border p-5"
        >
          <PrintingAnimation className="size-24 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-primary text-xs font-semibold tracking-wide uppercase">
              {printerStatus === "warmup" ? "Warming up" : "Now printing"}
            </p>
            {nowPrinting ? (
              <>
                <p className="text-foreground mt-1 truncate text-base font-semibold">{nowPrinting.name}</p>
                <p className="text-muted-foreground mt-0.5 text-sm">
                  {ownerLabel(nowPrinting)} · {formatBytes(nowPrinting.size)}
                  {nowPrinting.mine ? "" : " · yours starts when this finishes"}
                </p>
              </>
            ) : (
              <>
                <p className="text-foreground mt-1 text-base font-semibold">Something not from this queue</p>
                <p className="text-muted-foreground mt-0.5 text-sm">
                  Most likely a laptop printing directly. Queued jobs wait for it.
                </p>
              </>
            )}
          </div>
        </section>
      ) : null}

      {someoneElsePrinting && myQueued.length > 0 ? (
        <Alert>
          <AlertTitle>
            {ownerLabel(nowPrinting!)} is printing — you are #
            {myQueued[0].position} in line
          </AlertTitle>
          <AlertDescription>
            One job prints at a time. Yours starts automatically when the printer is free.
          </AlertDescription>
        </Alert>
      ) : null}

      <PdfDropzone onFiles={(files) => void addFiles(files)} disabled={uploading > 0} maxBytes={PRINT_MAX_BYTES} />

      <section aria-labelledby="print-queue-heading" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between">
          <h2 id="print-queue-heading" className="text-lg font-semibold">
            Queue
          </h2>
          {uploading > 0 ? (
            <span className="text-muted-foreground text-xs">Uploading {uploading}…</span>
          ) : null}
        </div>
        {live.length === 0 && !nowPrinting ? (
          <Empty className="border-border bg-card/40 min-h-40 rounded-2xl border">
            <EmptyHeader>
              <EmptyTitle>Nothing waiting</EmptyTitle>
              <EmptyDescription>Drop a PDF above and it goes straight to the front.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            <AnimatePresence initial={false}>
              {live.map((job) => (
                <JobRow key={job.id} job={job} onCancel={(id) => void cancel(id)} busy={busyId === job.id} printerBusy={printerBusy} />
              ))}
            </AnimatePresence>
          </ul>
        )}
      </section>

      {history.length > 0 ? (
        <section aria-labelledby="print-history-heading" className="flex flex-col gap-3">
          <h2 id="print-history-heading" className="text-muted-foreground text-sm font-semibold">
            Recently printed
          </h2>
          <ul className="flex flex-col gap-2">
            {history.map((job) => (
              <JobRow key={job.id} job={job} onCancel={() => undefined} busy={false} printerBusy={printerBusy} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
