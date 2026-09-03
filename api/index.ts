import { DurableObject } from "cloudflare:workers";

import { accessConfig, verifyAccess } from "./access";
import { sendSmtp } from "./smtp";

export type Env = {
  PRINTER_API: DurableObjectNamespace<PrinterApi>;
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASSWORD: string;
  SMTP_FROM_EMAIL: string;
  SMTP_FROM_NAME: string;
  BRIDGE_TOKEN: string;
  PRINTER_HOST: string;
  CORS_ORIGINS: string;
  /* Cloudflare Access. Both must be set or every /api/* route refuses. */
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  /* Local development only, set in .dev.vars, which is never deployed.
     Lets an unauthenticated caller through when Access is absent. */
  ALLOW_ANONYMOUS_DEV?: string;
  /* Who owned the single shared recipient list before it was namespaced. */
  LEGACY_RECIPIENTS_OWNER: string;
  /* Uploaded PDFs, keyed print:<job id>. Deleted once the job finishes. */
  PRINT_FILES: KVNamespace;
};

type Job = {
  id: string;
  source: string;
  /* Captured when the scan is queued, not when it finishes: the recipient
     list belongs to the person who started it, and completion now runs on
     the bridge's request where there is no signed-in actor to look up. */
  recipients: string[];
  startedAt: number;
  resolve: (outcome: ScanOutcome) => void;
};

type ScanResult = { pdf?: Uint8Array; error?: string };

/* What the browser is told, and what is recorded, once a scan finishes. */
type ScanOutcome = {
  ok: boolean;
  stage: string;
  scanned: boolean;
  emailed: boolean;
  error?: string;
  files?: string[];
  recipients?: string[];
};

type PrintStatus = "queued" | "printing" | "done" | "failed";

type PrintJob = {
  id: string;
  owner: string;
  name: string;
  size: number;
  createdAt: number;
  status: PrintStatus;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  /* Two-sided. The printer confirms it supports it: an IPP Validate-Job with
     sides=two-sided-long-edge returns successful-ok. */
  duplex?: boolean;
};

const PRINT_MAX_BYTES = 25 * 1024 * 1024; // KV's per-value ceiling
const PRINT_FILE_TTL_S = 24 * 60 * 60; // safety net if a delete is ever missed
const PRINT_STALE_MS = 15 * 60 * 1000; // relay plus the printer finishing; longer than that, the bridge is gone
const PRINT_HISTORY = 20;

type ScanLog = {
  at: number;
  name: string;
  stage: string;
  recipients: string[];
  error?: string;
};

type Supplies = {
  online: boolean;
  status: string;
  model?: string;
  serial?: string;
  pages?: number | null;
  uptime_ticks?: number;
  console?: string;
  toners: Array<{ name: string; pct: number | null; color: string }>;
  trays: Array<{ name: string; capacity: number; level: number; pct: number | null; status: string }>;
  alerts: Array<{ severity: string; desc: string }>;
  checked_at: number;
};

const WORKSPACE = [
  "alwin@nexdash.com",
  "parth@nexdash.com",
  "esteban@nexdash.com",
  "elisa@nexdash.com",
  "franck@nexdash.com",
  "michael@nexdash.com",
  "karsten@nexdash.com",
  "gabriel@nexdash.com",
  "berit@nexdash.com",
];

function allowedOrigin(origin: string, extra: string): boolean {
  if (origin === "https://printer-dashboard.pages.dev") {
    return true;
  }
  if (/^https:\/\/[a-z0-9]+\.printer-dashboard\.pages\.dev$/.test(origin)) {
    return true;
  }
  if (origin.startsWith("http://127.0.0.1:") || origin.startsWith("http://localhost:")) {
    return true;
  }
  return extra
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .includes(origin);
}

function corsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const origin = request.headers.get("Origin") || "";
  if (allowedOrigin(origin, env.CORS_ORIGINS || "")) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Vary", "Origin");
    headers.set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, X-File-Name");
  }
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("X-Frame-Options", "DENY");
  return headers;
}

function json(request: Request, env: Env, status: number, body: unknown): Response {
  const headers = corsHeaders(request, env);
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), { status, headers });
}

function withoutSender(list: string[], sender: string): string[] {
  const seen: Record<string, boolean> = {};
  const out: string[] = [];
  const from = sender.toLowerCase();
  for (const raw of list) {
    const email = raw.trim().toLowerCase();
    if (!email || email === from || seen[email]) {
      continue;
    }
    seen[email] = true;
    out.push(email);
  }
  return out;
}

/** Anything that changes state or physically drives the printer. */

/**
 * Answering before a request body has been read leaves the stream dangling,
 * and workerd then fails the whole Durable Object with "can't read from
 * request stream after response has been sent". Every early exit on a request
 * that may carry a body goes through here first.
 */
async function discardBody(request: Request): Promise<void> {
  if (request.body && !request.bodyUsed) {
    // Awaited on purpose: fired-and-forgotten it races the response and workerd
    // still logs the dangling stream.
    await request.body.cancel().catch(() => undefined);
  }
}

function bearerOk(request: Request, token: string): boolean {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ") || !token) {
    return false;
  }
  const got = header.slice("Bearer ".length).trim();
  const enc = new TextEncoder();
  const a = enc.encode(got);
  const b = enc.encode(token);
  if (a.byteLength !== b.byteLength) {
    return false;
  }
  return crypto.subtle.timingSafeEqual(a, b);
}

export class PrinterApi extends DurableObject<Env> {
  private queued: Job | null = null;
  private active: Job | null = null;
  private lastSeen = 0;
  private pollWaiters: Array<() => void> = [];

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request, this.env) });
    }
    const url = new URL(request.url);

    // /api/* is the human surface and is gated by Cloudflare Access. /bridge/*
    // is the ESP8266, which cannot do SSO and carries BRIDGE_TOKEN instead.
    // /health stays open so uptime checks work.
    // Empty when Access is not in front (local dev). Recipients then fall back
    // to the shared pre-namespace list rather than vanishing.
    let actor = "";
    if (url.pathname.startsWith("/api/")) {
      const cfg = accessConfig(this.env);
      if (cfg) {
        const verdict = await verifyAccess(request, cfg);
        if (!verdict.ok) {
          await discardBody(request);
          return json(request, this.env, 403, { ok: false, error: "forbidden" });
        }
        actor = verdict.email.trim().toLowerCase();
      } else if (this.env.ALLOW_ANONYMOUS_DEV !== "1") {
        // No Access config means nobody can be identified. That is a broken
        // deployment, not a public one, so refuse the whole surface rather
        // than let reads through: /api/state and /api/emails carry the
        // printer's state and every recipient address somebody saved.
        // Local development opts out through .dev.vars, which never ships.
        await discardBody(request);
        return json(request, this.env, 503, {
          ok: false,
          error: "authentication is not configured on this server",
        });
      }
    }

    switch (url.pathname) {
      case "/health":
        return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
      case "/api/state":
        return this.handleState(request, actor);
      case "/api/emails":
        return this.handleEmails(request, actor);
      case "/api/scan":
        return this.handleScan(request, actor);
      case "/api/print":
        return this.handlePrint(request, actor);
      case "/bridge/print/next":
        return this.handlePrintNext(request);
      case "/bridge/print/file":
        return this.handlePrintFile(request);
      case "/bridge/print/result":
        return this.handlePrintResult(request);
      case "/bridge/poll":
        return this.handlePoll(request);
      case "/bridge/result":
        return this.handleResult(request);
      case "/bridge/telemetry":
        return this.handleTelemetry(request);
      default:
        return json(request, this.env, 404, { ok: false, error: "not found" });
    }
  }

  /** Recipient lists are per signed-in person; "emails" is the pre-namespace list. */
  private emailsKey(actor: string): string {
    return actor ? `emails:${actor}` : "emails";
  }

  private async emails(actor: string): Promise<string[]> {
    const key = this.emailsKey(actor);
    const own = await this.ctx.storage.get<string[]>(key);
    if (own) {
      return own;
    }
    // The shared list predates namespacing, so it belongs to whoever owned it.
    // Moved once, on that person's first read, then the old key is gone.
    const owner = (this.env.LEGACY_RECIPIENTS_OWNER || "").trim().toLowerCase();
    if (actor && owner && actor === owner) {
      const legacy = await this.ctx.storage.get<string[]>("emails");
      if (legacy && legacy.length) {
        await this.ctx.storage.put(key, legacy);
        await this.ctx.storage.delete("emails");
        return legacy;
      }
    }
    return [];
  }

  private async handleState(request: Request, actor: string): Promise<Response> {
    const from = (this.env.SMTP_FROM_EMAIL || "").toLowerCase();
    const online = this.lastSeen > 0 && Date.now() - this.lastSeen < 45_000;
    return json(request, this.env, 200, {
      printer_host: this.env.PRINTER_HOST || "192.168.68.52",
      model: "Xerox B305 MFP",
      scanner: online ? "Idle" : "unreachable",
      adf: "unknown",
      scan_dir: "",
      from_email: this.env.SMTP_FROM_EMAIL || null,
      from_name: this.env.SMTP_FROM_NAME || null,
      ses_region: this.env.SMTP_HOST || "smtp.gmail.com",
      emails: withoutSender(await this.emails(actor), from),
      workspace_emails: withoutSender(WORKSPACE, from),
      web_ui: `http://${this.env.PRINTER_HOST || "192.168.68.52"}/`,
      bridge_online: online,
      scans: await this.scanLog(),
      supplies: await this.supplies(),
      // So a reopened tab can show a scan that is still running. The scan
      // itself never depended on the page being open; only the view of it did.
      scan_in_progress: this.active
        ? { stage: "scanning", since: this.active.startedAt, source: this.active.source }
        : this.queued
          ? { stage: "waiting", since: this.queued.startedAt, source: this.queued.source }
          : null,
    });
  }

  private async supplies(): Promise<Supplies | null> {
    return (await this.ctx.storage.get<Supplies>("supplies")) ?? null;
  }

  private async scanLog(): Promise<ScanLog[]> {
    return (await this.ctx.storage.get<ScanLog[]>("scans")) ?? [];
  }

  private async recordScan(entry: ScanLog): Promise<void> {
    const next = [entry, ...(await this.scanLog())].slice(0, 20);
    await this.ctx.storage.put("scans", next);
  }

  private async handleEmails(request: Request, actor: string): Promise<Response> {
    const current = await this.emails(actor);
    const from = (this.env.SMTP_FROM_EMAIL || "").toLowerCase();
    if (request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { email?: string };
      const email = (body.email || "").trim().toLowerCase();
      if (!email.includes("@")) {
        return json(request, this.env, 400, { ok: false, error: "not an email address" });
      }
      if (email === from) {
        return json(request, this.env, 400, { ok: false, error: `${email} is the sender, not a recipient` });
      }
      const next = current.includes(email) ? current : [...current, email];
      await this.ctx.storage.put(this.emailsKey(actor), next);
      return json(request, this.env, 200, { ok: true, emails: next, added: next.length !== current.length });
    }
    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const email = (url.searchParams.get("email") || "").trim().toLowerCase();
      const next = current.filter((item) => item !== email);
      await this.ctx.storage.put(this.emailsKey(actor), next);
      return json(request, this.env, 200, { ok: true, emails: next });
    }
    return json(request, this.env, 405, { ok: false, error: "method not allowed" });
  }

  private async handleScan(request: Request, actor: string): Promise<Response> {
    // Clearing one entry out of the scan log. Keyed on `at`, the scan's start
    // in milliseconds, because a ScanLog has no id and never has: it is a
    // desk log, so the timestamp is the handle the dashboard already uses.
    //
    // The log is shared rather than per-user, unlike recipients. Everyone at
    // this desk sees the same scans, so everyone can tidy them.
    if (request.method === "DELETE") {
      const at = Number(new URL(request.url).searchParams.get("at") || "0");
      if (!Number.isFinite(at) || at <= 0) {
        return json(request, this.env, 400, { ok: false, error: "which scan?" });
      }
      const log = await this.scanLog();
      const next = log.filter((row) => row.at !== at);
      if (next.length === log.length) {
        return json(request, this.env, 404, { ok: false, error: "no such scan" });
      }
      await this.ctx.storage.put("scans", next);
      return json(request, this.env, 200, { ok: true, scans: next });
    }
    if (request.method !== "POST") {
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }
    const body = ((await request.json().catch(() => ({}))) || {}) as { source?: string };
    const source = body.source || "platen";
    const from = (this.env.SMTP_FROM_EMAIL || "").toLowerCase();
    const recipients = withoutSender(await this.emails(actor), from);
    if (this.queued || this.active) {
      return json(request, this.env, 200, {
        ok: false,
        stage: "scan_failed",
        scanned: false,
        emailed: false,
        error: "bridge is busy",
      });
    }
    if (!(this.lastSeen > 0 && Date.now() - this.lastSeen < 45_000)) {
      return json(request, this.env, 200, {
        ok: false,
        stage: "scan_failed",
        scanned: false,
        emailed: false,
        error: "printer unreachable and the office bridge is not connected",
      });
    }
    // The browser's request is only a viewer. Queue the work, then wait to
    // report it -- the recording and the mail happen on the bridge's request
    // in finishScan, so closing this tab cannot lose them.
    const outcome = await new Promise<ScanOutcome>((resolve) => {
      const id = new Date().toISOString().slice(11, 23);
      const startedAt = Date.now();
      const timer = setTimeout(() => {
        const job = this.active?.id === id ? this.active : this.queued?.id === id ? this.queued : null;
        if (this.active?.id === id) {
          this.active = null;
        }
        if (this.queued?.id === id) {
          this.queued = null;
        }
        // Record it even if nobody is watching, so a scan that never came
        // back leaves a trace in the log rather than vanishing.
        const failed: ScanOutcome = {
          ok: false,
          stage: "scan_failed",
          scanned: false,
          emailed: false,
          error: "office bridge did not return a scan",
        };
        void this.recordScan({
          at: Date.now(),
          name: "",
          stage: "scan_failed",
          recipients: job?.recipients ?? recipients,
          error: failed.error,
        });
        resolve(failed);
      }, 180_000);
      this.queued = {
        id,
        source,
        recipients,
        startedAt,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      this.wakePoll();
    });
    return json(request, this.env, 200, outcome);
  }

  /**
   * Everything that happens once the pages are in: record it, and mail it.
   *
   * This runs on the bridge's request, not the browser's. It used to run in
   * the continuation of the page's own POST /api/scan, which meant closing
   * the tab mid-scan could abort the request that was going to send the
   * email -- the scan succeeded and the mail silently never left.
   */
  private async finishScan(job: Job, result: ScanResult): Promise<ScanOutcome> {
    const recipients = job.recipients;
    if (result.error || !result.pdf || result.pdf.byteLength === 0) {
      const error = result.error || "empty scan";
      await this.recordScan({ at: Date.now(), name: "", stage: "scan_failed", recipients, error });
      return { ok: false, stage: "scan_failed", scanned: false, emailed: false, error };
    }
    const name = `scan_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
    if (recipients.length === 0) {
      await this.recordScan({ at: Date.now(), name, stage: "saved", recipients });
      return { ok: true, stage: "saved", scanned: true, emailed: false, files: [name] };
    }
    try {
      await sendSmtp(
        {
          host: this.env.SMTP_HOST || "smtp.gmail.com",
          port: Number(this.env.SMTP_PORT || "587"),
          user: this.env.SMTP_USER || "",
          password: this.env.SMTP_PASSWORD || "",
          fromEmail: this.env.SMTP_FROM_EMAIL || "",
          fromName: this.env.SMTP_FROM_NAME || this.env.SMTP_FROM_EMAIL || "",
        },
        recipients,
        `Xerox scan ${name}`,
        "Scan from the Xerox B305.\n",
        result.pdf,
        name
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "mail failed";
      await this.recordScan({ at: Date.now(), name, stage: "mail_failed", recipients, error: message });
      return { ok: false, stage: "mail_failed", scanned: true, emailed: false, error: message, files: [name] };
    }
    await this.recordScan({ at: Date.now(), name, stage: "sent", recipients });
    return { ok: true, stage: "sent", scanned: true, emailed: true, files: [name], recipients };
  }

  // ---- print queue --------------------------------------------------------
  //
  // One queue for the whole desk, strictly ordered, one job printing at a
  // time. The Durable Object is a singleton so the lock is just "is anything
  // in the printing state". Everyone sees the queue — names included — so a
  // person waiting knows who is ahead of them and why.

  private async printJobs(): Promise<PrintJob[]> {
    return (await this.ctx.storage.get<PrintJob[]>("printJobs")) ?? [];
  }

  private async savePrintJobs(jobs: PrintJob[]): Promise<void> {
    // Keep the live jobs and a short tail of finished ones for the history list.
    const live = jobs.filter((j) => j.status === "queued" || j.status === "printing");
    const done = jobs
      .filter((j) => j.status === "done" || j.status === "failed")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .slice(0, PRINT_HISTORY);
    await this.ctx.storage.put("printJobs", [...live, ...done]);
  }

  /** A bridge that claimed a job and vanished must not block the queue forever. */
  private expireStalePrinting(jobs: PrintJob[], now: number): boolean {
    let changed = false;
    for (const job of jobs) {
      if (job.status === "printing" && now - (job.startedAt ?? now) > PRINT_STALE_MS) {
        job.status = "failed";
        job.finishedAt = now;
        job.error = "The printer bridge stopped responding mid-job.";
        changed = true;
      }
    }
    return changed;
  }

  private printView(jobs: PrintJob[], actor: string, now: number) {
    const queue = jobs
      .filter((j) => j.status === "queued" || j.status === "printing")
      .sort((a, b) => a.createdAt - b.createdAt);
    let position = 0;
    return {
      bridge_online: this.lastSeen > 0 && now - this.lastSeen < 45_000,
      printing: queue.find((j) => j.status === "printing")?.id ?? null,
      jobs: jobs
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((j) => ({
          id: j.id,
          name: j.name,
          size: j.size,
          owner: j.owner,
          mine: !actor || j.owner === actor,
          status: j.status,
          error: j.error,
          created_at: j.createdAt,
          finished_at: j.finishedAt,
          duplex: !!j.duplex,
          // 1-based place in line for queued jobs; 0 for the one printing
          position: j.status === "queued" ? ++position : j.status === "printing" ? 0 : null,
        })),
    };
  }

  private async handlePrint(request: Request, actor: string): Promise<Response> {
    const now = Date.now();
    const jobs = await this.printJobs();
    if (this.expireStalePrinting(jobs, now)) {
      await this.savePrintJobs(jobs);
    }

    if (request.method === "GET") {
      return json(request, this.env, 200, { ok: true, ...this.printView(jobs, actor, now) });
    }

    if (request.method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id") || "";
      const job = jobs.find((j) => j.id === id);
      if (!job) {
        return json(request, this.env, 404, { ok: false, error: "no such job" });
      }
      if (actor && job.owner !== actor) {
        return json(request, this.env, 403, { ok: false, error: "that is someone else's job" });
      }
      // Queued means cancel it. Done or failed means clear it from the
      // history. Only a job on the printer right now is refused: the bridge
      // is mid-relay and would post a result for something already gone.
      if (job.status === "printing") {
        return json(request, this.env, 409, { ok: false, error: "that job is already printing" });
      }
      await this.env.PRINT_FILES.delete(`print:${id}`);
      await this.savePrintJobs(jobs.filter((j) => j.id !== id));
      return json(request, this.env, 200, { ok: true, ...this.printView(jobs.filter((j) => j.id !== id), actor, now) });
    }

    if (request.method !== "POST") {
      await discardBody(request);
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }

    const declared = Number(request.headers.get("Content-Length") || "0");
    if (declared > PRINT_MAX_BYTES) {
      await discardBody(request);
      return json(request, this.env, 413, { ok: false, error: "PDFs up to 25 MB only" });
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength === 0) {
      return json(request, this.env, 400, { ok: false, error: "empty upload" });
    }
    if (bytes.byteLength > PRINT_MAX_BYTES) {
      return json(request, this.env, 413, { ok: false, error: "PDFs up to 25 MB only" });
    }
    // The printer speaks PDF. Check the magic bytes, not the filename.
    const head = String.fromCharCode(...bytes.subarray(0, 5));
    if (head !== "%PDF-") {
      return json(request, this.env, 415, {
        ok: false,
        error: "Only PDF prints. For anything else, press Ctrl+P and choose Save as PDF first.",
      });
    }
    const rawName = decodeURIComponent(request.headers.get("X-File-Name") || "document.pdf");
    const name = rawName.replace(/[\r\n]/g, " ").slice(0, 120) || "document.pdf";
    // Anything but an explicit "1" is one-sided, so a missing header keeps
    // the old behaviour rather than quietly changing what people get.
    const duplex = (request.headers.get("X-Duplex") || "") === "1";
    const id = crypto.randomUUID();
    await this.env.PRINT_FILES.put(`print:${id}`, bytes, { expirationTtl: PRINT_FILE_TTL_S });
    const job: PrintJob = {
      id,
      owner: actor,
      name,
      size: bytes.byteLength,
      createdAt: now,
      status: "queued",
      duplex,
    };
    jobs.push(job);
    await this.savePrintJobs(jobs);
    // Wake a bridge that is long-polling for work.
    for (const wake of this.pollWaiters.splice(0)) {
      wake();
    }
    return json(request, this.env, 201, { ok: true, id, ...this.printView(jobs, actor, now) });
  }

  /** Bridge: claim the next job. Refuses while one is printing — that is the lock. */
  private async handlePrintNext(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    this.lastSeen = Date.now();
    const now = Date.now();
    const jobs = await this.printJobs();
    const stale = this.expireStalePrinting(jobs, now);
    if (jobs.some((j) => j.status === "printing")) {
      if (stale) await this.savePrintJobs(jobs);
      return json(request, this.env, 200, { job: "" });
    }
    const next = jobs
      .filter((j) => j.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    if (!next) {
      if (stale) await this.savePrintJobs(jobs);
      return json(request, this.env, 200, { job: "" });
    }
    next.status = "printing";
    next.startedAt = now;
    await this.savePrintJobs(jobs);
    return json(request, this.env, 200, {
      job: next.id,
      name: next.name,
      size: next.size,
      // A string, not a number: the bridge's jsonField only reads quoted
      // values, so a bare 1 would parse as absent and duplex would silently
      // never happen.
      duplex: next.duplex ? "1" : "0",
      printer: this.env.PRINTER_HOST || "192.168.68.52",
    });
  }

  /** Bridge: the bytes for a claimed job, streamed so the ESP never holds the file. */
  private async handlePrintFile(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    this.lastSeen = Date.now();
    const id = new URL(request.url).searchParams.get("job") || "";
    const jobs = await this.printJobs();
    const job = jobs.find((j) => j.id === id && j.status === "printing");
    if (!job) {
      return json(request, this.env, 404, { ok: false, error: "no such printing job" });
    }
    const body = await this.env.PRINT_FILES.get(`print:${id}`, "stream");
    if (!body) {
      job.status = "failed";
      job.finishedAt = Date.now();
      job.error = "The file was gone before it could print.";
      await this.savePrintJobs(jobs);
      return json(request, this.env, 410, { ok: false, error: "file gone" });
    }
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Length": String(job.size),
        "Cache-Control": "no-store",
      },
    });
  }

  /** Bridge: job finished, one way or the other. The file goes either way. */
  private async handlePrintResult(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    this.lastSeen = Date.now();
    const url = new URL(request.url);
    const id = url.searchParams.get("job") || "";
    const errMsg = (url.searchParams.get("error") || "").slice(0, 200);
    const jobs = await this.printJobs();
    const job = jobs.find((j) => j.id === id);
    if (!job) {
      return json(request, this.env, 404, { ok: false, error: "no such job" });
    }
    job.status = errMsg ? "failed" : "done";
    job.finishedAt = Date.now();
    if (errMsg) job.error = errMsg;
    await this.env.PRINT_FILES.delete(`print:${id}`);
    await this.savePrintJobs(jobs);
    return json(request, this.env, 200, { ok: true });
  }

  private async handlePoll(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    this.lastSeen = Date.now();
    if (!this.queued) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20_000);
        this.pollWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.lastSeen = Date.now();
    if (!this.queued) {
      return json(request, this.env, 200, { job: "" });
    }
    this.active = this.queued;
    this.queued = null;
    return json(request, this.env, 200, {
      job: this.active.id,
      source: this.active.source,
      printer: this.env.PRINTER_HOST || "192.168.68.52",
    });
  }

  private async handleResult(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    this.lastSeen = Date.now();
    const url = new URL(request.url);
    const id = url.searchParams.get("job") || "";
    const errMsg = url.searchParams.get("error") || "";
    const length = Number(request.headers.get("Content-Length") || "0");
    if (length > 20 * 1024 * 1024) {
      return json(request, this.env, 413, { ok: false, error: "pdf too large" });
    }
    const buf = errMsg ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    const job = this.active && this.active.id === id ? this.active : this.queued && this.queued.id === id ? this.queued : null;
    if (job) {
      if (this.active?.id === id) {
        this.active = null;
      }
      if (this.queued?.id === id) {
        this.queued = null;
      }
      // Finish on this request, the bridge's, which is alive regardless of
      // what the browser did. The waiter -- if the page is still open -- is
      // handed the finished outcome rather than raw bytes.
      const outcome = await this.finishScan(job, errMsg ? { error: errMsg } : { pdf: buf });
      job.resolve(outcome);
    }
    return json(request, this.env, 200, { ok: true });
  }

  private async handleTelemetry(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    if (request.method !== "POST") {
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }
    this.lastSeen = Date.now();
    const body = (await request.json().catch(() => null)) as Supplies | null;
    if (!body || !Array.isArray(body.toners) || !Array.isArray(body.trays)) {
      return json(request, this.env, 400, { ok: false, error: "bad telemetry" });
    }
    const supplies: Supplies = {
      online: Boolean(body.online),
      status: String(body.status || "Unknown"),
      model: body.model,
      serial: body.serial,
      pages: body.pages ?? null,
      uptime_ticks: body.uptime_ticks,
      console: body.console,
      toners: body.toners.slice(0, 16),
      trays: body.trays.slice(0, 16),
      alerts: (body.alerts || []).slice(0, 32),
      checked_at: Number(body.checked_at) || Date.now() / 1000,
    };
    await this.ctx.storage.put("supplies", supplies);
    return json(request, this.env, 200, { ok: true });
  }

  private wakePoll(): void {
    const waiters = this.pollWaiters;
    this.pollWaiters = [];
    for (const wake of waiters) {
      wake();
    }
  }
}

// Largest body any route accepts (a 25 MB print PDF), plus headroom.
const MAX_BODY_BYTES = 26 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Read the body here, before the Durable Object sees it. A stream handed
    // into the DO stays owned by this context, so when the DO answers early —
    // a 403 from the gate, a 405, a 413 — the unread stream dangles and workerd
    // logs "can't read from request stream after response has been sent" on
    // every one. Buffering once up front costs at most 26 MB and ends that.
    let forward = request;
    if (request.body) {
      const declared = Number(request.headers.get("Content-Length") || "0");
      if (declared > MAX_BODY_BYTES) {
        await request.body.cancel().catch(() => undefined);
        return new Response(JSON.stringify({ ok: false, error: "body too large" }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }
      const body = await request.arrayBuffer();
      forward = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: body.byteLength ? body : null,
      });
    }
    const id = env.PRINTER_API.idFromName("singleton");
    return env.PRINTER_API.get(id).fetch(forward);
  },
};
