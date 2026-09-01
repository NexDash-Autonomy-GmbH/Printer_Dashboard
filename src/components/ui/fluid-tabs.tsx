import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { motion, useReducedMotion } from "motion/react"
import { useId } from "react"

import { cn } from "@/lib/utils"

export interface FluidTabItem {
  id: string
  label: string
  icon: IconSvgElement
  disabled?: boolean
}

interface FluidTabsProps {
  tabs: FluidTabItem[]
  /** Controlled: the owner decides, because a choice can be refused. */
  value: string
  onChange: (id: string) => void
  label: string
  className?: string
}

export function FluidTabs({ tabs, value, onChange, label, className }: FluidTabsProps) {
  const reduce = useReducedMotion()
  // Unique per instance, or two of these on one page would share a pill.
  const pillId = `fluid-tabs-${useId()}`

  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        "border-border bg-muted/60 relative flex w-full items-center gap-1 rounded-full border p-1",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.id === value
        return (
          <button
            key={tab.id}
            type="button"
            aria-pressed={active}
            disabled={tab.disabled}
            onClick={() => onChange(tab.id)}
            className="focus-visible:ring-ring/50 group relative min-w-0 flex-1 cursor-pointer rounded-full px-3 py-2.5 outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50 sm:px-4"
          >
            {active ? (
              <motion.span
                layoutId={pillId}
                transition={
                  reduce
                    ? { duration: 0 }
                    : { type: "spring", stiffness: 280, damping: 25, mass: 0.8 }
                }
                className="bg-primary/20 ring-primary/60 absolute inset-0 rounded-full ring-1 ring-inset"
              />
            ) : null}

            <span
              className={cn(
                "relative z-10 flex items-center justify-center gap-2 transition-colors duration-200",
                active
                  ? "text-foreground font-semibold"
                  : "text-muted-foreground group-hover:text-foreground font-medium",
              )}
            >
              <motion.span
                animate={{ scale: active && !reduce ? 1.03 : 1 }}
                transition={
                  reduce ? { duration: 0 } : { type: "spring", stiffness: 300, damping: 15 }
                }
                className="flex shrink-0 items-center justify-center"
              >
                <HugeiconsIcon icon={tab.icon} className="size-5" aria-hidden />
              </motion.span>
              <span className="truncate text-sm tracking-tight">{tab.label}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
