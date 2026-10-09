export type ScanLog = {
  at: number
  name: string
  stage: string
  recipients: string[]
  error?: string
  /** Set while the scan waits for its pages to be checked. The id to review it by. */
  review?: string
  /** When the held scan expires unsent, in milliseconds. */
  expires?: number
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
    /** It will wait for its pages to be checked rather than be mailed. */
    review?: boolean
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
  stage?: "scan_failed" | "mail_failed" | "sent" | "saved" | "awaiting_review"
  scanned?: boolean
  error?: string
  files?: string[]
  recipients?: string[]
  emailed?: boolean
  log?: string[]
  /** The held scan's id, when the stage is awaiting_review. */
  review?: string
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

/**
 * `fresh` asks the bridge to report first, so the answer is what the printer
 * says now rather than up to a minute ago. The Worker waits up to 8 s for
 * that report, hence the longer timeout.
 */
export async function fetchState({ fresh = false }: { fresh?: boolean } = {}): Promise<PrinterState> {
  try {
    // Do not chase a redirect: Access answers an expired session with a 302 to
    // its own login host, and following that cross-origin fails CORS, which
    // used to surface as "Printer unreachable" — the wrong diagnosis entirely.
    const res = await request(fresh ? "/api/state?fresh=1" : "/api/state", { redirect: "manual" }, fresh ? 12000 : 4000)
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

/**
 * review: hold the PDF for its pages to be checked instead of mailing it on arrival.
 * to: which of the saved recipients get it. The Worker refuses anyone else.
 */
export async function runScan(
  source: "auto" | "platen" | "adf",
  { review = false, to }: { review?: boolean; to: string[] }
): Promise<ScanResult> {
  try {
    const res = await request(
      "/api/scan",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, review, to }),
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

// ---- scans held for review --------------------------------------------------

/**
 * One call to /api/review. The Worker's own message wins when it sent one;
 * a dropped connection or a timeout becomes `fallback` rather than the
 * browser's "Failed to fetch".
 */
async function reviewCall<T>(
  fallback: string,
  call: () => Promise<Response>,
  read: (res: Response) => Promise<T>
): Promise<T> {
  let res: Response
  try {
    res = await call()
  } catch (error) {
    const why = isAbort(error) ? "it took too long" : "the desk could not reach the server"
    throw new Error(`${fallback}: ${why}`, { cause: error })
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(SIGNED_OUT)
  }
  if (!res.ok) {
    const body = await readJson<{ error?: string }>(res).catch(() => ({ error: undefined }))
    throw new Error(body.error || `${fallback} (HTTP ${res.status})`)
  }
  return read(res)
}

/** The held PDF, exactly as scanned. A feeder scan can be 20 MB, hence the wait. */
export function fetchReviewPdf(id: string): Promise<ArrayBuffer> {
  return reviewCall(
    "Could not load the scan",
    () => request(`/api/review?id=${encodeURIComponent(id)}`, {}, 60_000),
    (res) => res.arrayBuffer()
  )
}

/**
 * Mails a held scan to `to`. `rotate` is one clockwise angle per page, in
 * page order, in steps of 90. The Worker turns the pages itself, so only the
 * angles travel; all zeros sends the scan exactly as it came off the scanner.
 */
export function sendReview(id: string, rotate: number[], to: string[]): Promise<ScanResult> {
  return reviewCall(
    "Could not send the scan",
    () =>
      request(
        "/api/review",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, rotate, to }),
        },
        120_000
      ),
    (res) => readJson<ScanResult>(res)
  )
}

/** Throws a held scan away unsent. */
export async function discardReview(id: string): Promise<void> {
  await reviewCall(
    "Could not discard the scan",
    () => request(`/api/review?id=${encodeURIComponent(id)}`, { method: "DELETE" }),
    async () => undefined
  )
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

/** Clears every finished job of yours from the history. Queued ones stay. */
export async function clearPrintHistory(): Promise<PrintQueue> {
  const res = await request("/api/print?all=1", { method: "DELETE" })
  return printJson(res)
}

async function deleteScans(query: string, fallback: string): Promise<void> {
  const res = await request(`/api/scan?${query}`, { method: "DELETE" })
  if (res.status === 401 || res.status === 403) {
    throw new Error(SIGNED_OUT)
  }
  const body = await readJson<{ ok?: boolean; error?: string }>(res)
  if (!res.ok || body.ok === false) {
    throw new Error(body.error || fallback)
  }
}

/** Clears one entry from the scan log, keyed on its start time. */
export function removeScan(at: number): Promise<void> {
  return deleteScans(`at=${encodeURIComponent(String(at))}`, "Could not remove that scan")
}

/** Clears every scan of yours from the log. */
export function clearScans(): Promise<void> {
  return deleteScans("all=1", "Could not clear the scans")
}
