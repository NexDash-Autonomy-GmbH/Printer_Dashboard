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
};

type Job = {
  id: string;
  source: string;
  resolve: (result: ScanResult) => void;
};

type ScanResult = { pdf?: Uint8Array; error?: string };

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
    headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
function mutates(request: Request, url: URL): boolean {
  if (url.pathname === "/api/scan") {
    return true;
  }
  return request.method !== "GET" && request.method !== "HEAD";
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
    if (url.pathname.startsWith("/api/")) {
      const cfg = accessConfig(this.env);
      if (cfg) {
        const verdict = await verifyAccess(request, cfg);
        if (!verdict.ok) {
          return json(request, this.env, 403, { ok: false, error: "forbidden" });
        }
      } else if (mutates(request, url)) {
        // Access is not configured yet, so nobody is authenticated. Reads stay
        // open to keep the dashboard usable, but nothing that adds a recipient
        // or moves paper runs for an anonymous caller: those two chained
        // together are what let a stranger scan the feeder and mail it out.
        return json(request, this.env, 403, {
          ok: false,
          error: "sign-in required for this action",
        });
      }
    }

    switch (url.pathname) {
      case "/health":
        return new Response("ok\n", { headers: { "Content-Type": "text/plain" } });
      case "/api/state":
        return this.handleState(request);
      case "/api/emails":
        return this.handleEmails(request);
      case "/api/scan":
        return this.handleScan(request);
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

  private async emails(): Promise<string[]> {
    return (await this.ctx.storage.get<string[]>("emails")) ?? [];
  }

  private async handleState(request: Request): Promise<Response> {
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
      emails: withoutSender(await this.emails(), from),
      workspace_emails: withoutSender(WORKSPACE, from),
      web_ui: `http://${this.env.PRINTER_HOST || "192.168.68.52"}/`,
      bridge_online: online,
      scans: await this.scanLog(),
      supplies: await this.supplies(),
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

  private async handleEmails(request: Request): Promise<Response> {
    const current = await this.emails();
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
      await this.ctx.storage.put("emails", next);
      return json(request, this.env, 200, { ok: true, emails: next, added: next.length !== current.length });
    }
    if (request.method === "DELETE") {
      const url = new URL(request.url);
      const email = (url.searchParams.get("email") || "").trim().toLowerCase();
      const next = current.filter((item) => item !== email);
      await this.ctx.storage.put("emails", next);
      return json(request, this.env, 200, { ok: true, emails: next });
    }
    return json(request, this.env, 405, { ok: false, error: "method not allowed" });
  }

  private async handleScan(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return json(request, this.env, 405, { ok: false, error: "method not allowed" });
    }
    const body = ((await request.json().catch(() => ({}))) || {}) as { source?: string };
    const source = body.source || "platen";
    const from = (this.env.SMTP_FROM_EMAIL || "").toLowerCase();
    const recipients = withoutSender(await this.emails(), from);
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
    const result = await new Promise<ScanResult>((resolve) => {
      const id = new Date().toISOString().slice(11, 23);
      const timer = setTimeout(() => {
        if (this.active?.id === id) {
          this.active = null;
        }
        if (this.queued?.id === id) {
          this.queued = null;
        }
        resolve({ error: "office bridge did not return a scan" });
      }, 180_000);
      this.queued = {
        id,
        source,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      };
      this.wakePoll();
    });
    if (result.error || !result.pdf) {
      const error = result.error || "empty scan";
      await this.recordScan({
        at: Date.now(),
        name: "",
        stage: "scan_failed",
        recipients,
        error,
      });
      return json(request, this.env, 200, {
        ok: false,
        stage: "scan_failed",
        scanned: false,
        emailed: false,
        error,
      });
    }
    const name = `scan_${new Date().toISOString().replace(/[:.]/g, "-")}.pdf`;
    if (recipients.length === 0) {
      await this.recordScan({ at: Date.now(), name, stage: "saved", recipients });
      return json(request, this.env, 200, {
        ok: true,
        stage: "saved",
        scanned: true,
        emailed: false,
        files: [name],
      });
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
      return json(request, this.env, 200, {
        ok: false,
        stage: "mail_failed",
        scanned: true,
        emailed: false,
        error: message,
        files: [name],
      });
    }
    await this.recordScan({ at: Date.now(), name, stage: "sent", recipients });
    return json(request, this.env, 200, {
      ok: true,
      stage: "sent",
      scanned: true,
      emailed: true,
      files: [name],
      recipients,
    });
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
      job.resolve(errMsg ? { error: errMsg } : { pdf: buf });
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

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = env.PRINTER_API.idFromName("singleton");
    return env.PRINTER_API.get(id).fetch(request);
  },
};
