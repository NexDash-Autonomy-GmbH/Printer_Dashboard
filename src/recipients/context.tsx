/* eslint-disable react-refresh/only-export-components */
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { toast } from "sonner"

import {
  addEmail,
  discardReview,
  fetchState,
  removeEmail,
  runScan,
  savePick,
  sendReview,
  type PrinterState,
  type ScanLog,
  type Supplies,
} from "@/lib/api"

export type ScanSource = "auto" | "platen" | "adf"

export type JobStatus = "idle" | "scanning" | "sent" | "saved" | "failed"

export type RecipientsState = {
  emails: string[]
  /**
   * Saved recipients left off scans. Kept as who is left out rather than who
   * is in, so an address added later is in by default, the way adding one
   * always worked. The Worker keeps it per person, next to their list, so it
   * holds across reloads, sign-outs and devices until they change it.
   */
  leftOut: string[]
  workspaceEmails: string[]
  fromEmail: string
  /** The display name scan mail goes out under, "NexDash". */
  fromName: string
  printerHost: string
  model: string
  scanner: string
  adf: string
  scanDir: string
  draft: string
  invalid: boolean
  source: ScanSource
  loaded: boolean
  loadError: string | null
  jobStatus: JobStatus
  jobMessage: string
  bridgeOnline: boolean
  scans: ScanLog[]
  /**
   * A scan the server says is running, which may have been started by a tab
   * that is now closed. Separate from jobStatus, which only ever describes a
   * scan this tab started, so restoring the view never fights local state.
   */
  remoteScan: {
    stage: "waiting" | "scanning" | "uploading" | "emailing"
    since: number
    bytes: number | null
  } | null
  supplies: Supplies | null
  /**
   * The held scan the review dialog shows. `open` goes false on close while
   * the id stays, so the dialog keeps its pages on screen as it fades out.
   */
  review: { id: string; open: boolean } | null
}

export type RecipientsActions = {
  setDraft: (value: string) => void
  add: () => Promise<void>
  remove: (email: string) => Promise<void>
  /** Who the next scan goes to, out of the saved recipients. */
  pick: (to: string[]) => void
  setSource: (source: ScanSource) => void
  /* fresh: ask the bridge for a new reading first. The Refresh button's job. */
  refresh: (options?: { fresh?: boolean }) => Promise<void>
  scan: () => Promise<void>
  openReview: (id: string) => void
  closeReview: () => void
  /* Both throw with the reason on failure, for the dialog to show in place. */
  sendReview: (id: string, rotate: number[], to: string[]) => Promise<void>
  discardReview: (id: string) => Promise<void>
}

export type RecipientsContextValue = {
  state: RecipientsState
  actions: RecipientsActions
}

const RecipientsContext = createContext<RecipientsContextValue | null>(null)

/** The saved recipients the next scan goes to. */
export function picked(emails: string[], leftOut: string[]): string[] {
  return emails.filter((email) => !leftOut.includes(email))
}

function applyPrinter(data: PrinterState): Partial<RecipientsState> {
  const fromEmail = (data.from_email || "").toLowerCase()
  return {
    emails: (data.emails || []).filter((email) => email.toLowerCase() !== fromEmail),
    workspaceEmails: (data.workspace_emails || []).filter(
      (email) => email.toLowerCase() !== fromEmail
    ),
    fromEmail: data.from_email || "",
    fromName: data.from_name || "",
    printerHost: data.printer_host,
    model: data.model,
    scanner: data.scanner,
    adf: data.adf,
    scanDir: data.scan_dir,
    loaded: true,
    loadError: null,
    bridgeOnline: Boolean(data.bridge_online),
    scans: data.scans || [],
    // Dropped here rather than in the view. The Worker gives a scan 180 s
    // before it fails it, so anything older is not coming back, and judging
    // that during render would mean calling Date.now() in a component -- a
    // value that changes on every re-render for no reason the render can see.
    remoteScan:
      data.scan_in_progress && Date.now() - data.scan_in_progress.since < 240_000
        ? {
            stage: data.scan_in_progress.stage,
            since: data.scan_in_progress.since,
            bytes: data.scan_in_progress.bytes ?? null,
          }
        : null,
    supplies: data.supplies || null,
  }
}

export function RecipientsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecipientsState>({
    emails: [],
    leftOut: [],
    workspaceEmails: [],
    fromEmail: "",
    fromName: "",
    printerHost: "",
    model: "Xerox B305 MFP",
    scanner: "…",
    adf: "…",
    scanDir: "",
    draft: "",
    invalid: false,
    source: "platen",
    loaded: false,
    loadError: null,
    jobStatus: "idle",
    jobMessage: "",
    bridgeOnline: false,
    scans: [],
    remoteScan: null,
    supplies: null,
    review: null,
  })

  // A toggle shows at once and saves behind it. A poll that set off before
  // a save finished can carry the old pick, and taking it would flick the
  // chip back. So pickSeq moves on every toggle and every finished save, and
  // a poll's pick is only taken if pickSeq has not moved since it set off and
  // no save is still out.
  const pickSeq = useRef(0)
  const pickSaving = useRef(0)

  const refresh = useCallback(async ({ fresh = false }: { fresh?: boolean } = {}) => {
    const seq = pickSeq.current
    try {
      const data = await fetchState({ fresh })
      const takePick = data.left_out !== undefined && seq === pickSeq.current && pickSaving.current === 0
      setState((current) => {
        const next = { ...current, ...applyPrinter(data) }
        if (takePick) {
          next.leftOut = data.left_out ?? []
        }
        const empty = (next.adf || "").toLowerCase().includes("empty")
        if (empty && current.source === "adf") {
          next.source = "platen"
        }
        return next
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Load failed"
      setState((current) => ({ ...current, loadError: message, loaded: true }))
    }
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refresh()
    }, 0)
    // Polls right through a scan, deliberately.
    //
    // This used to skip while jobStatus was "scanning", which meant the one
    // moment the page most needed fresh state was the one moment it stopped
    // asking for it: the scan phase lives on the server, so the progress bar
    // sat at its starting position for the whole job and only ever moved for
    // someone who reloaded.
    //
    // Safe because applyPrinter writes none of the scan's own fields --
    // jobStatus and jobMessage are set locally and left alone here -- so a
    // refresh landing mid-scan cannot overwrite what the scan is doing.
    const id = window.setInterval(() => {
      void refresh()
    }, 3000)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(id)
    }
  }, [refresh])

  const add = useCallback(async () => {
    let value = state.draft.trim()
    if (!value) {
      setState((current) => ({ ...current, invalid: true }))
      return
    }
    if (!value.includes("@") && state.fromEmail.includes("@")) {
      value = `${value}@${state.fromEmail.split("@")[1]}`
    }
    if (state.fromEmail && value.toLowerCase() === state.fromEmail.toLowerCase()) {
      toast.error("That address is the sender")
      setState((current) => ({ ...current, invalid: true }))
      return
    }
    try {
      const emails = await addEmail(value)
      const added = value.toLowerCase()
      setState((current) => ({
        ...current,
        emails,
        // Added means wanted, even if it was left out before it was removed.
        leftOut: current.leftOut.filter((email) => email !== added),
        draft: "",
        invalid: false,
      }))
      toast.success(`Added ${value.toLowerCase()}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not add address"
      setState((current) => ({ ...current, invalid: true }))
      toast.error(message)
    }
  }, [state.draft])

  const remove = useCallback(async (email: string) => {
    try {
      const emails = await removeEmail(email)
      setState((current) => ({
        ...current,
        emails,
        leftOut: current.leftOut.filter((item) => item !== email),
      }))
      toast.success(`Removed ${email}`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove address")
    }
  }, [])

  /**
   * Puts the scan controls back to rest once a finished job has been read.
   *
   * jobStatus was set to sent, saved or failed and left there, so the button
   * still read "Sent" and the result banner was still up when someone came
   * back to scan the next thing. Clearing it loses nothing: the toast has
   * already shown the outcome and Scan jobs keeps it permanently.
   *
   * Guarded on the status not having moved, so a scan started inside the
   * window is never dragged back to idle underneath itself.
   */
  const settleLater = useCallback((from: JobStatus) => {
    window.setTimeout(() => {
      setState((current) =>
        current.jobStatus === from ? { ...current, jobStatus: "idle", jobMessage: "" } : current,
      )
    }, 6000)
  }, [])

  const scan = useCallback(async () => {
    const to = picked(state.emails, state.leftOut)
    // The Scan button is off in this case. This is for anything that gets
    // here regardless: a scan for nobody would be checked and then have
    // nowhere to go.
    if (to.length === 0) {
      toast.error(state.emails.length ? "Switch someone on under Recipients" : "Add a recipient first")
      return
    }
    if (state.source === "adf" && state.adf.toLowerCase().includes("empty")) {
      toast.error("Feeder is empty")
      setState((current) => ({
        ...current,
        jobStatus: "failed",
        jobMessage: "Feeder is empty. Load paper or use Glass.",
      }))
        settleLater("failed")
      return
    }
    setState((current) => ({
      ...current,
      jobStatus: "scanning",
      jobMessage: "Scanning…",
    }))
    const result = await runScan(state.source, { to })
    await refresh()
    // Held for checking: straight into the review, with nothing to report
    // yet. The scan controls go back to rest, since the scan itself is done
    // and the held row in Scan jobs is what says it is still unsent.
    if (result.stage === "awaiting_review" && result.review) {
      const id = result.review
      setState((current) => ({
        ...current,
        jobStatus: "idle",
        jobMessage: "",
        review: { id, open: true },
      }))
      return
    }
    if (result.stage === "sent" || result.emailed) {
      const to = result.recipients?.join(", ") || "recipients"
      setState((current) => ({
        ...current,
        jobStatus: "sent",
        jobMessage: `Sent to ${to}`,
      }))
      toast.success(`Sent to ${to}`)
      settleLater("sent")
      return
    }
    if (result.stage === "saved") {
      setState((current) => ({
        ...current,
        jobStatus: "saved",
        jobMessage: "Scan saved. No recipients, so no mail was sent.",
      }))
      toast.success("Scan saved. No mail sent.")
      settleLater("saved")
      return
    }
    const message = result.error || "Scan failed"
    setState((current) => ({
      ...current,
      jobStatus: "failed",
      jobMessage: result.scanned ? `Scan saved. Mail failed: ${message}` : message,
    }))
    toast.error(message)
    settleLater("failed")
  }, [refresh, state.source, state.adf, state.emails, state.leftOut, settleLater])

  const closeReview = useCallback(() => {
    setState((current) =>
      current.review ? { ...current, review: { ...current.review, open: false } } : current,
    )
  }, [])

  const sendHeld = useCallback(
    async (id: string, rotate: number[], to: string[]) => {
      const result = await sendReview(id, rotate, to)
      await refresh()
      const sentTo = result.recipients?.join(", ") || "recipients"
      setState((current) => ({
        ...current,
        review: current.review?.id === id ? { id, open: false } : current.review,
        // Only if nothing newer owns the banner.
        ...(current.jobStatus === "scanning" ? {} : { jobStatus: "sent" as const, jobMessage: `Sent to ${sentTo}` }),
      }))
      toast.success(`Sent to ${sentTo}`)
      settleLater("sent")
    },
    [refresh, settleLater],
  )

  const discardHeld = useCallback(
    async (id: string) => {
      await discardReview(id)
      await refresh()
      setState((current) => ({
        ...current,
        review: current.review?.id === id ? { id, open: false } : current.review,
      }))
      toast.success("Scan discarded. Nothing was sent.")
    },
    [refresh],
  )

  const pick = useCallback(
    (to: string[]) => {
      const leftOut = state.emails.filter((email) => !to.includes(email))
      pickSeq.current += 1
      pickSaving.current += 1
      setState((current) => ({ ...current, leftOut }))
      void savePick(leftOut)
        .catch((error) => {
          // The scan still goes to what is on screen, since it sends its own
          // list. Only the remembering failed, and the next poll puts the
          // saved pick back.
          toast.error(error instanceof Error ? error.message : "Could not save who gets scans")
        })
        .finally(() => {
          pickSaving.current -= 1
          pickSeq.current += 1
        })
    },
    [state.emails],
  )

  const actions = useMemo<RecipientsActions>(
    () => ({
      setDraft: (value) =>
        setState((current) => ({ ...current, draft: value, invalid: false })),
      add,
      remove,
      pick,
      setSource: (source) =>
        setState((current) => {
          const empty = current.adf.toLowerCase().includes("empty")
          if (source === "adf" && empty) {
            toast.error("Feeder is empty")
            return current
          }
          return { ...current, source }
        }),
      refresh,
      scan,
      openReview: (id) => setState((current) => ({ ...current, review: { id, open: true } })),
      closeReview,
      sendReview: sendHeld,
      discardReview: discardHeld,
    }),
    [add, remove, pick, refresh, scan, closeReview, sendHeld, discardHeld]
  )

  const value = useMemo<RecipientsContextValue>(
    () => ({
      state,
      actions,
    }),
    [actions, state]
  )

  return <RecipientsContext value={value}>{children}</RecipientsContext>
}

export function useRecipients() {
  const value = use(RecipientsContext)
  if (!value) {
    throw new Error("useRecipients must be used within RecipientsProvider")
  }
  return value
}
