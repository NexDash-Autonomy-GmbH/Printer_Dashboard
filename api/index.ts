import { DurableObject } from "cloudflare:workers";

import { accessConfig, verifyAccess } from "./access";
import { mailScan, serveScan } from "./mail";
import { parseTurns, rotatePages, unchanged } from "./pages";

export type Env = {
  PRINTER_API: DurableObjectNamespace<PrinterApi>;
  /* Cloudflare Email Sending, locked to noreply@nexdash.com in wrangler.jsonc. */
  EMAIL: SendEmail;
  MAIL_FROM_EMAIL: string;
  MAIL_FROM_NAME: string;
  /* Scans too big to attach, and the origin their links point at. */
  SCAN_FILES: KVNamespace;
  SCAN_LINK_BASE: string;
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
  /* Uploaded PDFs, keyed print:<job id>. Deleted once the job finishes.
     Also scans waiting for their owner to check the pages, keyed
     review:<id>, deleted once sent or discarded. */
  PRINT_FILES: KVNamespace;
};

type Job = {
  id: string;
  source: string;
  /* Captured when the scan is queued, not when it finishes: the recipient
     list belongs to the person who started it, and completion now runs on
     the bridge's request where there is no signed-in actor to look up. */
  recipients: string[];
  /* Who started it, for the same reason: the scan log is per person. */
  owner: string;
  /* "Check pages first" was chosen: hold the PDF for its owner instead of
     mailing it on arrival. Captured at queue time like the recipients. */
  review: boolean;
  startedAt: number;
  /* Where the job has got to. The Worker can only see two of these by
     itself -- queued, and claimed -- because the front door buffers request
     bodies, so by the time it handles the upload the upload is already over.
     The bridge reports the rest. */
  phase: "waiting" | "scanning" | "uploading" | "emailing";
  /* Size of the scan once the bridge knows it, for the dialog to show. */
  bytes?: number;
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
  /* The held scan's id, when the outcome is that it waits for review. */
  review?: string;
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
/* A scan this large is a fault, not a document. Enforced on bytes received. */
const MAX_SCAN_BYTES = 20 * 1024 * 1024;
const PRINT_FILE_TTL_S = 24 * 60 * 60; // safety net if a delete is ever missed
const PRINT_STALE_MS = 15 * 60 * 1000; // relay plus the printer finishing; longer than that, the bridge is gone
const PRINT_HISTORY = 20;
/* How long a scan waits for its pages to be checked. A day, like print
   uploads: long enough to come back to after a meeting or overnight. */
const REVIEW_TTL_S = 24 * 60 * 60;
/* A send takes seconds. A claim older than this belongs to a request that
   never came back, and must not block sending that scan forever. */
const REVIEW_SEND_STALE_MS = 2 * 60 * 1000;

type ScanLog = {
  at: number;
  name: string;
  stage: string;
  recipients: string[];
  error?: string;
  /* Who ran it. Missing on rows written before the log went per person;
     nobody signed in sees those, since there is no telling whose they are. */
  owner?: string;
  /* Set while the PDF waits in KV as review:<id> for its owner to send it.
     This row is what lets a closed tab come back to it: Scan jobs offers
     Review for as long as it is set. Cleared once sent or discarded. */
  review?: string;
  /* When KV lets go of that PDF, so the row can say it expired rather than
     offer a Review that finds nothing. */
  expires?: number;
};

/**
 * What the bridge reports about the printer.
 *
 * Only online, status and checked_at arrive now. The bridge stopped gathering
 * the rest when the Supplies screen was removed: it was 33 SNMP queries a
 * minute, plus a 32 KB parse off the printer's web interface whenever SNMP
 * went quiet, for numbers nothing read.
 *
 * The old fields stay declared, and optional, because rows written before that
 * change are still in storage and a reader must cope with either shape. A
 * bridge that starts sending them again needs no change here.
 */
type Supplies = {
  online: boolean;
  status: string;
  checked_at: number;
  /* The scanner's feeder, straight from eSCL: "ScannerAdfEmpty",
     "ScannerAdfLoaded" and so on. SNMP does not carry this. */
  adf?: string;
  model?: string;
  serial?: string;
  pages?: number | null;
  uptime_ticks?: number;
  console?: string;
  toners?: Array<{ name: string; pct: number | null; color: string }>;
  trays?: Array<{ name: string; capacity: number; level: number; pct: number | null; status: string }>;
  alerts?: Array<{ severity: string; desc: string }>;
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

/**
 * The addresses a page picked for one scan, checked against the ones it was
 * shown. Saved recipients used to all get every scan, so adding a second
 * address meant the first could no longer get a scan on its own.
 *
 * Only ever a subset: the page offers nothing else, so an address outside
 * `allowed` is a stale tab or a hand-made request, and is refused rather than
 * quietly dropped, which would mail fewer people than the page showed.
 */
function pickRecipients(
  to: unknown,
  allowed: string[],
  from: string
): { ok: true; recipients: string[] } | { ok: false; error: string } {
  if (!Array.isArray(to) || !to.every((item) => typeof item === "string")) {
    return { ok: false, error: "to is a list of addresses" };
  }
  const picked = withoutSender(to, from);
  const stray = picked.find((email) => !allowed.includes(email));
  if (stray) {
    return { ok: false, error: `${stray} is not one of your recipients` };
  }
  if (picked.length === 0 && allowed.length > 0) {
    return { ok: false, error: "pick at least one recipient" };
  }
  return { ok: true, recipients: picked };
}

/** A held scan whose PDF KV no longer has. Recorded as unsent, not deleted. */
function expire(row: ScanLog): void {
  row.stage = "expired";
  row.error = "Expired before it was sent";
  delete row.review;
  delete row.expires;
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
  /* Refresh was pressed: the next idle poll tells the bridge to report now. */
  private reportWanted = false;
  /* Pages waiting on that report, resolved by the next telemetry to arrive. */
  private telemetryWaiters: Array<() => void> = [];
  /* Held scans being sent right now, by id, with when the send began. A
     double-click, or a second tab, must not mail one scan twice. */
  private reviewSends = new Map<string, number>();

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
      case "/api/pick":
        return this.handlePick(request, actor);
      case "/api/scan":
        return this.handleScan(request, actor);
      case "/api/review":
        return this.handleReview(request, actor);
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
      case "/bridge/progress":
        return this.handleProgress(request);
      case "/bridge/telemetry":
        return this.handleTelemetry(request);
      case "/bridge/export":
        return this.handleExport(request);
      case "/bridge/import":
        return this.handleImport(request);
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

  /**
   * Who a person leaves off their scans, out of their saved recipients. Kept
   * here with the list rather than in the browser, so it holds across
   * sign-outs, reloads and devices until they change it. Stored as who is
   * left out, so an address added later is in by default.
   */
  private leftOutKey(actor: string): string {
    return actor ? `left_out:${actor}` : "left_out";
  }

  private async leftOut(actor: string): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>(this.leftOutKey(actor))) ?? [];
  }

  /** Drops `emails` from the left-out list. Adding or removing an address ends any pick on it. */
  private async unleave(actor: string, emails: string[]): Promise<void> {
    const current = await this.leftOut(actor);
    const next = current.filter((email) => !emails.includes(email));
    if (next.length !== current.length) {
      await this.ctx.storage.put(this.leftOutKey(actor), next);
    }
  }

  private async handlePick(request: Request, actor: string): Promise<Response> {
    if (request.method !== "POST") {
      await discardBody(request);
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }
    const body = (await request.json().catch(() => null)) as { left_out?: unknown } | null;
    const raw = body?.left_out;
    if (!Array.isArray(raw) || !raw.every((item) => typeof item === "string")) {
      return json(request, this.env, 400, { ok: false, error: "left_out is a list of addresses" });
    }
    // A preference, not a send, so an address no longer saved is dropped
    // rather than refused: a tab a few seconds behind should not fail.
    const saved = await this.emails(actor);
    const next = withoutSender(raw, "").filter((email) => saved.includes(email));
    await this.ctx.storage.put(this.leftOutKey(actor), next);
    return json(request, this.env, 200, { ok: true, left_out: next });
  }

  private async handleState(request: Request, actor: string): Promise<Response> {
    // ?fresh=1 is the Refresh button. Without it, the page could only ever
    // read what the bridge last sent, which is up to a minute old, so loading
    // the feeder and pressing Refresh changed nothing. With it, the bridge is
    // asked to report now and this answers once that report lands.
    const fresh = new URL(request.url).searchParams.get("fresh") === "1";
    if (fresh && this.lastSeen > 0 && Date.now() - this.lastSeen < 45_000) {
      await this.awaitReport(8_000);
    }
    const from = (this.env.MAIL_FROM_EMAIL || "").toLowerCase();
    const online = this.lastSeen > 0 && Date.now() - this.lastSeen < 45_000;
    const emails = withoutSender(await this.emails(actor), from);
    const leftOut = (await this.leftOut(actor)).filter((email) => emails.includes(email));
    return json(request, this.env, 200, {
      printer_host: this.env.PRINTER_HOST || "192.168.68.52",
      model: "Xerox B305 MFP",
      scanner: online ? "Idle" : "unreachable",
      // Was hardcoded "unknown", which the Scan screen reads as "cannot tell"
      // -- so its guard against starting a feeder scan with an empty tray
      // never fired. The bridge reports it now; "unknown" is only the answer
      // when nothing has been heard yet.
      adf: (await this.supplies())?.adf || "unknown",
      scan_dir: "",
      from_email: this.env.MAIL_FROM_EMAIL || null,
      from_name: this.env.MAIL_FROM_NAME || null,
      ses_region: "Cloudflare Email Sending",
      emails,
      left_out: leftOut,
      workspace_emails: withoutSender(WORKSPACE, from),
      web_ui: `http://${this.env.PRINTER_HOST || "192.168.68.52"}/`,
      bridge_online: online,
      scans: this.ownScans(await this.liveScanLog(), actor),
      supplies: await this.supplies(),
      // So a reopened tab can show a scan that is still running. The scan
      // itself never depended on the page being open; only the view of it did.
      // `review` so that view can say the scan will wait rather than promise
      // an email that is not going to leave on its own.
      scan_in_progress: this.active
        ? {
            stage: this.active.phase,
            since: this.active.startedAt,
            source: this.active.source,
            bytes: this.active.bytes ?? null,
            review: this.active.review,
          }
        : this.queued
          ? {
              stage: this.queued.phase,
              since: this.queued.startedAt,
              source: this.queued.source,
              bytes: null,
              review: this.queued.review,
            }
          : null,
    });
  }

  private async supplies(): Promise<Supplies | null> {
    return (await this.ctx.storage.get<Supplies>("supplies")) ?? null;
  }

  private async scanLog(): Promise<ScanLog[]> {
    return (await this.ctx.storage.get<ScanLog[]>("scans")) ?? [];
  }

  /**
   * The log with any held scan past its KV lifetime marked expired first.
   *
   * KV drops the PDF on its own and tells nobody, so without this the row
   * would go on offering a Review that finds nothing. Expired is recorded,
   * not deleted: the scan was never sent, and the list should say so.
   */
  private async liveScanLog(): Promise<ScanLog[]> {
    const log = await this.scanLog();
    const now = Date.now();
    let changed = false;
    for (const row of log) {
      if (row.review && (row.expires ?? 0) <= now) {
        expire(row);
        changed = true;
      }
    }
    if (changed) {
      await this.ctx.storage.put("scans", log);
    }
    return log;
  }

  /** What one person sees of the log. No actor is local dev: everything. */
  private ownScans(log: ScanLog[], actor: string): ScanLog[] {
    return log.filter((row) => !actor || row.owner === actor);
  }

  private async recordScan(entry: ScanLog): Promise<void> {
    // The last 20 per person, so one busy colleague cannot push everyone
    // else's scans out of a log they can no longer see.
    //
    // A scan still waiting for review is kept regardless and does not count
    // toward the 20. Its row is the only way back to it, so trimming the row
    // would strand an unsent scan in KV with nothing pointing at it.
    const kept = new Map<string, number>();
    const next = [entry, ...(await this.scanLog())].filter((row) => {
      if (row.review) {
        return true;
      }
      const n = kept.get(row.owner ?? "") ?? 0;
      kept.set(row.owner ?? "", n + 1);
      return n < 20;
    });
    await this.ctx.storage.put("scans", next);
  }

  private async handleEmails(request: Request, actor: string): Promise<Response> {
    const current = await this.emails(actor);
    const from = (this.env.MAIL_FROM_EMAIL || "").toLowerCase();
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
      // Added means wanted, even if it was left out before it was removed.
      await this.unleave(actor, [email]);
      return json(request, this.env, 200, { ok: true, emails: next, added: next.length !== current.length });
    }
    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const email = (url.searchParams.get("email") || "").trim().toLowerCase();
      const next = current.filter((item) => item !== email);
      await this.ctx.storage.put(this.emailsKey(actor), next);
      await this.unleave(actor, [email]);
      return json(request, this.env, 200, { ok: true, emails: next });
    }
    return json(request, this.env, 405, { ok: false, error: "method not allowed" });
  }

  private async handleScan(request: Request, actor: string): Promise<Response> {
    // Clearing one entry out of the scan log. Keyed on `at`, the scan's start
    // in milliseconds, because a ScanLog has no id and never has: the
    // timestamp is the handle the dashboard already uses.
    //
    // The log is per person, like recipients, so only your own rows can be
    // cleared. Someone else's is a 404, not a 403: it is not yours to know of.
    if (request.method === "DELETE") {
      const params = new URL(request.url).searchParams;
      const log = await this.scanLog();
      const mine = (row: ScanLog) => !actor || row.owner === actor;
      // Clear all: every row of yours. Nothing to clear is not an error.
      // Scans still waiting for review stay, the way print's clear-all leaves
      // queued jobs: tidying the history must not throw away a scan nobody
      // has sent yet.
      if (params.get("all") === "1") {
        const next = log.filter((row) => !mine(row) || row.review);
        await this.ctx.storage.put("scans", next);
        return json(request, this.env, 200, { ok: true, scans: this.ownScans(next, actor) });
      }
      const at = Number(params.get("at") || "0");
      if (!Number.isFinite(at) || at <= 0) {
        return json(request, this.env, 400, { ok: false, error: "which scan?" });
      }
      const gone = log.filter((row) => row.at === at && mine(row));
      const next = log.filter((row) => !gone.includes(row));
      if (gone.length === 0) {
        return json(request, this.env, 404, { ok: false, error: "no such scan" });
      }
      if (gone.some((row) => row.review && this.sendClaimed(row.review))) {
        return json(request, this.env, 409, { ok: false, error: "that scan is being sent right now" });
      }
      // One row asked for by name is a deliberate discard, so a held PDF goes
      // with it rather than sitting in KV until it expires.
      await Promise.all(
        gone.filter((row) => row.review).map((row) => this.env.PRINT_FILES.delete(`review:${row.review}`))
      );
      await this.ctx.storage.put("scans", next);
      return json(request, this.env, 200, { ok: true, scans: this.ownScans(next, actor) });
    }
    if (request.method !== "POST") {
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }
    const body = ((await request.json().catch(() => ({}))) || {}) as {
      source?: string;
      review?: boolean;
      to?: unknown;
    };
    const source = body.source || "platen";
    // Only an explicit true holds the scan. Anything else, including a page
    // that predates review, keeps the old behaviour: mailed on arrival.
    const review = body.review === true;
    const from = (this.env.MAIL_FROM_EMAIL || "").toLowerCase();
    const saved = withoutSender(await this.emails(actor), from);
    // No `to` is a page from before recipients could be picked: everyone.
    const picked =
      body.to === undefined ? { ok: true as const, recipients: saved } : pickRecipients(body.to, saved, from);
    if (!picked.ok) {
      return json(request, this.env, 200, {
        ok: false,
        stage: "scan_failed",
        scanned: false,
        emailed: false,
        error: picked.error,
      });
    }
    const recipients = picked.recipients;
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
          owner: actor,
        });
        resolve(failed);
      }, 180_000);
      this.queued = {
        id,
        source,
        recipients,
        owner: actor,
        review,
        startedAt,
        phase: "waiting",
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
    const owner = job.owner;
    job.phase = "emailing";
    if (result.error || !result.pdf || result.pdf.byteLength === 0) {
      const error = result.error || "empty scan";
      await this.recordScan({ at: Date.now(), name: "", stage: "scan_failed", recipients, error, owner });
      return { ok: false, stage: "scan_failed", scanned: false, emailed: false, error };
    }
    const name = `scan_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
    if (recipients.length === 0) {
      await this.recordScan({ at: Date.now(), name, stage: "saved", recipients, owner });
      return { ok: true, stage: "saved", scanned: true, emailed: false, files: [name] };
    }
    if (job.review) {
      const held = await this.holdForReview(name, recipients, owner, result.pdf);
      if (held) {
        return held;
      }
      // KV would not take it. Mailing it as scanned is the lesser failure:
      // sideways pages in an inbox beat a scan that went nowhere, and the
      // Scan screen promises that a scan is never lost to a closed tab.
    }
    try {
      await mailScan(this.env, recipients, name, result.pdf);
    } catch (error) {
      const message = error instanceof Error ? error.message : "mail failed";
      await this.recordScan({ at: Date.now(), name, stage: "mail_failed", recipients, error: message, owner });
      return { ok: false, stage: "mail_failed", scanned: true, emailed: false, error: message, files: [name] };
    }
    await this.recordScan({ at: Date.now(), name, stage: "sent", recipients, owner });
    return { ok: true, stage: "sent", scanned: true, emailed: true, files: [name], recipients };
  }

  // ---- review -------------------------------------------------------------
  //
  // A scan started with "Check pages first" is not mailed when it arrives.
  // finishScan parks the PDF in KV as review:<id> and logs a row carrying
  // that id. Its owner fetches the PDF to preview it, then sends it, turned
  // or exactly as scanned, or discards it. None of this needs the tab that
  // started the scan: any tab of the owner's picks it up from Scan jobs
  // until it expires.
  //
  // Private like the rest of the scan log. Someone else's held scan is a 404,
  // not a 403: it is not yours to know of.

  /** Parks a finished scan for its owner. null when KV would not take it. */
  private async holdForReview(
    name: string,
    recipients: string[],
    owner: string,
    pdf: Uint8Array
  ): Promise<ScanOutcome | null> {
    const id = crypto.randomUUID();
    try {
      await this.env.PRINT_FILES.put(`review:${id}`, pdf, { expirationTtl: REVIEW_TTL_S });
    } catch {
      return null;
    }
    const at = Date.now();
    await this.recordScan({
      at,
      name,
      stage: "awaiting_review",
      recipients,
      owner,
      review: id,
      expires: at + REVIEW_TTL_S * 1000,
    });
    return { ok: true, stage: "awaiting_review", scanned: true, emailed: false, files: [name], recipients, review: id };
  }

  /** The caller's scan waiting under this id, or null. Someone else's is null too. */
  private async heldScan(id: string, actor: string): Promise<ScanLog | null> {
    if (!id) {
      return null;
    }
    const log = await this.liveScanLog();
    return log.find((row) => row.review === id && (!actor || row.owner === actor)) ?? null;
  }

  /**
   * Rewrites a held scan's row. Re-reads the log rather than reusing a copy:
   * a send takes seconds, and other scans may have been logged meanwhile.
   */
  private async settleReview(id: string, change: (row: ScanLog) => void): Promise<ScanLog[]> {
    const log = await this.scanLog();
    const row = log.find((item) => item.review === id);
    if (row) {
      change(row);
      await this.ctx.storage.put("scans", log);
    }
    return log;
  }

  private sendClaimed(id: string): boolean {
    const since = this.reviewSends.get(id);
    return since !== undefined && Date.now() - since < REVIEW_SEND_STALE_MS;
  }

  private async handleReview(request: Request, actor: string): Promise<Response> {
    if (request.method === "GET" || request.method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id") || "";
      const row = await this.heldScan(id, actor);
      if (!row) {
        return json(request, this.env, 404, { ok: false, error: "no scan of yours is waiting under that id" });
      }
      if (request.method === "GET") {
        const pdf = await this.env.PRINT_FILES.get(`review:${id}`, "stream");
        if (!pdf) {
          await this.settleReview(id, expire);
          return json(request, this.env, 410, { ok: false, error: "that scan has expired" });
        }
        const headers = corsHeaders(request, this.env);
        headers.set("Content-Type", "application/pdf");
        headers.set("Cache-Control", "no-store");
        return new Response(pdf, { status: 200, headers });
      }
      if (this.sendClaimed(id)) {
        return json(request, this.env, 409, { ok: false, error: "that scan is being sent right now" });
      }
      await this.env.PRINT_FILES.delete(`review:${id}`);
      const log = await this.settleReview(id, (item) => {
        item.stage = "discarded";
        delete item.error;
        delete item.review;
        delete item.expires;
      });
      return json(request, this.env, 200, { ok: true, scans: this.ownScans(log, actor) });
    }
    if (request.method !== "POST") {
      await discardBody(request);
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }

    const body = (await request.json().catch(() => null)) as { id?: unknown; rotate?: unknown; to?: unknown } | null;
    const id = typeof body?.id === "string" ? body.id : "";
    const turns = parseTurns(body?.rotate);
    if (!turns) {
      return json(request, this.env, 400, { ok: false, error: "rotate is one angle per page, in steps of 90" });
    }
    const row = await this.heldScan(id, actor);
    if (!row) {
      return json(request, this.env, 404, { ok: false, error: "no scan of yours is waiting under that id" });
    }
    // Who it goes to can still change here. The review shows the ones picked
    // at scan time plus the rest of the saved list, so either can be sent to.
    // No `to` keeps the ones picked at scan time.
    let recipients = row.recipients;
    if (body?.to !== undefined) {
      const from = (this.env.MAIL_FROM_EMAIL || "").toLowerCase();
      const allowed = withoutSender([...row.recipients, ...(await this.emails(actor))], from);
      const picked = pickRecipients(body.to, allowed, from);
      if (!picked.ok) {
        return json(request, this.env, 400, { ok: false, error: picked.error });
      }
      recipients = picked.recipients;
    }
    if (this.sendClaimed(id)) {
      return json(request, this.env, 409, { ok: false, error: "that scan is already being sent" });
    }
    this.reviewSends.set(id, Date.now());
    try {
      return await this.sendHeld(request, actor, id, row, turns, recipients);
    } finally {
      this.reviewSends.delete(id);
    }
  }

  private async sendHeld(
    request: Request,
    actor: string,
    id: string,
    row: ScanLog,
    turns: number[],
    recipients: string[]
  ): Promise<Response> {
    const held = await this.env.PRINT_FILES.get(`review:${id}`, "arrayBuffer");
    if (!held) {
      await this.settleReview(id, expire);
      return json(request, this.env, 410, { ok: false, error: "that scan has expired" });
    }
    let pdf: Uint8Array = new Uint8Array(held);
    // Nothing turned means the exact bytes the scanner produced go out: no
    // parse and no rewrite, so the unchanged path cannot be broken by the
    // rotating one.
    if (!unchanged(turns)) {
      try {
        pdf = await rotatePages(pdf, turns);
      } catch (error) {
        const message = error instanceof Error ? error.message : "unreadable PDF";
        return json(request, this.env, 422, {
          ok: false,
          error: `Could not turn the pages (${message}). It can still be sent as scanned.`,
        });
      }
    }
    try {
      await mailScan(this.env, recipients, row.name, pdf);
    } catch (error) {
      const message = error instanceof Error ? error.message : "mail failed";
      // Still held, so the same scan can be sent again once mail works
      // instead of being rescanned. To the same people: the retry opens
      // with this pick, not the one made at scan time.
      const log = await this.settleReview(id, (item) => {
        item.stage = "mail_failed";
        item.error = message;
        item.recipients = recipients;
      });
      return json(request, this.env, 502, {
        ok: false,
        stage: "mail_failed",
        scanned: true,
        emailed: false,
        error: message,
        files: [row.name],
        scans: this.ownScans(log, actor),
      });
    }
    // Mail first, then let go of the copy. A request cut off between the two
    // leaves the scan still waiting for review, which is recoverable. The
    // other order could lose it.
    const log = await this.settleReview(id, (item) => {
      item.stage = "sent";
      item.recipients = recipients;
      delete item.error;
      delete item.review;
      delete item.expires;
    });
    await this.env.PRINT_FILES.delete(`review:${id}`);
    return json(request, this.env, 200, {
      ok: true,
      stage: "sent",
      scanned: true,
      emailed: true,
      files: [row.name],
      recipients,
      scans: this.ownScans(log, actor),
    });
  }

  // ---- print queue --------------------------------------------------------
  //
  // One queue for the whole desk, strictly ordered, one job printing at a
  // time. The Durable Object is a singleton so the lock is just "is anything
  // in the printing state". Everyone sees the queue — names included — so a
  // person waiting knows who is ahead of them and why. History is private:
  // once a job is done or failed, only its owner sees it.

  private async printJobs(): Promise<PrintJob[]> {
    return (await this.ctx.storage.get<PrintJob[]>("printJobs")) ?? [];
  }

  private async savePrintJobs(jobs: PrintJob[]): Promise<void> {
    // Keep the live jobs and a short tail of finished ones per person for the
    // history list. Per person, because history is private: a shared tail
    // would let one busy colleague push everyone else's history out.
    const live = jobs.filter((j) => j.status === "queued" || j.status === "printing");
    const kept = new Map<string, number>();
    const done = jobs
      .filter((j) => j.status === "done" || j.status === "failed")
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))
      .filter((j) => {
        const n = kept.get(j.owner) ?? 0;
        kept.set(j.owner, n + 1);
        return n < PRINT_HISTORY;
      });
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
        .filter((j) => j.status === "queued" || j.status === "printing" || !actor || j.owner === actor)
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
      const params = new URL(request.url).searchParams;
      // Clear all empties your history: done and failed jobs only. Anything
      // still queued or printing is left alone, so it cannot cancel a print.
      if (params.get("all") === "1") {
        const cleared = jobs.filter(
          (j) => (j.status === "done" || j.status === "failed") && (!actor || j.owner === actor)
        );
        const rest = jobs.filter((j) => !cleared.includes(j));
        await Promise.all(cleared.map((j) => this.env.PRINT_FILES.delete(`print:${j.id}`)));
        await this.savePrintJobs(rest);
        return json(request, this.env, 200, { ok: true, ...this.printView(rest, actor, now) });
      }
      const id = params.get("id") || "";
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
    // A bridge asking for work is not holding any. It scans inline and only
    // polls again afterwards, so an active job at this point means the bridge
    // restarted mid-scan and no result will ever arrive for it. Fail it now
    // rather than leave the dashboard showing a scan that cannot finish --
    // reflashing the board mid-scan left exactly that stuck on screen.
    if (this.active) {
      const orphan = this.active;
      this.active = null;
      orphan.resolve({
        ok: false,
        stage: "scan_failed",
        scanned: false,
        emailed: false,
        error: "the office bridge restarted mid-scan",
      });
      await this.recordScan({
        at: Date.now(),
        name: "",
        stage: "scan_failed",
        recipients: orphan.recipients,
        error: "the office bridge restarted mid-scan",
        owner: orphan.owner,
      });
    }
    if (!this.queued && !this.reportWanted) {
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
      // A string, like duplex: the bridge's jsonField only reads quoted values.
      const report = this.reportWanted;
      this.reportWanted = false;
      return json(request, this.env, 200, report ? { job: "", report: "1" } : { job: "" });
    }
    this.active = this.queued;
    this.active.phase = "scanning";
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
    // Checked after reading, not from the header.
    //
    // The bridge relays the scan as it arrives from the printer, so it cannot
    // know the size when the request starts and sends it chunked with no
    // Content-Length. Reading the header gave 0, which sailed past the limit:
    // the cap was silently off for exactly the uploads it was meant to bound.
    // A declared length is still honoured, so an oversized one is refused
    // before its body is read.
    const declared = Number(request.headers.get("Content-Length") || "0");
    if (declared > MAX_SCAN_BYTES) {
      await discardBody(request);
      return json(request, this.env, 413, { ok: false, error: "pdf too large" });
    }
    const buf = errMsg ? new Uint8Array() : new Uint8Array(await request.arrayBuffer());
    if (buf.byteLength > MAX_SCAN_BYTES) {
      return json(request, this.env, 413, { ok: false, error: "pdf too large" });
    }
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

  /**
   * The bridge saying where it has got to. Costs it one small request, which
   * buys the only transition the Worker cannot see for itself: the scan is
   * off the printer and now going up. That is the long part, so it is the one
   * worth knowing about.
   */
  private async handleProgress(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    this.lastSeen = Date.now();
    const url = new URL(request.url);
    const id = url.searchParams.get("job") || "";
    const phase = url.searchParams.get("phase") || "";
    const bytes = Number(url.searchParams.get("bytes") || "0");
    const job = this.active?.id === id ? this.active : null;
    // Only ever moves a job the bridge is actually holding, and only to a
    // phase we know, so a stale or malformed ping cannot rewrite the state.
    if (job && (phase === "scanning" || phase === "uploading" || phase === "emailing")) {
      job.phase = phase;
      if (bytes > 0) {
        job.bytes = bytes;
      }
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
    // Only `status` is required. This used to demand toners and trays as
    // arrays, and when the bridge stopped collecting supplies it kept posting
    // without them -- so every report was rejected with 400 and the stored
    // status quietly froze at whatever it had been before. Nothing showed it:
    // lastSeen is set above this, so the dashboard went on saying the bridge
    // was online while none of its readings were being kept.
    if (!body || typeof body.status !== "string") {
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
      adf: typeof body.adf === "string" ? body.adf : undefined,
      // Still accepted, so a bridge that does send them is not penalised.
      toners: Array.isArray(body.toners) ? body.toners.slice(0, 16) : undefined,
      trays: Array.isArray(body.trays) ? body.trays.slice(0, 16) : undefined,
      alerts: Array.isArray(body.alerts) ? body.alerts.slice(0, 32) : undefined,
      checked_at: Number(body.checked_at) || Date.now() / 1000,
    };
    await this.ctx.storage.put("supplies", supplies);
    for (const done of this.telemetryWaiters.splice(0)) {
      done();
    }
    return json(request, this.env, 200, { ok: true });
  }

  /**
   * Ask the bridge for a report and wait for it, or give up after `ms`.
   *
   * Any report counts, not only the one asked for: a print in progress
   * reports every few seconds by itself, and a scan that is running cannot
   * answer until it finishes, so the timeout is what bounds the wait then.
   */
  private awaitReport(ms: number): Promise<void> {
    this.reportWanted = true;
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.telemetryWaiters = this.telemetryWaiters.filter((w) => w !== done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.telemetryWaiters.push(done);
      this.wakePoll();
    });
  }

  // ---- account move ------------------------------------------------------
  //
  // One-off, for moving printer-api from Alwin's Cloudflare account to
  // Parth's, where nexdash.com lives. Durable Object storage does not move
  // with a Worker, so without this everyone's saved recipients would be lost.
  // The old Worker exports, the new one imports once, then both routes go.
  // Bridge token only: the dump holds every recipient address.

  private async handleExport(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    const entries = Object.fromEntries(await this.ctx.storage.list());
    return json(request, this.env, 200, { ok: true, entries });
  }

  private async handleImport(request: Request): Promise<Response> {
    if (!bearerOk(request, this.env.BRIDGE_TOKEN || "")) {
      return new Response("forbidden", { status: 403 });
    }
    if (request.method !== "POST") {
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }
    // Once, into an empty store. "supplies" is allowed to exist already: the
    // bridge's telemetry writes it, and it is replaced by the next report.
    const existing = [...(await this.ctx.storage.list()).keys()].filter((k) => k !== "supplies");
    if (existing.length) {
      return json(request, this.env, 409, { ok: false, error: `store is not empty: ${existing.join(", ")}` });
    }
    const body = (await request.json().catch(() => null)) as { entries?: Record<string, unknown> } | null;
    if (!body?.entries || typeof body.entries !== "object") {
      return json(request, this.env, 400, { ok: false, error: "expected {entries}" });
    }
    const entries: Record<string, unknown> = { ...body.entries };
    delete entries.supplies;
    // A queued job's PDF is in the old account's KV and does not come along,
    // so only finished jobs, which are history, make the trip.
    if (Array.isArray(entries.printJobs)) {
      entries.printJobs = (entries.printJobs as PrintJob[]).filter(
        (j) => j.status === "done" || j.status === "failed"
      );
    }
    // put() takes at most 128 keys per call.
    const all = Object.entries(entries);
    for (let i = 0; i < all.length; i += 100) {
      await this.ctx.storage.put(Object.fromEntries(all.slice(i, i + 100)));
    }
    return json(request, this.env, 200, { ok: true, imported: Object.keys(entries) });
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
    // Scan download links. Public and stateless, so they never touch the DO.
    const { pathname } = new URL(request.url);
    if (pathname.startsWith("/scans/") && (request.method === "GET" || request.method === "HEAD")) {
      return serveScan(env, pathname);
    }
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
      // Same reason as above: a chunked request declares nothing, so the only
      // honest check is on what actually arrived.
      if (body.byteLength > MAX_BODY_BYTES) {
        return new Response(JSON.stringify({ ok: false, error: "body too large" }), {
          status: 413,
          headers: { "Content-Type": "application/json" },
        });
      }
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
