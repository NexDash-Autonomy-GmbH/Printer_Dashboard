import { CircleAlertIcon, RotateCcwIcon, RotateCwIcon } from "lucide-react"
import { motion, useReducedMotion } from "motion/react"
import { useEffect, useState, type ReactNode } from "react"
import { toast } from "sonner"

import { Segmented, type SegmentedOption } from "@/components/Segmented"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchReviewPdf, type ScanLog } from "@/lib/api"
import { formatWhen } from "@/lib/format"
import { EASE_IN_OUT, EASE_OUT, REVEAL_S, SPRING_PRESS, TURN_S } from "@/lib/motion"
import { useRecipients } from "@/recipients/context"
import type { Thumbnails } from "@/scan/thumbnails"

/**
 * The pages of a held scan, before anyone gets them.
 *
 * Each page turns on its own, and All pages turns every one at once, for the
 * stack that went into the feeder sideways or upside down. What is sent is
 * only the list of angles. The Worker turns its own copy of the scan (see
 * api/pages.ts), so nothing here writes a PDF.
 *
 * Send is live from the moment this opens, before a single thumbnail has
 * drawn. Sending unchanged must stay one click, and it should not wait on a
 * preview it does not need.
 */
export function ReviewDialog() {
  const { state, actions } = useRecipients()
  const review = state.review
  const row = review ? state.scans.find((item) => item.review === review.id) : undefined
  const [busy, setBusy] = useState(false)

  // Closing without sending loses nothing, and this says where it went.
  const later = () => {
    actions.closeReview()
    if (row?.expires) {
      toast(`Kept in Scan jobs until ${formatWhen(row.expires)}`)
    }
  }

  return (
    <AlertDialog open={review?.open ?? false} onOpenChange={(open) => !open && !busy && later()}>
      <AlertDialogContent size="lg" className="flex flex-col">
        {review ? (
          <ReviewBody
            key={review.id}
            id={review.id}
            row={row}
            open={review.open}
            busy={busy}
            setBusy={setBusy}
          />
        ) : null}
      </AlertDialogContent>
    </AlertDialog>
  )
}

type Load = { status: "loading" } | { status: "ready"; count: number } | { status: "failed"; message: string }

/** Quarter turns clockwise, for the All pages control. */
type Quarter = 0 | 1 | 2 | 3

const ALL_PAGES: SegmentedOption<Quarter>[] = [
  { value: 0, label: "As scanned" },
  {
    value: 1,
    label: "90°",
    icon: <RotateCwIcon className="size-3.5" aria-hidden />,
    ariaLabel: "Turn all pages 90° clockwise",
  },
  { value: 2, label: "180°", ariaLabel: "Turn all pages upside down" },
  {
    value: 3,
    label: "90°",
    icon: <RotateCcwIcon className="size-3.5" aria-hidden />,
    ariaLabel: "Turn all pages 90° anticlockwise",
  },
]

function degreesOf(angle: number): number {
  return ((angle % 360) + 360) % 360
}

/** The short way round between two quarters, in quarter turns: -1, 0, 1 or 2. */
function shortest(from: number, to: number): number {
  const turns = (((to - from) % 4) + 4) % 4
  return turns === 3 ? -1 : turns
}

function names(list: string[]): string {
  if (list.length <= 2) return list.join(" and ")
  return `${list[0]}, ${list[1]} and ${list.length - 2} more`
}

function ReviewBody({
  id,
  row,
  open,
  busy,
  setBusy,
}: {
  id: string
  row: ScanLog | undefined
  open: boolean
  busy: boolean
  setBusy: (value: boolean) => void
}) {
  const { actions } = useRecipients()
  const reduce = useReducedMotion() ?? false
  const [load, setLoad] = useState<Load>({ status: "loading" })
  const [thumbs, setThumbs] = useState<string[]>([])
  // Per page, in degrees, and cumulative rather than wrapped: 270 to 360 has
  // to animate as a quarter turn forward, not three back. What is sent is
  // each one wrapped into 0-359.
  const [angles, setAngles] = useState<number[]>([])
  const [all, setAll] = useState<Quarter>(0)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  useEffect(() => {
    let cancelled = false
    let pages: Thumbnails | null = null
    const urls: string[] = []
    void (async () => {
      try {
        // import() in here, not at the top of the file: pdf.js is the
        // heaviest thing the desk can load, and only a review needs it.
        const [pdf, { openThumbnails }] = await Promise.all([
          fetchReviewPdf(id),
          import("@/scan/thumbnails"),
        ])
        if (cancelled) return
        pages = await openThumbnails(pdf)
        if (cancelled) {
          pages.destroy()
          return
        }
        const count = pages.count
        setAngles(new Array<number>(count).fill(0))
        setLoad({ status: "ready", count })
        // One page at a time, in order. pdf.js draws on a single worker
        // anyway, and the first pages are the ones on screen.
        const px = Math.round(180 * Math.min(window.devicePixelRatio || 1, 2))
        for (let index = 0; index < count; index++) {
          const blob = await pages.render(index, px)
          if (cancelled) return
          const url = URL.createObjectURL(blob)
          urls.push(url)
          setThumbs((current) => {
            const next = current.slice()
            next[index] = url
            return next
          })
        }
      } catch (err) {
        if (!cancelled) {
          setLoad({ status: "failed", message: err instanceof Error ? err.message : "Could not load the scan" })
        }
      }
    })()
    return () => {
      cancelled = true
      pages?.destroy()
      urls.forEach((url) => URL.revokeObjectURL(url))
    }
  }, [id])

  const rotate = angles.map(degreesOf)
  const turned = rotate.filter(Boolean).length
  const count = load.status === "ready" ? load.count : 0
  // Sent or discarded somewhere else, or expired, while this was open. Only
  // judged while open: after this tab's own send the row changes too, and
  // the dialog should fade out showing the pages, not this.
  const gone = open && !busy && row === undefined

  const turnPage = (index: number, quarters: number) =>
    setAngles((current) => current.map((angle, i) => (i === index ? angle + quarters * 90 : angle)))

  const turnAll = (next: Quarter) => {
    const delta = shortest(all, next) * 90
    setAngles((current) => current.map((angle) => angle + delta))
    setAll(next)
  }

  const reset = () => {
    setAngles((current) => current.map((angle) => angle + shortest(degreesOf(angle) / 90, 0) * 90))
    setAll(0)
  }

  const send = async () => {
    setBusy(true)
    setError(null)
    try {
      await actions.sendReview(id, rotate)
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the scan")
    } finally {
      setBusy(false)
    }
  }

  const discard = async () => {
    setBusy(true)
    setError(null)
    try {
      await actions.discardReview(id)
      setConfirming(false)
    } catch (err) {
      setConfirming(false)
      setError(err instanceof Error ? err.message : "Could not discard the scan")
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* Left-aligned: centred text over a page grid this wide reads as
          floating free of it. */}
      <AlertDialogHeader className="place-items-start text-left">
        <AlertDialogTitle>Check the pages</AlertDialogTitle>
        <AlertDialogDescription>
          {gone
            ? "This scan is no longer waiting. It was sent, discarded or expired somewhere else."
            : load.status === "ready"
              ? `${count === 1 ? "1 page" : `${count} pages`}${row?.recipients.length ? ` for ${names(row.recipients)}` : ""}. Turn any that came out sideways, then send.`
              : "Nothing has been sent yet. Turn any page that came out sideways, then send."}
        </AlertDialogDescription>
      </AlertDialogHeader>

      {load.status === "ready" && !gone ? (
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-muted-foreground text-xs font-medium">All pages</span>
            <Segmented label="Turn all pages" options={ALL_PAGES} value={all} onChange={turnAll} disabled={busy} />
          </div>
          <div className="text-muted-foreground flex h-8 items-center gap-1 text-xs" aria-live="polite">
            {turned ? `${turned} of ${count} turned` : "As scanned"}
            {turned ? (
              <Button variant="ghost" size="sm" disabled={busy} onClick={reset}>
                Reset
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Not sent</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {gone ? null : load.status === "failed" ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>The pages could not be shown</AlertTitle>
          <AlertDescription>{load.message}. It can still be sent as scanned, or discarded.</AlertDescription>
        </Alert>
      ) : (
        <ol
          aria-label="Pages"
          className="-mx-1 grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-y-auto px-1 py-1 sm:grid-cols-3 md:grid-cols-4"
        >
          {load.status === "ready"
            ? angles.map((angle, index) => (
                <PageTile
                  key={index}
                  index={index}
                  url={thumbs[index]}
                  angle={angle}
                  reduce={reduce}
                  disabled={busy}
                  onTurn={turnPage}
                />
              ))
            : Array.from({ length: 4 }, (_, index) => (
                <li key={index} aria-hidden className="flex flex-col gap-1.5">
                  <Skeleton className="aspect-square w-full rounded-xl motion-reduce:animate-none" />
                  <Skeleton className="h-8 w-full motion-reduce:animate-none" />
                </li>
              ))}
        </ol>
      )}

      <AlertDialogFooter>
        {gone ? null : (
          <AlertDialog open={confirming} onOpenChange={(next) => !busy && setConfirming(next)}>
            <AlertDialogTrigger
              render={<Button variant="ghost" className="text-destructive sm:mr-auto" disabled={busy} />}
            >
              Discard
            </AlertDialogTrigger>
            <AlertDialogContent size="sm">
              <AlertDialogHeader>
                <AlertDialogTitle>Discard this scan?</AlertDialogTitle>
                <AlertDialogDescription>
                  Nobody gets it, and it cannot be brought back. Scan again to start over.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={busy}>Keep it</AlertDialogCancel>
                <AlertDialogAction variant="destructive" disabled={busy} onClick={() => void discard()}>
                  {busy ? "Discarding…" : "Discard"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
        <AlertDialogCancel disabled={busy}>{gone ? "Close" : "Later"}</AlertDialogCancel>
        {gone ? null : (
          <AlertDialogAction disabled={busy} onClick={() => void send()}>
            {busy ? "Sending…" : "Send"}
          </AlertDialogAction>
        )}
      </AlertDialogFooter>
    </>
  )
}

function PageTile({
  index,
  url,
  angle,
  reduce,
  disabled,
  onTurn,
}: {
  index: number
  url: string | undefined
  angle: number
  reduce: boolean
  disabled: boolean
  onTurn: (index: number, quarters: number) => void
}) {
  const page = index + 1
  const shown = degreesOf(angle)

  return (
    <li className="flex flex-col gap-1.5">
      {/* Square, whatever the page's shape. A portrait page turned a quarter
          is exactly as wide as it was tall, so it still fits and nothing
          around it has to move. */}
      <div className="border-border bg-muted/40 relative aspect-square overflow-hidden rounded-xl border">
        {/* Absolutely placed so its height is definite: the image's
            max-h-full needs that to hold a tall page inside the square,
            which a grid cell's auto row does not give it. */}
        <motion.div
          initial={false}
          animate={{ rotate: angle }}
          // Reduced motion: no turn to watch. The page is redrawn in its new
          // position with a short fade, and the angle label changes colour.
          transition={reduce ? { duration: 0 } : { duration: TURN_S, ease: EASE_IN_OUT }}
          className="absolute inset-2 flex items-center justify-center"
        >
          {url ? (
            <motion.img
              key={reduce ? shown : "page"}
              src={url}
              alt=""
              draggable={false}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: REVEAL_S, ease: EASE_OUT }}
              className="ring-foreground/10 max-h-full max-w-full rounded-[2px] object-contain shadow-sm ring-1"
            />
          ) : (
            <Skeleton className="h-full w-3/4 motion-reduce:animate-none" />
          )}
        </motion.div>
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="pl-1 text-xs font-medium tabular-nums">
          Page {page}
          {shown ? <span className="text-primary"> · {shown}°</span> : null}
        </span>
        <div className="flex">
          <TurnButton label={`Turn page ${page} anticlockwise`} quarters={-1} disabled={disabled} reduce={reduce} onClick={() => onTurn(index, -1)}>
            <RotateCcwIcon className="size-4" aria-hidden />
          </TurnButton>
          <TurnButton label={`Turn page ${page} clockwise`} quarters={1} disabled={disabled} reduce={reduce} onClick={() => onTurn(index, 1)}>
            <RotateCwIcon className="size-4" aria-hidden />
          </TurnButton>
        </div>
      </div>
    </li>
  )
}

/**
 * A rotate button whose icon turns the way it will turn the page as it is
 * pressed, so the direction is felt before the page moves. None of that
 * under reduced motion.
 */
function TurnButton({
  label,
  quarters,
  disabled,
  reduce,
  onClick,
  children,
}: {
  label: string
  quarters: number
  disabled: boolean
  reduce: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      whileTap={reduce || disabled ? undefined : "press"}
      className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 grid size-8 place-items-center rounded-lg outline-none focus-visible:ring-3 disabled:opacity-50"
    >
      <motion.span
        variants={{ press: { rotate: quarters * 45, scale: 0.9 } }}
        transition={SPRING_PRESS}
        className="grid place-items-center"
      >
        {children}
      </motion.span>
    </motion.button>
  )
}
