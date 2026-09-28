/**
 * Scan mail, sent through Cloudflare Email Sending's REST API.
 *
 * Not the send_email binding: that only sends from domains onboarded in the
 * Worker's own account, and nexdash.com is onboarded in a different one
 * (Parth's), where NexOS sends from noreply@nexdash.com too. Not SMTP either:
 * smtp.mx.cloudflare.net is on Cloudflare's own IP ranges, and Workers cannot
 * open TCP sockets to those. So the account ID and a token scoped to Email
 * Sending on that account are what this needs.
 */
export type MailConfig = {
  accountId: string;
  apiToken: string;
  fromEmail: string;
  fromName: string;
};

type SendResult = {
  delivered: string[];
  queued: string[];
  permanent_bounces: string[];
  suppressed_recipients: string[];
};

type ApiResponse = {
  success: boolean;
  errors?: Array<{ code: number; message: string }>;
  result?: SendResult;
};

export async function sendMail(
  cfg: MailConfig,
  to: string[],
  subject: string,
  text: string,
  pdf: Uint8Array,
  filename: string
): Promise<void> {
  if (!cfg.accountId || !cfg.apiToken || !cfg.fromEmail) {
    throw new Error("EMAIL_ACCOUNT_ID, EMAIL_API_TOKEN and MAIL_FROM_EMAIL must be set");
  }
  const res = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.accountId)}/email/sending/send`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        to,
        from: { address: cfg.fromEmail, name: cfg.fromName },
        subject,
        text,
        attachments: [
          { content: base64(pdf), filename, type: "application/pdf", disposition: "attachment" },
        ],
      }),
    }
  );
  const body = (await res.json().catch(() => null)) as ApiResponse | null;
  if (!res.ok || !body?.success || !body.result) {
    const reason = body?.errors?.map((e) => `${e.code} ${e.message}`).join("; ");
    throw new Error(`Email Sending refused the mail (HTTP ${res.status})${reason ? `: ${reason}` : ""}`);
  }
  // A 200 can still leave recipients behind. Queued is fine, it is on its way;
  // a bounce or a suppression means that person never gets the scan.
  const lost = [...body.result.permanent_bounces, ...body.result.suppressed_recipients];
  if (lost.length) {
    throw new Error(`Not delivered to ${lost.join(", ")}`);
  }
}

// Chunked, because String.fromCharCode(...bytes) on a 20 MB scan overflows
// the argument limit.
function base64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
