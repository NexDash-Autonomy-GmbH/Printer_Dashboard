/* eslint-disable react-refresh/only-export-components */
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import {
  addEmail,
  fetchState,
  removeEmail,
  runScan,
  type PrinterState,
} from "@/lib/api"

export type ScanSource = "auto" | "platen" | "adf"

export type JobStatus = "idle" | "scanning" | "sent" | "saved" | "failed"

export type RecipientsState = {
  emails: string[]
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
    fromEmail: data.from_email || "",
    printerHost: data.printer_host,
    model: data.model,
    scanner: data.scanner,
    adf: data.adf,
    scanDir: data.scan_dir,
    loaded: true,
    loadError: null,
  }
}

export function RecipientsProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<RecipientsState>({
    emails: [],
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
  })

  const refresh = useCallback(async () => {
    try {
      const data = await fetchState()
      setState((current) => ({ ...current, ...applyPrinter(data) }))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Load failed"
      setState((current) => ({ ...current, loadError: message, loaded: true }))
    }
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      void refresh()
    }, 0)
    const id = window.setInterval(() => {
      void refresh()
    }, 10000)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(id)
    }
  }, [refresh])

  const add = useCallback(async () => {
    const value = state.draft.trim()
    if (!value) {
      setState((current) => ({ ...current, invalid: true }))
      return
    }
    if (value.toLowerCase() === state.fromEmail.toLowerCase()) {
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

  const scan = useCallback(async () => {
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
      return
    }
    if (result.stage === "saved") {
      setState((current) => ({
        ...current,
        jobStatus: "saved",
        jobMessage: "Scan saved. No recipients, so no mail was sent.",
      }))
      toast.success("Scan saved. No mail sent.")
      return
    }
    const message = result.error || "Scan failed"
    setState((current) => ({
      ...current,
      jobStatus: "failed",
      jobMessage: result.scanned ? `Scan saved. Mail failed: ${message}` : message,
    }))
    toast.error(message)
  }, [refresh, state.source])

  const actions = useMemo<RecipientsActions>(
    () => ({
      setDraft: (value) =>
        setState((current) => ({ ...current, draft: value, invalid: false })),
      add,
      remove,
      setSource: (source) => setState((current) => ({ ...current, source })),
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
