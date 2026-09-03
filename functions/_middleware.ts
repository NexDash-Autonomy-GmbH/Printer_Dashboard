// Cloudflare Access protects one hostname. Pages serves many.
//
// Every Pages deployment also gets its own hostname, <id>.printer-dashboard
// .pages.dev, and the production deployment has one too. The Access
// application covers printer-dashboard.pages.dev and nothing else, so those
// per-deployment hostnames answered with the full dashboard to anyone who
// asked, no login. Verified against the live site: the canonical host
// redirects to the Access login, the deployment host returned 200.
//
// No data leaked through that door. Every /api/* call is checked by the
// Worker itself, which verifies the Access assertion and does not care which
// hostname carried the request, so an unauthenticated caller on a preview
// host still got 403 from the API. What was exposed was the application
// shell.
//
// This sends anything arriving on a non-canonical Pages hostname to the
// canonical one, where Access is in front. It is a backstop, not the real
// fix: adding *.printer-dashboard.pages.dev as a destination on the Access
// application is what closes this at the edge, and that has to be done in
// the Cloudflare dashboard. Keep this even once that is in place, so a
// future project or hostname cannot quietly reopen the same door.

const CANONICAL_HOST = "printer-dashboard.pages.dev";

export const onRequest: PagesFunction = async (context) => {
  const url = new URL(context.request.url);
  const host = url.hostname.toLowerCase();

  // Only Pages' own per-deployment hostnames are rewritten. A custom domain
  // or localhost is left alone: this must not hijack local development or a
  // future domain that has its own Access application.
  if (host !== CANONICAL_HOST && host.endsWith(`.${CANONICAL_HOST}`)) {
    url.hostname = CANONICAL_HOST;
    // Found, not Moved Permanently. Deployment hostnames are disposable and a
    // permanent redirect would be cached against one that no longer exists.
    return Response.redirect(url.toString(), 302);
  }

  return context.next();
};
