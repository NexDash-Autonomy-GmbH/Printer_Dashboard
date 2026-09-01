// Cloudflare Access JWT verification.
//
// Access sits in front of the dashboard and the Worker and does the SSO. It
// forwards the signed identity as `Cf-Access-Jwt-Assertion` (and as the
// CF_Authorization cookie). Anything reaching the Worker without a valid
// assertion never passed Access, so it is not a signed-in person.
//
// This is verified here rather than trusted, because the Worker also answers on
// its own workers.dev hostname, which Access does not cover. A header alone
// proves nothing; the signature does.

export type AccessConfig = {
  teamDomain: string;
  aud: string;
};

export type AccessResult =
  | { ok: true; email: string }
  | { ok: false; reason: string };

type Jwk = JsonWebKey & { kid?: string };

type JwksCacheEntry = { keys: Jwk[]; fetchedAt: number };

const JWKS_TTL_MS = 10 * 60 * 1000;
const jwksCache = new Map<string, JwksCacheEntry>();

/** Read the team domain and audience, or explain what is missing. */
export function accessConfig(env: {
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}): AccessConfig | null {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  const aud = (env.ACCESS_AUD || "").trim();
  if (!teamDomain || !aud) {
    return null;
  }
  return { teamDomain, aud };
}

function decodeBase64Url(part: string): Uint8Array {
  const padded = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(decodeBase64Url(part))) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function jwks(teamDomain: string, now: number): Promise<Jwk[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && now - cached.fetchedAt < JWKS_TTL_MS) {
    return cached.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) {
    // Serve a stale key set rather than locking everyone out on a blip.
    if (cached) {
      return cached.keys;
    }
    throw new Error(`access certs ${res.status}`);
  }
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache.set(teamDomain, { keys, fetchedAt: now });
  return keys;
}

function readToken(request: Request): string {
  const header = request.headers.get("Cf-Access-Jwt-Assertion");
  if (header) {
    return header.trim();
  }
  const cookie = request.headers.get("Cookie") || "";
  const match = /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(cookie);
  return match ? match[1].trim() : "";
}

/**
 * Verify the Access assertion on a request. Every failure path returns ok:false
 * — there is no branch that lets an unverified request through.
 */
export async function verifyAccess(
  request: Request,
  cfg: AccessConfig,
  now: number = Date.now(),
): Promise<AccessResult> {
  const token = readToken(request);
  if (!token) {
    return { ok: false, reason: "no access assertion" };
  }
  const parts = token.split(".");
  if (parts.length !== 3) {
    return { ok: false, reason: "malformed assertion" };
  }
  const header = decodeJson(parts[0]);
  const payload = decodeJson(parts[1]);
  if (!header || !payload) {
    return { ok: false, reason: "unreadable assertion" };
  }
  if (header.alg !== "RS256") {
    // Refuse "none" and any HMAC downgrade outright.
    return { ok: false, reason: `unexpected alg ${String(header.alg)}` };
  }

  const iss = String(payload.iss || "");
  if (iss !== `https://${cfg.teamDomain}`) {
    return { ok: false, reason: "wrong issuer" };
  }
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(cfg.aud) : aud === cfg.aud;
  if (!audOk) {
    return { ok: false, reason: "wrong audience" };
  }
  const seconds = Math.floor(now / 1000);
  const exp = Number(payload.exp || 0);
  if (!exp || exp <= seconds) {
    return { ok: false, reason: "expired" };
  }
  const nbf = Number(payload.nbf || 0);
  if (nbf && nbf > seconds + 60) {
    return { ok: false, reason: "not yet valid" };
  }

  const kid = String(header.kid || "");
  const keys = await jwks(cfg.teamDomain, now);
  const jwk = keys.find((k) => k.kid === kid);
  if (!jwk) {
    return { ok: false, reason: "unknown signing key" };
  }
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeBase64Url(parts[2]),
    signed,
  );
  if (!valid) {
    return { ok: false, reason: "bad signature" };
  }
  return { ok: true, email: String(payload.email || "") };
}
