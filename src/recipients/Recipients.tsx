import { useState, useTransition } from "react"
import { CheckIcon, CircleAlertIcon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty"
import { AccountMenu } from "@/components/AccountMenu"
import { AnimatedButton } from "@/components/ui/animated-button"
import { FluidTabs, type FluidTabItem } from "@/components/ui/fluid-tabs"
import { Separator } from "@/components/ui/separator"
import {
  DashboardSquare01Icon,
  File01Icon,
  Layers01Icon,
  ListViewIcon,
  Mail01Icon,
  PrinterIcon,
  ScanIcon,
} from "@hugeicons/core-free-icons"

import { MacOSSidebar, type MacOSSidebarItem } from "@/components/ui/original"
import { StatusIndicator } from "@/components/ui/status-indicator"
import { Switch } from "@/components/ui/switch"
import { SwitchMode } from "@/components/ui/switch-mode"
import { Spinner } from "@/components/ui/spinner"
import { ClearAllButton } from "@/components/ClearAllButton"
import { Clock } from "@/components/Clock"
import { Segmented } from "@/components/Segmented"
import { clearScans, removeScan } from "@/lib/api"
import { formatWhen, statusLabel } from "@/lib/format"
import { cn } from "@/lib/utils"
import { PrintView } from "@/print/PrintView"
import { picked, useRecipients } from "@/recipients/context"

type View = "overview" | "scan" | "recipients" | "jobs" | "print"

function scannerState(scanner: string): "active" | "idle" | "fixing" | "down" {
  const value = scanner.toLowerCase()
  if (value.includes("idle")) return "active"
  if (value.includes("processing") || value.includes("busy")) return "fixing"
  if (value.includes("unreachable") || value === "?" || value === "…") return "down"
  return "idle"
}

function printerDown(scanner: string): boolean {
  return scannerState(scanner) === "down"
}

// The printer reports scanner state lowercase ("unreachable"); these render as labels.
function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value
}

function adfView(
  scanner: string,
  adf: string
): { state: "active" | "idle"; label: string } {
  const value = (adf || "").toLowerCase()
  if (
    printerDown(scanner) ||
    value === "" ||
    value === "unknown" ||
    value === "?" ||
    value === "…"
  ) {
    return { state: "idle", label: "ADF unknown" }
  }
  if (value.includes("empty")) {
    return { state: "idle", label: "ADF empty" }
  }
  return { state: "active", label: "ADF loaded" }
}

// One or two letters matched most of the workspace, so the list opened almost immediately.
const MIN_SUGGEST_CHARS = 3

function RecipientsAddForm() {
  const { state, actions } = useRecipients()
  const [pending, startTransition] = useTransition()
  const draft = state.draft.trim().toLowerCase()
  const suggestions =
    draft.length < MIN_SUGGEST_CHARS
      ? []
      : state.workspaceEmails.filter((email) => {
          if (state.emails.includes(email)) return false
          const local = email.split("@")[0] || ""
          return email.includes(draft) || local.startsWith(draft)
        })

  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        startTransition(async () => {
          await actions.add()
        })
      }}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          id="recipient-email"
          name="email"
          type="text"
          inputMode="email"
          autoComplete="off"
          spellCheck={false}
          placeholder="name@nexdash.com"
          aria-label="Email"
          value={state.draft}
          aria-invalid={state.invalid}
          onChange={(event) => actions.setDraft(event.target.value)}
          className="h-11 min-w-0 flex-1 appearance-none rounded-full border border-input bg-background px-5 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <AnimatedButton type="submit" size="lg" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Add
        </AnimatedButton>
      </div>
      {suggestions.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {suggestions.slice(0, 6).map((email) => (
            <li key={email}>
              <button
                type="button"
                className="rounded-full border border-input px-2.5 py-1 text-xs hover:bg-muted"
                onClick={() => actions.setDraft(email)}
              >
                {email}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </form>
  )
}

/**
 * One saved address. The switch is whether scans go to it, remembered by
 * the Worker until it is switched again. Off keeps the address on the list
 * for later, which is the point: before, the only way to stop one getting
 * scans was to delete it.
 */
function RecipientRow({ email }: { email: string }) {
  const { state, actions } = useRecipients()
  const [pending, startTransition] = useTransition()
  const to = picked(state.emails, state.leftOut)
  const on = to.includes(email)

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <span
        className={cn(
          "min-w-0 truncate text-sm font-medium transition-colors duration-150",
          on ? "text-foreground" : "text-muted-foreground"
        )}
        translate="no"
      >
        {email}
      </span>
      <div className="flex shrink-0 items-center gap-4">
        <Switch
          checked={on}
          aria-label={`Send scans to ${email}`}
          onCheckedChange={(next) => actions.pick(next ? [...to, email] : to.filter((item) => item !== email))}
        />
        <AnimatedButton
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          aria-label={`Remove ${email}`}
          onClick={() => {
            startTransition(async () => {
              await actions.remove(email)
            })
          }}
        >
          {pending ? <Spinner data-icon="inline-start" /> : null}
          Remove
        </AnimatedButton>
      </div>
    </li>
  )
}

function RecipientsList() {
  const { state } = useRecipients()

  if (!state.loaded) {
    return null
  }

  if (state.emails.length === 0) {
    return <EmptyState title="No recipients" description="A scan still saves the PDF to the office box. Add an address to have it mailed." />
  }

  return (
    <ul className="divide-y divide-border rounded-xl border border-border bg-card">
      {state.emails.map((email) => (
        <RecipientRow key={email} email={email} />
      ))}
    </ul>
  )
}

function JobBanner() {
  const { state } = useRecipients()
  switch (state.jobStatus) {
    case "idle":
      return null
    case "scanning":
      return <StatusIndicator state="fixing" size="sm" label={state.jobMessage} />
    case "sent":
    case "saved":
      return (
        <Alert>
          <CheckIcon />
          <AlertTitle>{state.jobStatus === "sent" ? "Sent" : "Saved"}</AlertTitle>
          <AlertDescription>{state.jobMessage}</AlertDescription>
        </Alert>
      )
    case "failed":
      return (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertTitle>Failed</AlertTitle>
          <AlertDescription>{state.jobMessage}</AlertDescription>
        </Alert>
      )
    default: {
      const _never: never = state.jobStatus
      return _never
    }
  }
}

function ScanSourceToggle() {
  const { state, actions } = useRecipients()
  const feederEmpty = adfView(state.scanner, state.adf).label === "ADF empty"
  const tabs: FluidTabItem[] = [
    { id: "platen", label: "Glass", icon: File01Icon },
    { id: "adf", label: "Feeder", icon: Layers01Icon, disabled: feederEmpty },
  ]

  return (
    <div className="flex flex-col gap-2">
      <FluidTabs
        tabs={tabs}
        value={state.source === "adf" ? "adf" : "platen"}
        onChange={(id) => actions.setSource(id === "adf" ? "adf" : "platen")}
        label="Scan from"
      />
      {feederEmpty ? (
        <p className="text-sm text-muted-foreground">Feeder is empty. Load paper to use it.</p>
      ) : null}
    </div>
  )
}

/**
 * Whether the scan waits as a draft so its pages can be previewed and turned
 * before it is sent, the default, or is mailed the moment it arrives, as it
 * used to be.
 */
function AfterScanChoice() {
  const { state, actions } = useRecipients()
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <span className="text-muted-foreground text-xs font-medium">After scanning</span>
      <Segmented
        label="After scanning"
        value={state.checkFirst ? "check" : "send"}
        onChange={(value) => actions.setCheckFirst(value === "check")}
        disabled={state.jobStatus === "scanning"}
        options={[
          { value: "send", label: "Send right away" },
          { value: "check", label: "Check pages first" },
        ]}
      />
    </div>
  )
}

/**
 * Scans of yours that are held and not yet sent, whichever tab started them.
 * A tab closed mid-review lands here, so a held scan is never out of sight
 * on the screen people come back to.
 */
function HeldScans() {
  const { state, actions } = useRecipients()
  const held = state.scans.filter((row) => row.review)
  if (held.length === 0) {
    return null
  }
  return (
    <section
      aria-labelledby="held-scans-heading"
      className="border-border bg-card flex flex-col gap-2 rounded-xl border px-4 py-3"
    >
      <h3 id="held-scans-heading" className="text-sm font-semibold">
        {held.length === 1 ? "A scan is waiting to be sent" : `${held.length} scans are waiting to be sent`}
      </h3>
      <ul className="flex flex-col gap-2">
        {held.map((row) => (
          <li key={row.review} className="flex items-center justify-between gap-3">
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              Scanned {formatWhen(row.at)}
              {row.stage === "mail_failed" ? " · mail failed, try again" : ""}
            </span>
            <AnimatedButton
              type="button"
              variant="outline"
              size="sm"
              onClick={() => row.review && actions.openReview(row.review)}
            >
              Review
            </AnimatedButton>
          </li>
        ))}
      </ul>
    </section>
  )
}

function RecipientsScan() {
  const { state, actions } = useRecipients()
  // No startTransition here. In React 19 an async transition is an Action, and
  // state set inside one is held until the action settles — so jobStatus never
  // became "scanning" while the scan ran, and everything keyed off it (the job
  // banner, the progress dialog) stayed dark for the whole job.
  const feederEmpty =
    state.source === "adf" && adfView(state.scanner, state.adf).label === "ADF empty"
  const nobody = state.emails.length > 0 && picked(state.emails, state.leftOut).length === 0
  const label =
    state.jobStatus === "scanning"
      ? "Scanning…"
      : state.jobStatus === "sent"
        ? "Sent"
        : state.jobStatus === "failed"
          ? "Retry scan"
          : "Scan"

  return (
    <AnimatedButton
      size="lg"
      className="w-full"
      disabled={state.jobStatus === "scanning" || feederEmpty || nobody}
      onClick={() => {
        void (async () => {
          try {
            await actions.scan()
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Scan failed")
          }
        })()
      }}
    >
      {state.jobStatus === "scanning" ? (
        <Spinner data-icon="inline-start" />
      ) : null}
      {label}
    </AnimatedButton>
  )
}

function StatCard({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint: string
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-5 py-4">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className="mt-2 text-2xl font-semibold tabular-nums">{value}</p>
      <p className="mt-2 text-xs text-muted-foreground">{hint}</p>
    </div>
  )
}

function FieldBox({
  label,
  value,
  mono,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/40 px-4 py-3">
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className={`mt-1 text-sm ${mono ? "font-mono" : ""}`} translate="no">
        {value}
      </p>
    </div>
  )
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <Empty className="border-border bg-card/40 min-h-80 flex-1 rounded-2xl border">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}

function OverviewView() {
  const { state } = useRecipients()
  const adf = adfView(state.scanner, state.adf)
  const online = state.bridgeOnline || scannerState(state.scanner) === "active"
  const last = state.scans[0]

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Bridge"
          value={state.bridgeOnline ? "Online" : "Offline"}
          hint="ESP8266 on NexDash Wi-Fi"
        />
        <StatCard
          label="Recipients"
          value={String(state.emails.length)}
          hint="Empty list means no mail"
        />
        <StatCard
          label="Last scan"
          value={last ? statusLabel(last.stage) : "None"}
          hint={last ? formatWhen(last.at) : "Nothing yet"}
        />
      </div>

      <article className="overflow-hidden rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Xerox B305</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              NexDash office · {state.model}
            </p>
          </div>
          <div className="border-border bg-muted/40 flex flex-wrap items-center gap-2.5 rounded-full border px-3 py-1.5">
            <StatusIndicator
              size="sm"
              state={online ? "active" : "down"}
              label={online ? "Online" : "Offline"}
            />
            <Separator orientation="vertical" className="h-4" />
            <StatusIndicator
              size="sm"
              state={scannerState(state.scanner)}
              label={capitalize(state.scanner)}
            />
            <Separator orientation="vertical" className="h-4" />
            <StatusIndicator size="sm" state={adf.state} label={adf.label} />
          </div>
        </header>

        {/* One tile, so no two-column grid: with Host gone a grid left Sender
            stranded at half width against empty space.
            The toner bars are gone, as is the Supplies screen they
            duplicated. The printer's address is a different case -- it is now
            shown nowhere in the dashboard at all. state.printerHost and the
            Worker's web_ui field are both still populated, so putting it back
            is a line of JSX rather than a round trip; that is why they are
            kept rather than pruned as dead. */}
        <div className="p-5">
          <FieldBox label="Sender" value={state.fromEmail || "—"} />
        </div>

      </article>
    </div>
  )
}

function ScanView() {
  const { state } = useRecipients()
  const to = picked(state.emails, state.leftOut)
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <div>
        <h2 className="text-lg font-semibold">{state.source === "adf" ? "Feeder" : "Glass"}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {state.source === "adf" ? "Stack in the feeder, one PDF." : "One page from the glass."}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          From{" "}
          <span className="font-medium text-foreground" translate="no">
            {state.fromEmail || "—"}
          </span>
        </p>
        {/* Read-only here. Who gets scans is switched on Recipients, and
            saying it next to From means nobody scans without seeing it. */}
        {state.loaded ? (
          <p className="mt-1 text-sm text-muted-foreground">
            To{" "}
            {to.length ? (
              <span className="font-medium text-foreground" translate="no">
                {to.join(", ")}
              </span>
            ) : state.emails.length ? (
              "nobody. Switch someone on under Recipients."
            ) : (
              "nobody yet. Add addresses under Recipients."
            )}
          </p>
        ) : null}
      </div>
      {state.loadError ? (
        <Alert>
          <AlertTitle>{state.loadError}</AlertTitle>
          <AlertDescription>
            Nothing on this page is live until the desk can read the printer.
          </AlertDescription>
        </Alert>
      ) : null}
      <HeldScans />
      <JobBanner />
      <ScanSourceToggle />
      <AfterScanChoice />
      <RecipientsScan />
    </div>
  )
}

function RecipientsView() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4">
      <RecipientsAddForm />
      <RecipientsList />
    </div>
  )
}

function JobsView() {
  const { state, actions } = useRecipients()
  const [busyAt, setBusyAt] = useState<number | null>(null)

  const drop = async (at: number) => {
    setBusyAt(at)
    try {
      await removeScan(at)
      await actions.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not remove that scan")
    } finally {
      setBusyAt(null)
    }
  }

  const clearAll = async () => {
    try {
      await clearScans()
      await actions.refresh()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not clear the scans")
    }
  }

  if (state.scans.length === 0) {
    return <EmptyState title="No scans yet" description="Scans you run from the Scan tab are listed here." />
  }
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">
        <ClearAllButton
          title="Clear your scan jobs?"
          description="Every scan of yours comes off this list, except any still waiting to be sent. The PDFs already emailed are not affected."
          onConfirm={clearAll}
        />
      </div>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-4 py-2 font-medium">When</th>
              <th className="px-4 py-2 font-medium">File</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">To</th>
              {/* The remove column carries only buttons, so its header is for
                  screen readers rather than the eye. */}
              <th className="px-4 py-2 font-medium">
                <span className="sr-only">Remove</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {state.scans.map((row, index) => (
              <tr key={`${row.at}-${index}`} className="border-b border-border last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5">{formatWhen(row.at)}</td>
                <td className="px-4 py-2.5 font-mono text-xs">{row.name || "—"}</td>
                <td className="px-4 py-2.5">
                  {row.error || statusLabel(row.stage)}
                  {row.review && row.expires ? (
                    <span className="text-muted-foreground block text-xs">
                      Kept until {formatWhen(row.expires)}
                    </span>
                  ) : null}
                </td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {/* A dash, not "nobody": the column is a list of addresses,
                      and an empty one reads better as absent than as a word
                      competing with the addresses above and below it. */}
                  {row.recipients.length ? row.recipients.join(", ") : "—"}
                </td>
                <td className="px-2 py-2.5 text-right">
                  {/* A held scan has not been sent, so it gets Review, not ✕:
                      a one-click remove would throw it away unasked. The
                      review has Discard, and that one asks first. */}
                  {row.review ? (
                    <AnimatedButton
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => row.review && actions.openReview(row.review)}
                    >
                      Review
                    </AnimatedButton>
                  ) : (
                    <button
                      type="button"
                      aria-label={`Remove the scan from ${formatWhen(row.at)}`}
                      disabled={busyAt === row.at}
                      onClick={() => void drop(row.at)}
                      className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/50 grid size-8 place-items-center rounded-lg outline-none focus-visible:ring-3 disabled:opacity-50"
                    >
                      <XIcon className="size-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function viewTitle(view: View): string {
  switch (view) {
    case "overview":
      return "Overview"
    case "scan":
      return "Scan"
    case "recipients":
      return "Recipients"
    case "jobs":
      return "Scan jobs"
    case "print":
      return "Print"
    default: {
      const _never: never = view
      return _never
    }
  }
}

function viewSubtitle(view: View): string {
  switch (view) {
    case "overview":
      return ""
    case "scan":
      return "Scan from the glass or the feeder."
    case "recipients":
      return "Addresses your scans go to. Switch one off to leave it out."
    case "jobs":
      return "Scans you have run."
    case "print":
      return "Drop a PDF and the Xerox prints it. One job at a time, in order."
    default: {
      const _never: never = view
      return _never
    }
  }
}

const NAV_ITEMS: MacOSSidebarItem[] = [
  { label: "Overview", icon: DashboardSquare01Icon },
  { label: "Scan", icon: ScanIcon },
  { label: "Recipients", icon: Mail01Icon },
  { label: "Scan jobs", icon: ListViewIcon },
  { label: "Print", icon: PrinterIcon },
]
const NAV_VIEWS: View[] = ["overview", "scan", "recipients", "jobs", "print"]

export function RecipientsDashboard() {
  const { actions } = useRecipients()
  const [view, setView] = useState<View>("overview")
  const [checking, setChecking] = useState(false)

  // Takes a few seconds: the bridge is asked for a new reading and this
  // waits for it, so the button says so rather than looking dead.
  const refreshNow = async () => {
    setChecking(true)
    try {
      await actions.refresh({ fresh: true })
    } finally {
      setChecking(false)
    }
  }
  const title = viewTitle(view)
  const subtitle = viewSubtitle(view)

  return (
    <div className="min-h-dvh bg-background p-3">
      <MacOSSidebar
        items={NAV_ITEMS}
        className="min-h-[calc(100dvh-1.5rem)] w-full max-w-none rounded-2xl shadow-none"
        onSelect={(index) => {
          const next = NAV_VIEWS[index]
          if (next) {
            setView(next)
          }
        }}
      >
        <div className="flex min-h-full flex-col py-3 pr-3">
          <header className="mb-6 flex flex-col gap-4">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex min-w-0 items-center gap-4">
                <div
                  aria-hidden="true"
                  className="min-h-8 w-1 self-stretch rounded-full bg-gradient-to-b from-primary via-primary/50 to-transparent sm:min-h-10 sm:w-1.5"
                />
                <div className="min-w-0">
                  <h1 className="text-foreground text-xl font-bold tracking-tight text-balance sm:text-3xl lg:text-4xl">
                    {title}
                  </h1>
                  {subtitle ? (
                    <p className="text-muted-foreground mt-1 text-xs font-medium sm:text-sm">
                      {subtitle}
                    </p>
                  ) : null}
                </div>
              </div>
              {/* One right-hand cluster. As three siblings under justify-between,
                  the controls were pushed to the middle of the row. */}
              <div className="flex shrink-0 items-center gap-3">
                <Clock />
                <div className="border-border bg-muted/50 flex items-center gap-1.5 rounded-full border p-1.5">
                  <AnimatedButton
                    type="button"
                    variant="outline"
                    disabled={checking}
                    onClick={() => void refreshNow()}
                  >
                    {checking ? "Checking…" : "Refresh"}
                  </AnimatedButton>
                  <Separator orientation="vertical" className="my-1 self-stretch" />
                  <SwitchMode
                    width={72}
                    height={36}
                    darkColor="#111"
                    lightColor="#F9F9F9"
                    knobDarkColor="#1C1C1C"
                    knobLightColor="#F3F3F7"
                    borderDarkColor="#444"
                    borderLightColor="#DDD"
                  />
                </div>
                <AccountMenu />
              </div>
            </div>
            <hr aria-hidden="true" className="border-border" />
          </header>
          <div className="flex min-h-0 flex-1 flex-col">
            {view === "overview" ? <OverviewView /> : null}
            {view === "scan" ? <ScanView /> : null}
            {view === "recipients" ? <RecipientsView /> : null}
            {view === "jobs" ? <JobsView /> : null}
            {view === "print" ? <PrintView /> : null}
          </div>
        </div>
      </MacOSSidebar>
    </div>
  )
}
