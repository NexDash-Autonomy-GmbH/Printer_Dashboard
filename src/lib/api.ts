export type ScanLog = {
  at: number
  name: string
  stage: string
  recipients: string[]
  error?: string
}

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
  /** A scan running right now, whoever started it and whatever tab they used. */
  scan_in_progress?: {
    stage: "waiting" | "scanning" | "uploading" | "emailing"
    since: number
    source: string
    bytes?: number | null
  } | null
  bridge_online?: boolean
  scans?: ScanLog[]
  supplies?: Supplies | null
}

export type Supplies = {
  online: boolean
  status: string
  model?: string
  serial?: string
  pages?: number | null
  uptime_ticks?: number
  console?: string
  /* No longer sent. The bridge stopped gathering these when the Supplies
     screen was removed, but rows stored before that still carry them, so a
     reader has to cope with either shape. */
  toners?: Array<{ name: string; pct: number | null; color: string }>
  trays?: Array<{ name: string; capacity: number; level: number; pct: number | null; status: string }>
  alerts?: Array<{ severity: string; desc: string }>
  checked_at: number
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

// Same origin. /api/* is served by a Pages Function that forwards to the Worker
// over a service binding, so Access protects the API with the same first-party
// session as the page. Calling the Worker's own hostname would need a
// third-party cookie, which Safari blocks outright.
function apiBase(): string {
  return (import.meta.env.VITE_API_BASE as string | undefined)?.trim().replace(/\/$/, "") ?? ""
}

function url(path: string): string {
  return `${apiBase()}${path}`
}

const UNREACHABLE = "Printer unreachable"

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
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
  const text = await res.text()
  const type = res.headers.get("content-type") || ""
  if (!type.includes("json")) {
    throw new Error(UNREACHABLE)
  }
  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(UNREACHABLE)
  }
}

export const SIGNED_OUT = "Your sign-in has expired. Reload the page to sign in again."

export async function fetchState(): Promise<PrinterState> {
  try {
    // Do not chase a redirect: Access answers an expired session with a 302 to
    // its own login host, and following that cross-origin fails CORS, which
    // used to surface as "Printer unreachable" — the wrong diagnosis entirely.
    const res = await request("/api/state", { redirect: "manual" }, 4000)
    if (res.type === "opaqueredirect" || res.status === 0) {
      throw new Error(SIGNED_OUT)
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(SIGNED_OUT)
    }
    if (res.status === 503) {
      throw new Error("The printer service is not wired up. An admin needs to check the Worker binding.")
    }
    if (!res.ok) {
      throw new Error(`${UNREACHABLE} (HTTP ${res.status})`)
    }
    return readJson<PrinterState>(res)
  } catch (error) {
    if (isAbort(error)) {
      throw new Error("Printer did not respond", { cause: error })
    }
    // Keep a message we already chose; only unlabelled failures become UNREACHABLE.
    if (error instanceof Error && error.message && error.message !== UNREACHABLE) {
      throw error
    }
    throw new Error(UNREACHABLE, { cause: error })
  }
}

export async function addEmail(email: string): Promise<string[]> {
  try {
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
  } catch (error) {
    if (error instanceof Error && error.message && error.message !== UNREACHABLE) {
      throw new Error(error.message, { cause: error })
    }
    throw new Error("Could not add address", { cause: error })
  }
}

export async function removeEmail(email: string): Promise<string[]> {
  try {
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
  } catch (error) {
    if (error instanceof Error && error.message && error.message !== UNREACHABLE) {
      throw new Error(error.message, { cause: error })
    }
    throw new Error("Could not remove address", { cause: error })
  }
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
    if (isAbort(error)) {
      return { ok: false, stage: "scan_failed", error: "Scan timed out" }
    }
    return { ok: false, stage: "scan_failed", error: UNREACHABLE }
  }
}

// ---- print queue ------------------------------------------------------------

export type PrintStatus = "queued" | "printing" | "done" | "failed"

export type PrintJob = {
  id: string
  name: string
  size: number
  owner: string
  mine: boolean
  status: PrintStatus
  error?: string
  created_at: number
  finished_at?: number
  /** 1-based place in line while queued; 0 while printing; null once finished. */
  position: number | null
  /** Two-sided was requested for this job. */
  duplex: boolean
}

export type PrintQueue = {
  bridge_online: boolean
  printing: string | null
  jobs: PrintJob[]
}

export const PRINT_MAX_BYTES = 25 * 1024 * 1024

async function printJson(res: Response): Promise<PrintQueue & { ok: boolean; error?: string; id?: string }> {
  const data = await readJson<PrintQueue & { ok: boolean; error?: string; id?: string }>(res)
  if (!res.ok || !data.ok) {
    throw new Error(data.error || `Print queue error (HTTP ${res.status})`)
  }
  return data
}

export async function fetchPrintQueue(): Promise<PrintQueue> {
  const res = await request("/api/print", { redirect: "manual" }, 8000)
  if (res.type === "opaqueredirect" || res.status === 401 || res.status === 403) {
    throw new Error(SIGNED_OUT)
  }
  return printJson(res)
}

/** Uploads one PDF. The body is the raw file; the name rides in a header. */
export async function uploadPrint(
  file: File,
  options: { duplex?: boolean } = {},
): Promise<PrintQueue & { id?: string }> {
  if (file.size > PRINT_MAX_BYTES) {
    throw new Error("PDFs up to 25 MB only")
  }
  // Uploads can be slow on office Wi-Fi; give them room.
  const res = await request(
    "/api/print",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/pdf",
        "X-File-Name": encodeURIComponent(file.name),
        // Only sent when asked for, so the default stays one-sided.
        ...(options.duplex ? { "X-Duplex": "1" } : {}),
      },
      body: file,
    },
    120_000,
  )
  return printJson(res)
}

/**
 * Removes a job. Cancels it while queued, clears it from the history once it
 * has finished. The Worker refuses only a job on the printer right now.
 */
export async function cancelPrint(id: string): Promise<PrintQueue> {
  const res = await request(`/api/print?id=${encodeURIComponent(id)}`, { method: "DELETE" })
  return printJson(res)
}

/** Clears one entry from the scan log, keyed on its start time. */
export async function removeScan(at: number): Promise<void> {
  const res = await request(`/api/scan?at=${encodeURIComponent(String(at))}`, { method: "DELETE" })
  if (res.status === 401 || res.status === 403) {
    throw new Error(SIGNED_OUT)
  }
  const body = await readJson<{ ok?: boolean; error?: string }>(res)
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || "Could not remove that scan")
  }
}
