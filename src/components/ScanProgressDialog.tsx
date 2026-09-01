import { useEffect, useRef, useState } from "react"

import { useRecipients } from "@/recipients/context"

type LottieInstance = { destroy: () => void }

/**
 * Covers the screen while a scan runs. jobStatus stays "scanning" for the whole
 * operation — the scan itself and the mail that follows — so this is up until
 * the job resolves either way.
 *
 * The player and the animation are both loaded on demand. Together they are
 * ~190KB, which has no business sitting in the initial bundle for something
 * seen only while scanning.
 */
export function ScanProgressDialog() {
  const { state } = useRecipients()
  const scanning = state.jobStatus === "scanning"
  const host = useRef<HTMLDivElement | null>(null)
  const [failedToLoad, setFailedToLoad] = useState(false)

  useEffect(() => {
    if (!scanning) {
      return
    }
    // Under reduced motion the copy carries the message on its own.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return
    }

    let animation: LottieInstance | null = null
    let cancelled = false

    void (async () => {
      try {
        const [{ default: lottie }, { default: data }] = await Promise.all([
          import("lottie-web/build/player/lottie_light"),
          import("@/assets/printing-animation.json"),
        ])
        if (cancelled || !host.current) {
          return
        }
        animation = lottie.loadAnimation({
          container: host.current,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: data,
        }) as LottieInstance
      } catch {
        // A missing player must not hide the fact that a scan is running.
        if (!cancelled) {
          setFailedToLoad(true)
        }
      }
    })()

    return () => {
      cancelled = true
      animation?.destroy()
    }
  }, [scanning])

  if (!scanning) {
    return null
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="scan-progress-title"
      className="bg-background/80 fixed inset-0 z-50 grid place-items-center p-6 backdrop-blur-sm"
    >
      <div className="border-border bg-card w-full max-w-sm rounded-2xl border p-8 text-center shadow-lg">
        {failedToLoad ? null : (
          <div ref={host} aria-hidden className="mx-auto size-40" />
        )}
        <p id="scan-progress-title" className="text-lg font-semibold">
          Scanning
        </p>
        {/* The message names the current step, so announce it as it changes.
            The generic "Scanning…" would only repeat the heading. */}
        <p aria-live="polite" className="text-muted-foreground mt-1 text-sm">
          {state.jobMessage && state.jobMessage !== "Scanning…"
            ? state.jobMessage
            : "Talking to the Xerox…"}
        </p>
        <p className="text-muted-foreground/80 mt-4 text-xs">
          Keep this page open until the scan finishes.
        </p>
      </div>
    </div>
  )
}
