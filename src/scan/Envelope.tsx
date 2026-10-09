import { ChevronDownIcon } from "lucide-react"
import { motion } from "motion/react"
import { useId, useState, type ReactNode } from "react"

import { EASE_OUT, REVEAL_S } from "@/lib/motion"
import { cn } from "@/lib/utils"
import { picked, useRecipients } from "@/recipients/context"

/** Up to this many recipients show as chips. Two fit one line of the Scan column; a third wraps. */
const CHIPS_UP_TO = 2

/** Faces in the folded summary. More than this reads as a crowd, not a group. */
const STACK = 3

/**
 * Who a scan is from and who it goes to, laid out as the mail it becomes.
 *
 * To used to be every address joined by commas, which ran on for as many
 * lines as there were recipients. One or two now show as chips. Past that
 * the line folds into a summary, a stack of initials and "alwin, parth and
 * 5 more", which opens to the full list. Ten recipients take one line
 * until someone asks to see them.
 *
 * Read-only. Who gets scans is switched on Recipients, and Edit goes there.
 */
export function Envelope({ onEdit }: { onEdit: () => void }) {
  const { state } = useRecipients()
  const [open, setOpen] = useState(false)
  const listId = useId()
  const to = picked(state.emails, state.leftOut)

  return (
    <section
      aria-label="Scan mail"
      className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card"
    >
      <Row label="From">
        <div className="flex min-h-7 min-w-0 items-center gap-2.5">
          <Monogram text={state.fromName || state.fromEmail} />
          <p className="min-w-0 truncate text-sm" translate="no">
            {state.fromName ? (
              <span className="font-medium">{state.fromName}</span>
            ) : null}
            <span
              className={
                state.fromName ? "ml-1.5 text-muted-foreground" : "font-medium"
              }
            >
              {state.fromEmail || "—"}
            </span>
          </p>
        </div>
      </Row>
      <Row
        label="To"
        action={
          <button
            type="button"
            onClick={onEdit}
            className="h-7 rounded-lg px-2 text-xs font-medium text-muted-foreground transition-colors duration-150 outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {state.emails.length ? "Edit" : "Add"}
            <span className="sr-only"> recipients</span>
          </button>
        }
      >
        {!state.loaded ? (
          <p className="flex min-h-7 items-center text-sm text-muted-foreground">
            …
          </p>
        ) : to.length === 0 ? (
          <p className="flex min-h-7 items-center text-sm text-muted-foreground">
            {state.emails.length ? "Everyone is switched off" : "Nobody yet"}
          </p>
        ) : to.length <= CHIPS_UP_TO ? (
          <Chips emails={to} />
        ) : (
          <div className="flex min-w-0 flex-col gap-2">
            <button
              type="button"
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => setOpen((value) => !value)}
              className="-mx-1 flex h-7 max-w-full min-w-0 items-center gap-2.5 self-start rounded-lg px-1 transition-colors duration-150 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span aria-hidden className="flex shrink-0 -space-x-1.5">
                {to.slice(0, STACK).map((email) => (
                  <Monogram key={email} text={email} variant="stack" />
                ))}
              </span>
              {/* The names give way first. The count is the part that matters
                  on a narrow screen, so it never truncates. */}
              <span className="flex min-w-0 items-baseline gap-1 text-sm">
                <span className="min-w-0 truncate font-medium" translate="no">
                  {to
                    .slice(0, 2)
                    .map((email) => email.split("@")[0])
                    .join(", ")}
                </span>
                <span className="shrink-0 whitespace-nowrap text-muted-foreground">
                  and {to.length - 2} more
                </span>
              </span>
              <ChevronDownIcon
                aria-hidden
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                  open && "rotate-180"
                )}
              />
            </button>
            {open ? <Chips id={listId} emails={to} reveal /> : null}
          </div>
        )}
      </Row>
    </section>
  )
}

/** Each address in full, behind its initial. `reveal` fades them in, for the list the summary opens. */
function Chips({
  id,
  emails,
  reveal = false,
}: {
  id?: string
  emails: string[]
  reveal?: boolean
}) {
  return (
    <ul
      id={id}
      aria-label="Recipients"
      className="flex min-w-0 flex-wrap gap-1.5"
    >
      {emails.map((email) => (
        <motion.li
          key={email}
          initial={reveal ? { opacity: 0 } : false}
          animate={{ opacity: 1 }}
          transition={{ duration: REVEAL_S, ease: EASE_OUT }}
          className="inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-full border border-border bg-background pr-2.5 pl-0.5 text-xs font-medium"
        >
          <Monogram text={email} variant="chip" />
          <span className="truncate" translate="no">
            {email}
          </span>
        </motion.li>
      ))}
    </ul>
  )
}

/**
 * Label, value and an optional action. Side by side from sm up; on a phone
 * the label and action share a line above, so the value gets the full width
 * instead of being squeezed between them.
 */
function Row({
  label,
  action,
  children,
}: {
  label: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-start gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]">
      <span className="text-xs leading-7 font-medium text-muted-foreground">
        {label}
      </span>
      <div className="col-span-2 row-start-2 min-w-0 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        {children}
      </div>
      <div className="col-start-2 row-start-1 sm:col-start-3">{action}</div>
    </div>
  )
}

/** The first letter of a name or address, standing in for a face. */
function Monogram({
  text,
  variant = "plain",
}: {
  text: string
  variant?: "plain" | "chip" | "stack"
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-semibold text-foreground",
        // In a chip, the chip's border already rings it. In a stack, a ring
        // in the card's colour cuts each disc out of the one beneath.
        variant === "plain" && "border border-border",
        variant === "stack" && "ring-2 ring-card"
      )}
    >
      {text.trim().charAt(0).toUpperCase() || "?"}
    </span>
  )
}
