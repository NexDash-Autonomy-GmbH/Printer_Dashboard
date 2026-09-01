// Who is signed in, according to Cloudflare Access.
//
// Access authenticates the request before it ever reaches this app and adds no
// UI of its own, so the page has to ask. /cdn-cgi/access/get-identity is served
// on our own origin by the Access edge and answers 400 when nobody is signed
// in — which is also what you get locally, where Access is not in front.

export type Identity = {
  email: string
  name?: string
}

type IdentityResponse = {
  email?: string
  name?: string
  given_name?: string
}

export const LOGOUT_URL = "/cdn-cgi/access/logout"

/** Returns null when nobody is signed in, or when Access is not in front (local dev). */
export async function fetchIdentity(signal?: AbortSignal): Promise<Identity | null> {
  try {
    const res = await fetch("/cdn-cgi/access/get-identity", {
      signal,
      headers: { Accept: "application/json" },
    })
    if (!res.ok) {
      return null
    }
    const data = (await res.json()) as IdentityResponse
    if (!data.email) {
      return null
    }
    return { email: data.email, name: data.name || data.given_name }
  } catch {
    // Offline, aborted, or no Access edge. Not signed in, as far as the UI goes.
    return null
  }
}
