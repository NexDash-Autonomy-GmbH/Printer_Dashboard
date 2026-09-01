import { useState, useTransition } from "react"
import { CheckIcon, CircleAlertIcon } from "lucide-react"
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
  DropletIcon,
  ListViewIcon,
  Mail01Icon,
  ScanIcon,
} from "@hugeicons/core-free-icons"

import { MacOSSidebar, type MacOSSidebarItem } from "@/components/ui/original"
import { StatusIndicator } from "@/components/ui/status-indicator"
import { SwitchMode } from "@/components/ui/switch-mode"
import { Spinner } from "@/components/ui/spinner"
import { useRecipients } from "@/recipients/context"

type View = "overview" | "scan" | "recipients" | "jobs" | "supplies"

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

function formatWhen(at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(at))
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

function RecipientRow({ email }: { email: string }) {
  const { actions } = useRecipients()
  const [pending, startTransition] = useTransition()

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <CheckIcon className="size-3.5" aria-hidden="true" />
        </span>
        <span className="truncate text-sm font-medium" translate="no">
          {email}
        </span>
      </div>
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


function RecipientsScan() {
  const { state, actions } = useRecipients()
  // No startTransition here. In React 19 an async transition is an Action, and
  // state set inside one is held until the action settles — so jobStatus never
  // became "scanning" while the scan ran, and everything keyed off it (the job
  // banner, the progress dialog) stayed dark for the whole job.
  const feederEmpty =
    state.source === "adf" && adfView(state.scanner, state.adf).label === "ADF empty"
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
      disabled={state.jobStatus === "scanning" || feederEmpty}
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
          value={last ? last.stage : "None"}
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

        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <FieldBox label="Host" value={state.printerHost || "192.168.68.52"} mono />
          <FieldBox label="Sender" value={state.fromEmail || "—"} />
        </div>

        {state.supplies?.toners.length ? (
          <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
            {state.supplies.toners.map((row) => (
              <SupplyRow key={row.name} name={row.name} pct={row.pct} color={row.color} />
            ))}
          </div>
        ) : null}

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-5 py-3 text-xs text-muted-foreground">
          <span>eSCL scan · PDF mail</span>
          <span>SNMP when the office box can reach the Xerox</span>
        </footer>
      </article>
    </div>
  )
}

function SupplyRow({ name, pct, color }: { name: string; pct: number | null; color: string }) {
  const width = pct == null ? "0%" : `${pct}%`
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{name}</span>
        <span className="font-medium">{pct == null ? "unknown" : `${pct}%`}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width, background: color }} />
      </div>
    </div>
  )
}

function SuppliesView() {
  const { state } = useRecipients()
  const supplies = state.supplies
  if (!supplies || (!supplies.online && supplies.toners.length === 0)) {
    return <EmptyState title="No SNMP reading" description="Supplies appear once the office box can reach the Xerox." />
  }
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Status</p>
          <p className="mt-2 text-xl font-semibold">{supplies.status}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">Pages</p>
          <p className="mt-2 text-xl font-semibold">{supplies.pages ?? "—"}</p>
        </div>
      </div>
      {supplies.console ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs">{supplies.console}</p>
      ) : null}
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Supplies</h2>
        {supplies.toners.map((row) => (
          <SupplyRow key={row.name} name={row.name} pct={row.pct} color={row.color} />
        ))}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className="text-sm font-semibold">Trays</h2>
        {supplies.trays.map((row) => (
          <SupplyRow
            key={row.name}
            name={`${row.name} (${row.status})`}
            pct={row.pct}
            color="#3b82f6"
          />
        ))}
      </section>
      {supplies.alerts.length ? (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold">Alerts</h2>
          {supplies.alerts.map((alert) => (
            <p key={alert.desc} className="rounded-lg border border-border px-3 py-2 text-sm">
              {alert.severity}: {alert.desc}
            </p>
          ))}
        </section>
      ) : null}
    </div>
  )
}

function ScanView() {
  const { state } = useRecipients()
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
      </div>
      {state.loadError ? (
        <Alert>
          <AlertTitle>{state.loadError}</AlertTitle>
          <AlertDescription>
            Nothing on this page is live until the desk can read the printer.
          </AlertDescription>
        </Alert>
      ) : null}
      <JobBanner />
      <ScanSourceToggle />
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
  const { state } = useRecipients()
  if (state.scans.length === 0) {
    return <EmptyState title="No scans yet" description="Scans you run from the Scan tab are listed here." />
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="px-4 py-2 font-medium">When</th>
            <th className="px-4 py-2 font-medium">File</th>
            <th className="px-4 py-2 font-medium">Status</th>
            <th className="px-4 py-2 font-medium">To</th>
          </tr>
        </thead>
        <tbody>
          {state.scans.map((row, index) => (
            <tr key={`${row.at}-${index}`} className="border-b border-border last:border-0">
              <td className="whitespace-nowrap px-4 py-2.5">{formatWhen(row.at)}</td>
              <td className="px-4 py-2.5 font-mono text-xs">{row.name || "—"}</td>
              <td className="px-4 py-2.5">{row.error || row.stage}</td>
              <td className="px-4 py-2.5 text-muted-foreground">
                {row.recipients.length ? row.recipients.join(", ") : "nobody"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
    case "supplies":
      return "Supplies"
    default: {
      const _never: never = view
      return _never
    }
  }
}

function viewSubtitle(view: View): string {
  switch (view) {
    case "overview":
      return "Xerox B305 at the office"
    case "scan":
      return "Scan from the glass or the feeder."
    case "recipients":
      return "Addresses that get the PDF."
    case "jobs":
      return "Scans this desk has run."
    case "supplies":
      return "Toner, trays and alerts over SNMP."
    default: {
      const _never: never = view
      return _never
    }
  }
}

const NAV_ITEMS: MacOSSidebarItem[] = [
  { label: "Overview", icon: DashboardSquare01Icon },
  { label: "Supplies", icon: DropletIcon },
  { label: "Scan", icon: ScanIcon },
  { label: "Recipients", icon: Mail01Icon },
  { label: "Scan jobs", icon: ListViewIcon },
]
const NAV_VIEWS: View[] = ["overview", "supplies", "scan", "recipients", "jobs"]

export function RecipientsDashboard() {
  const { actions } = useRecipients()
  const [view, setView] = useState<View>("overview")
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
                  <p className="text-muted-foreground mt-1 text-xs font-medium sm:text-sm">
                    {subtitle}
                  </p>
                </div>
              </div>
              {/* One right-hand cluster. As three siblings under justify-between,
                  the controls were pushed to the middle of the row. */}
              <div className="flex shrink-0 items-center gap-3">
                <div className="border-border bg-muted/50 flex items-center gap-1.5 rounded-full border p-1.5">
                  <AnimatedButton
                    type="button"
                    variant="outline"
                    onClick={() => void actions.refresh()}
                  >
                    Refresh
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
            {view === "supplies" ? <SuppliesView /> : null}
          </div>
        </div>
      </MacOSSidebar>
    </div>
  )
}
