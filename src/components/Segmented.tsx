import { motion, useReducedMotion } from "motion/react"
import { useId, type ReactNode } from "react"

import { SPRING_LAYOUT, SPRING_PRESS } from "@/lib/motion"
import { cn } from "@/lib/utils"

export type SegmentedOption<T> = {
  value: T
  label: string
  /** Shown before the label. Decorative: the label carries the meaning. */
  icon?: ReactNode
  /** Spoken instead of the label, when the label alone is too terse. */
  ariaLabel?: string
}

/**
 * A choice between named options, drawn like the Sides control on Print.
 *
 * Every option says what it does, so nobody has to work out what a switch's
 * off position means. The pill that marks the choice slides between options
 * rather than blinking, so it reads as one thing moving. Under reduced
 * motion it jumps, and the colour change still shows which one is on.
 */
export function Segmented<T extends string | number>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  className,
}: {
  label: string
  options: SegmentedOption<T>[]
  value: T
  onChange: (value: T) => void
  disabled?: boolean
  className?: string
}) {
  const reduce = useReducedMotion() ?? false
  // Unique per instance, or two of these on one screen would share a pill.
  const pillId = `segmented-${useId()}`

  return (
    // The hairline, like FluidTabs has: on the Scan screen this sits on the
    // desk, which is muted already, and without it the track disappeared.
    <div
      role="group"
      aria-label={label}
      className={cn("border-border bg-muted/60 flex gap-1 rounded-xl border p-1", className)}
    >
      {options.map((option) => {
        const on = option.value === value
        return (
          <motion.button
            key={String(option.value)}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            aria-label={option.ariaLabel}
            onClick={() => onChange(option.value)}
            whileTap={reduce || disabled ? undefined : { scale: 0.97 }}
            transition={SPRING_PRESS}
            className="focus-visible:ring-ring/50 relative flex-1 rounded-lg px-3 py-1.5 text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-3 disabled:opacity-55"
          >
            {on ? (
              <motion.span
                aria-hidden
                layoutId={pillId}
                transition={reduce ? { duration: 0 } : SPRING_LAYOUT}
                className="bg-card absolute inset-0 rounded-lg shadow-sm"
              />
            ) : null}
            <span
              className={cn(
                "relative flex items-center justify-center gap-1.5 transition-colors duration-150",
                on ? "text-foreground" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {option.icon}
              {option.label}
            </span>
          </motion.button>
        )
      })}
    </div>
  )
}
