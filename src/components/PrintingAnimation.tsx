import { useEffect, useRef, useState } from "react"

import { cn } from "@/lib/utils"

type LottieInstance = { destroy: () => void }

/**
 * The Lottie printer, loaded on demand. The player and the animation are
 * ~190KB together, so they arrive only when something is actually printing or
 * scanning. Renders nothing under prefers-reduced-motion or if the player
 * fails to load — callers carry the message in text either way.
 */
export function PrintingAnimation({ className }: { className?: string }) {
  const host = useRef<HTMLDivElement | null>(null)
  // Decided once, up front: reduced motion means no player at all.
  const [hidden, setHidden] = useState(
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  )

  useEffect(() => {
    if (hidden) {
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
        if (cancelled || !host.current) return
        animation = lottie.loadAnimation({
          container: host.current,
          renderer: "svg",
          loop: true,
          autoplay: true,
          animationData: data,
        }) as LottieInstance
      } catch {
        if (!cancelled) setHidden(true)
      }
    })()
    return () => {
      cancelled = true
      animation?.destroy()
    }
  }, [hidden])

  if (hidden) return null
  return <div ref={host} aria-hidden className={cn("size-40", className)} />
}
