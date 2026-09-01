// Same-origin proxy from the dashboard to the printer Worker.
//
// The app calls /api/* on its own origin so that one Cloudflare Access
// application covers both the page and the API. Access sets CF_Authorization
// for this hostname only, so a cross-origin call to the Worker's own hostname
// would need a third-party cookie — blocked in Safari, going away in Chrome.
// Routing through here keeps the credential first-party.
//
// The Worker is reached over a service binding, not a public URL, so there is
// no second door to walk through. It still verifies the Access assertion
// itself; this proxy is a route, not a trust boundary.

type Env = {
  PRINTER_WORKER: { fetch: (request: Request) => Promise<Response> };
};

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;

  if (!env.PRINTER_WORKER) {
    // Loud rather than silently falling back to a public hostname.
    return Response.json(
      { ok: false, error: "printer worker binding missing" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  // Forward as-is. Access has already added Cf-Access-Jwt-Assertion, and the
  // Worker checks its signature, audience and expiry before doing anything.
  return env.PRINTER_WORKER.fetch(request);
};
