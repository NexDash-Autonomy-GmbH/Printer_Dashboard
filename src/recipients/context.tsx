/* eslint-disable react-refresh/only-export-components */
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  addEmail,
  fetchState,
  removeEmail,
  runScan,
  type PrinterState,
  type ScanLog,
  type Supplies,
} from "@/lib/api"

export type ScanSource = "auto" | "platen" | "adf"

export type JobStatus = "idle" | "scanning" | "sent" | "saved" | "failed"

export type RecipientsState = {
  emails: string[]
  workspaceEmails: string[]
  fromEmail: string
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
}

export type RecipientsActions = {
  setDraft: (value: string) => void
  add: () => Promise<void>
  remove: (email: string) => Promise<void>
  setSource: (source: ScanSource) => void
  refresh: () => Promise<void>
  scan: () => Promise<void>
}

export type RecipientsContextValue = {
  state: RecipientsState
  actions: RecipientsActions
}

const RecipientsContext = createContext<RecipientsContextValue | null>(null)

function applyPrinter(data: PrinterState): Partial<RecipientsState> {
  const fromEmail = (data.from_email || "").toLowerCase()
  return {
    emails: (data.emails || []).filter((email) => email.toLowerCase() !== fromEmail),
    workspaceEmails: (data.workspace_emails || []).filter(
      (email) => email.toLowerCase() !== fromEmail
    ),
    fromEmail: data.from_email || "",
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
    workspaceEmails: [],
    fromEmail: "",
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
  })

  const refresh = useCallback(async () => {
    try {
      const data = await fetchState()
      setState((current) => {
        const next = { ...current, ...applyPrinter(data) }
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
      setState((current) => ({
        ...current,
        emails,
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
      setState((current) => ({ ...current, emails }))
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
    const result = await runScan(state.source)
    await refresh()
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
  }, [refresh, state.source, settleLater])

  const actions = useMemo<RecipientsActions>(
    () => ({
      setDraft: (value) =>
        setState((current) => ({ ...current, draft: value, invalid: false })),
      add,
      remove,
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
    }),
    [add, remove, refresh, scan]
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
