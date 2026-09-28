import type { Env } from "./index";

/**
 * Scan mail, from noreply@nexdash.com through Cloudflare Email Sending.
 *
 * Email Sending caps a whole message at 5 MiB, attachments included, on every
 * route: this binding, the REST API and SMTP alike. Gmail took 25 MB, and a
 * colour page from this printer is ~415 KB, ~570 KB once base64'd into a
 * message, so anything past about nine pages would simply fail. A scan that
 * fits is attached as before; a bigger one is kept in SCAN_FILES for 30 days
 * and the mail carries a link to it instead.
 */
export type MailEnv = {
  EMAIL: SendEmail;
  SCAN_FILES: KVNamespace;
};

export type MailConfig = {
  fromEmail: string;
  fromName: string;
  /* Origin that serves /scans/<id>/<name>, with no trailing slash. */
  linkBase: string;
};

/* Raw PDF bytes that still fit: 3.5 MB grows to ~4.8 MB as base64, which
   leaves room under 5 MiB for the headers and the body. */
export const ATTACH_MAX_BYTES = 3_500_000;
export const LINK_TTL_S = 30 * 24 * 60 * 60;

export async function sendScan(
  env: MailEnv,
  cfg: MailConfig,
  to: string[],
  subject: string,
  pdf: Uint8Array,
  filename: string
): Promise<{ linked: boolean }> {
  if (!cfg.fromEmail) {
    throw new Error("MAIL_FROM_EMAIL must be set");
  }
  const from = { email: cfg.fromEmail, name: cfg.fromName };
  try {
    if (pdf.byteLength <= ATTACH_MAX_BYTES) {
      await env.EMAIL.send({
        to,
        from,
        subject,
        text: "Scan from the Xerox B305.\n",
        attachments: [{ content: pdf, filename, type: "application/pdf", disposition: "attachment" }],
      });
      return { linked: false };
    }
    const id = crypto.randomUUID();
    await env.SCAN_FILES.put(`scan:${id}`, pdf, {
      expirationTtl: LINK_TTL_S,
      metadata: { name: filename },
    });
    const link = `${cfg.linkBase}/scans/${id}/${encodeURIComponent(filename)}`;
    const mb = (pdf.byteLength / 1_000_000).toFixed(1);
    await env.EMAIL.send({
      to,
      from,
      subject,
      text:
        `Scan from the Xerox B305.\n\n` +
        `It is ${mb} MB, too large to attach, so it is here instead:\n${link}\n\n` +
        `The link works for 30 days.\n`,
    });
    return { linked: true };
  } catch (error) {
    // The binding throws with a string code, E_SENDER_NOT_VERIFIED and the
    // like. Keep it: it says what to fix, where the message alone may not.
    const code = (error as { code?: string }).code;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(code ? `${code}: ${message}` : message, { cause: error });
  }
}

/**
 * GET /scans/<id>/<name>. No sign-in, on purpose: recipients outside NexDash
 * have to open it. The id is a random UUID, so the link is the key, and the
 * file is gone when its 30 days run out.
 */
export async function serveScan(env: MailEnv, pathname: string): Promise<Response> {
  const id = pathname.split("/")[2] || "";
  if (!/^[0-9a-f-]{36}$/.test(id)) {
    return new Response("Not found\n", { status: 404 });
  }
  const { value, metadata } = await env.SCAN_FILES.getWithMetadata<{ name?: string }>(
    `scan:${id}`,
    "arrayBuffer"
  );
  if (!value) {
    return new Response("This scan link has expired.\n", {
      status: 404,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
  const name = (metadata?.name || "scan.pdf").replace(/["\r\n]/g, "");
  return new Response(value, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `inline; filename="${name}"`,
      "Cache-Control": "private, no-store",
      "Referrer-Policy": "no-referrer",
      "X-Robots-Tag": "noindex",
    },
  });
}

/**
 * The one place a scan leaves as mail.
 *
 * Both routes out go through here: a scan mailed the moment it arrives, and a
 * scan sent after its pages were checked. It throws on failure, and callers
 * record the message as the scan's mail error.
 */
export async function mailScan(env: Env, to: string[], name: string, pdf: Uint8Array): Promise<void> {
  await sendScan(
    env,
    {
      fromEmail: env.MAIL_FROM_EMAIL || "",
      fromName: env.MAIL_FROM_NAME || "NexDash",
      linkBase: env.SCAN_LINK_BASE || "",
    },
    to,
    `Xerox scan ${name}`,
    pdf,
    name
  );
}
