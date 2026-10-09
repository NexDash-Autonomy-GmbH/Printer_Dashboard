import { CheckIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"

import { SPRING_PRESS } from "@/lib/motion"
import { cn } from "@/lib/utils"

/**
 * Which saved recipients one scan goes to. Each address is a chip that is
 * either in or out, so sending to one of several is a tap on the others.
 *
 * Every saved recipient used to get every scan, with nothing on screen to
 * say so: adding a second address quietly meant the first could no longer
 * get a scan by itself.
 */
export function RecipientPicker({
  label,
  options,
  picked,
  onChange,
  disabled = false,
}: {
  label: string
  options: string[]
  picked: string[]
  onChange: (to: string[]) => void
  disabled?: boolean
}) {
  const reduce = useReducedMotion() ?? false

  // Rebuilt from options rather than appended to, so the pick always reads
  // in the same order as the chips.
  const toggle = (email: string) =>
    onChange(options.filter((item) => (item === email ? !picked.includes(item) : picked.includes(item))))

  return (
    <div role="group" aria-label={label} className="flex min-w-0 flex-wrap gap-1.5">
      {options.map((email) => {
        const on = picked.includes(email)
        return (
          <motion.button
            key={email}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => toggle(email)}
            whileTap={reduce || disabled ? undefined : { scale: 0.97 }}
            transition={SPRING_PRESS}
            className={cn(
              "focus-visible:ring-ring/50 inline-flex h-8 max-w-full min-w-0 items-center gap-1.5 rounded-full border pr-3 pl-1.5 text-xs font-medium outline-none transition-colors duration-150 focus-visible:ring-3 disabled:opacity-55",
              on
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-input text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <span
              aria-hidden
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-full transition-colors duration-150",
                on ? "bg-primary text-primary-foreground" : "border-input border"
              )}
            >
              {on ? <CheckIcon className="size-3" /> : null}
            </span>
            <span className="truncate" translate="no">
              {email}
            </span>
          </motion.button>
        )
      })}
    </div>
  )
}
