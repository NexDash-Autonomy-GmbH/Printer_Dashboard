export type PrinterState = {
  printer_host: string
  model: string
  scanner: string
  adf: string
  scan_dir: string
  from_email: string | null
  from_name?: string | null
  ses_region: string
  emails: string[]
  workspace_emails?: string[]
  web_ui: string
}

export type ScanResult = {
  ok: boolean
  stage?: "scan_failed" | "mail_failed" | "sent" | "saved"
  scanned?: boolean
  error?: string
  files?: string[]
  recipients?: string[]
  emailed?: boolean
  log?: string[]
}

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, "") ?? ""

function url(path: string): string {
  return `${API_BASE}${path}`
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

export async function fetchState(): Promise<PrinterState> {
  const res = await fetch(url("/api/state"))
  if (!res.ok) {
    throw new Error(`Could not load printer state (${res.status})`)
  }
  return readJson<PrinterState>(res)
}

export async function addEmail(email: string): Promise<string[]> {
  const res = await fetch(url("/api/emails"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  })
  const data = await readJson<{ ok: boolean; emails?: string[]; error?: string }>(
    res
  )
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Could not add address")
  }
  return data.emails ?? []
}

export async function removeEmail(email: string): Promise<string[]> {
  const res = await fetch(url(`/api/emails?email=${encodeURIComponent(email)}`), {
    method: "DELETE",
  })
  const data = await readJson<{ ok: boolean; emails?: string[]; error?: string }>(
    res
  )
  if (!res.ok || !data.ok) {
    throw new Error(data.error || "Could not remove address")
  }
  return data.emails ?? []
}

export async function runScan(source: "auto" | "platen" | "adf"): Promise<ScanResult> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), 180_000)
  try {
    const res = await fetch(url("/api/scan"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source }),
      signal: ctrl.signal,
    })
    return await readJson<ScanResult>(res)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, stage: "scan_failed", error: "Scan timed out" }
    }
    throw error
  } finally {
    window.clearTimeout(timer)
  }
}
