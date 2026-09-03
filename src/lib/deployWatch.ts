import { toast } from "sonner"

/**
 * Notices when a new version of the dashboard has been deployed.
 *
 * A single-page app never replaces its own JavaScript. Deploy a fix and every
 * tab already open keeps running the old bundle indefinitely, so the fix looks
 * like it did not work -- which is exactly what happened repeatedly while this
 * app was being built: a bug was fixed, deployed and verified, and then
 * reported as still broken from a tab that predated it.
 *
 * Vite gives every build a hashed entry filename, so the check is simply
 * whether index.html still points at the bundle this page is running. No
 * version endpoint and nothing for the server to keep in step.
 */

const CHECK_MS = 60_000

/** The hashed entry bundle this page actually loaded. */
function runningBundle(): string | null {
  const scripts = Array.from(document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'))
  const entry = scripts.map((s) => s.getAttribute("src") || "").find((src) => /\/assets\/index-.*\.js$/.test(src))
  return entry || null
}

async function deployedBundle(signal: AbortSignal): Promise<string | null> {
  // no-store, or the browser answers from the very cache this is trying to see
  // past. redirect manual so an expired Access session is a non-event rather
  // than a CORS failure against the login host.
  const res = await fetch("/", { cache: "no-store", redirect: "manual", signal })
  if (!res.ok) {
    return null
  }
  const html = await res.text()
  return /src="(\/assets\/index-[^"]+\.js)"/.exec(html)?.[1] ?? null
}

/**
 * Starts watching. Returns a function that stops it.
 *
 * Never reloads on its own: someone may be mid-scan, and throwing the page
 * away underneath them would be worse than being one version behind. The
 * choice is offered and left open until taken.
 */
export function watchForNewDeploy(): () => void {
  const running = runningBundle()
  if (!running) {
    // Dev server, or a build without hashed entries. Nothing to compare.
    return () => undefined
  }

  let stopped = false
  let told = false
  const controller = new AbortController()

  const check = async () => {
    if (stopped || told) return
    try {
      const latest = await deployedBundle(controller.signal)
      if (!latest || latest === running) return
      told = true
      toast("A new version of the dashboard is available", {
        description: "This tab is still running the previous one.",
        duration: Infinity,
        action: { label: "Reload", onClick: () => window.location.reload() },
      })
    } catch {
      // Offline, or Access got in the way. Try again on the next tick.
    }
  }

  const timer = window.setInterval(() => void check(), CHECK_MS)
  // Also on focus: a tab left open overnight should not wait out the interval.
  const onFocus = () => void check()
  window.addEventListener("focus", onFocus)

  return () => {
    stopped = true
    controller.abort()
    window.clearInterval(timer)
    window.removeEventListener("focus", onFocus)
  }
}
