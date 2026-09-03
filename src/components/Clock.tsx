import { useEffect, useState } from "react"

import { cn } from "@/lib/utils"

/**
 * Wall-clock time on the machine looking at the page: "9:42:07 AM".
 *
 * Composed by hand rather than through Intl. lib/format pins en-GB, which
 * renders "am"/"pm" in lower case, and following the browser's locale instead
 * would give 24-hour time across most of Europe -- the browser's locale is not
 * the app's to follow. Assembling the parts is the only way every viewer sees
 * the same format.
 *
 * It lives here rather than in lib/format because this component is its only
 * caller, and every branch that appended a helper to the end of that shared
 * file collided with the next one on merge.
 */
function formatClock(date: Date): string {
  const hours24 = date.getHours()
  const suffix = hours24 < 12 ? "AM" : "PM"
  // 0 and 12 both read as 12 on a 12-hour clock.
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12
  const minutes = String(date.getMinutes()).padStart(2, "0")
  const seconds = String(date.getSeconds()).padStart(2, "0")
  return `${hours}:${minutes}:${seconds} ${suffix}`
}

/**
 * The time on the machine looking at the page, ticking every second.
 *
 * The tick is scheduled to the next whole second rather than on a flat
 * 1000 ms interval. A plain interval starts wherever the mount happened and
 * drifts, so the display can sit up to a second behind the real clock and the
 * digits change at a visibly arbitrary moment.
 *
 * Deliberately not a live region. A screen reader announcing the time every
 * second would bury everything else on the page; the label names it once and
 * the value is there to be read on demand.
 */
export function Clock({ className }: { className?: string }) {
  const [now, setNow] = useState(() => new Date())

  useEffect(() => {
    let timer: number
    const tick = () => {
      const date = new Date()
      setNow(date)
      // Land just after the next second turns over.
      timer = window.setTimeout(tick, 1000 - date.getMilliseconds())
    }
    timer = window.setTimeout(tick, 1000 - new Date().getMilliseconds())
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <time
      aria-label="Current time"
      dateTime={now.toISOString()}
      // tabular-nums so the width does not twitch as the digits change.
      className={cn(
        "text-muted-foreground hidden text-sm font-medium tabular-nums sm:block",
        className,
      )}
    >
      {formatClock(now)}
    </time>
  )
}
