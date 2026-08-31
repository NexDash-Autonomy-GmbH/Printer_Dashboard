import { connect } from "cloudflare:sockets";

export type SmtpConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  fromEmail: string;
  fromName: string;
};

export async function sendSmtp(
  cfg: SmtpConfig,
  to: string[],
  subject: string,
  body: string,
  pdf: Uint8Array,
  filename: string
): Promise<void> {
  if (!cfg.user || !cfg.password || !cfg.fromEmail) {
    throw new Error("SMTP_USER, SMTP_PASSWORD and SMTP_FROM_EMAIL must be set");
  }
  const socket = connect(
    { hostname: cfg.host, port: cfg.port },
    { secureTransport: "starttls" }
  );
  await socket.opened;
  const session = new SmtpSession(socket);
  try {
    await session.expect(220);
    await session.command(`EHLO printer.nexdash.com`, 250);
    await session.command("STARTTLS", 220);
    await session.startTls();
    await session.command(`EHLO printer.nexdash.com`, 250);
    const plain = b64(`\0${cfg.user}\0${cfg.password}`);
    const auth = await session.command(`AUTH PLAIN ${plain}`, 235);
    if (auth.code !== 235) {
      throw new Error(`SMTP login failed. Use a Google App Password for ${cfg.user}`);
    }
    await session.command(`MAIL FROM:<${cfg.fromEmail}>`, 250);
    for (const rcpt of to) {
      await session.command(`RCPT TO:<${rcpt}>`, 250);
    }
    await session.command("DATA", 354);
    const message = buildMessage(cfg, to, subject, body, pdf, filename);
    await session.write(message.replace(/\r?\n\./g, "\r\n..") + "\r\n.\r\n");
    await session.expect(250);
    await session.command("QUIT", 221);
  } finally {
    try {
      await socket.close();
    } catch {
      // socket already closed
    }
  }
}

class SmtpSession {
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  private buffer = new Uint8Array(0);
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private socket: ReturnType<typeof connect>;

  constructor(socket: ReturnType<typeof connect>) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async startTls(): Promise<void> {
    this.reader.releaseLock();
    this.writer.releaseLock();
    const secure = this.socket.startTls();
    this.socket = secure;
    this.reader = secure.readable.getReader();
    this.writer = secure.writable.getWriter();
    this.buffer = new Uint8Array(0);
  }

  async write(text: string): Promise<void> {
    await this.writer.write(this.encoder.encode(text));
  }

  async command(line: string, expect: number): Promise<{ code: number; text: string }> {
    await this.write(line + "\r\n");
    const reply = await this.readReply();
    if (reply.code !== expect) {
      throw new Error(`SMTP ${line.split(" ")[0]} failed (${reply.code}): ${reply.text}`);
    }
    return reply;
  }

  async expect(code: number): Promise<void> {
    const reply = await this.readReply();
    if (reply.code !== code) {
      throw new Error(`SMTP expected ${code}, got ${reply.code}: ${reply.text}`);
    }
  }

  private async readReply(): Promise<{ code: number; text: string }> {
    const lines: string[] = [];
    for (;;) {
      const line = await this.readLine();
      lines.push(line);
      if (line.length >= 4 && line[3] === " ") {
        return { code: Number(line.slice(0, 3)), text: lines.join("\n") };
      }
    }
  }

  private async readLine(): Promise<string> {
    for (;;) {
      const idx = indexOfCRLF(this.buffer);
      if (idx >= 0) {
        const line = this.decoder.decode(this.buffer.slice(0, idx));
        this.buffer = this.buffer.slice(idx + 2);
        return line;
      }
      const next = await this.reader.read();
      if (next.done) {
        throw new Error("SMTP connection closed");
      }
      this.buffer = concat(this.buffer, next.value);
    }
  }
}

function buildMessage(
  cfg: SmtpConfig,
  to: string[],
  subject: string,
  body: string,
  pdf: Uint8Array,
  filename: string
): string {
  const boundary = "nexdashprinterboundary";
  return [
    `From: ${cfg.fromName} <${cfg.fromEmail}>`,
    `To: ${to.join(", ")}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary=${boundary}`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
    `--${boundary}`,
    "Content-Type: application/pdf",
    `Content-Disposition: attachment; filename="${filename}"`,
    "Content-Transfer-Encoding: base64",
    "",
    b64Bytes(pdf),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

function b64(text: string): string {
  return b64Bytes(new TextEncoder().encode(text));
}

function b64Bytes(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x2000;
  for (let i = 0; i < bytes.length; i += chunk) {
    const slice = bytes.subarray(i, i + chunk);
    let part = "";
    for (let j = 0; j < slice.length; j++) {
      part += String.fromCharCode(slice[j]);
    }
    bin += part;
  }
  return btoa(bin);
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function indexOfCRLF(buf: Uint8Array): number {
  for (let i = 0; i < buf.length - 1; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}
