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

async function request(path: string, init: RequestInit = {}, ms = 8000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = window.setTimeout(() => ctrl.abort(), ms)
  try {
    return await fetch(url(path), { ...init, signal: ctrl.signal })
  } finally {
    window.clearTimeout(timer)
  }
}

async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T
}

export async function fetchState(): Promise<PrinterState> {
  try {
    const res = await request("/api/state", {}, 4000)
    if (!res.ok) {
      throw new Error(`Could not load printer state (${res.status})`)
    }
    return readJson<PrinterState>(res)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error("Printer did not respond")
    }
    throw error
  }
}

export async function addEmail(email: string): Promise<string[]> {
  const res = await request("/api/emails", {
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
  const res = await request(`/api/emails?email=${encodeURIComponent(email)}`, {
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
  try {
    const res = await request(
      "/api/scan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source }),
      },
      180_000
    )
    return await readJson<ScanResult>(res)
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return { ok: false, stage: "scan_failed", error: "Scan timed out" }
    }
    throw error
  }
}
