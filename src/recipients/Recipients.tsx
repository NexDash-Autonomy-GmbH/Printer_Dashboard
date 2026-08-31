import { useState, useTransition } from "react"
import { CheckIcon, CircleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AnimatedButton } from "@/components/ui/animated-button"
import { MacOSSidebar } from "@/components/ui/original"
import { StatusIndicator } from "@/components/ui/status-indicator"
import { SwitchMode } from "@/components/ui/switch-mode"
import { Spinner } from "@/components/ui/spinner"
import { Toggle } from "@/components/ui/toggle"
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
  try {
    return new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Berlin",
    }).format(new Date(at))
  } catch {
    return new Date(at).toISOString()
  }
}

function RecipientsAddForm() {
  const { state, actions } = useRecipients()
  const [pending, startTransition] = useTransition()
  const draft = state.draft.trim().toLowerCase()
  const suggestions = state.workspaceEmails.filter((email) => {
    if (!draft) return false
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
          className="h-11 min-w-0 flex-1 appearance-none rounded-lg border border-input bg-background px-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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
    return <p className="text-sm text-muted-foreground">None yet. Scan still saves a PDF, it just is not mailed.</p>
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
  if (state.jobStatus === "idle") {
    return null
  }
  if (state.jobStatus === "scanning") {
    return (
      <div className="flex items-center gap-2">
        <StatusIndicator state="fixing" size="sm" label={state.jobMessage} />
      </div>
    )
  }
  if (state.jobStatus === "sent") {
    return (
      <Alert>
        <CheckIcon />
        <AlertTitle>Sent</AlertTitle>
        <AlertDescription>{state.jobMessage}</AlertDescription>
      </Alert>
    )
  }
  if (state.jobStatus === "saved") {
    return (
      <Alert>
        <CheckIcon />
        <AlertTitle>Saved</AlertTitle>
        <AlertDescription>{state.jobMessage}</AlertDescription>
      </Alert>
    )
  }
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>Failed</AlertTitle>
      <AlertDescription>{state.jobMessage}</AlertDescription>
    </Alert>
  )
}

function ScanSourceToggle() {
  const { state, actions } = useRecipients()
  const feederEmpty = adfView(state.scanner, state.adf).label === "ADF empty"
  return (
    <div className="flex flex-col gap-2">
      <div className="flex w-full gap-1 rounded-lg border border-input p-0.5" role="group" aria-label="Scan from">
        <Toggle
          variant="outline"
          className="min-w-0 flex-1 border-0 shadow-none data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          pressed={state.source !== "adf"}
          onPressedChange={() => actions.setSource("platen")}
        >
          Glass
        </Toggle>
        <Toggle
          variant="outline"
          className="min-w-0 flex-1 border-0 shadow-none data-[state=on]:bg-accent data-[state=on]:text-accent-foreground"
          pressed={state.source === "adf"}
          disabled={feederEmpty}
          onPressedChange={() => actions.setSource("adf")}
        >
          Feeder
        </Toggle>
      </div>
      {feederEmpty ? (
        <p className="text-sm text-muted-foreground">Feeder is empty. Load paper to use it.</p>
      ) : null}
    </div>
  )
}

function RecipientsScan() {
  const { state, actions } = useRecipients()
  const [pending, startTransition] = useTransition()
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
      disabled={pending || state.jobStatus === "scanning" || feederEmpty}
      onClick={() => {
        startTransition(async () => {
          try {
            await actions.scan()
          } catch (error) {
            toast.error(error instanceof Error ? error.message : "Scan failed")
          }
        })
      }}
    >
      {pending || state.jobStatus === "scanning" ? (
        <Spinner data-icon="inline-start" />
      ) : null}
      {label}
    </AnimatedButton>
  )
}

function OverviewView() {
  const { state } = useRecipients()
  const adf = adfView(state.scanner, state.adf)
  const online = state.bridgeOnline || scannerState(state.scanner) === "active"
  const last = state.scans[0]

  return (
    <div className="flex flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Bridge</p>
          <p className="mt-2 text-2xl font-semibold">{online ? "Online" : "Offline"}</p>
          <p className="mt-1 text-xs text-muted-foreground">ESP8266 on NexDash Wi-Fi</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Recipients</p>
          <p className="mt-2 text-2xl font-semibold">{state.emails.length}</p>
          <p className="mt-1 text-xs text-muted-foreground">Empty list means no mail</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Last scan</p>
          <p className="mt-2 text-2xl font-semibold">{last ? last.stage : "None"}</p>
          <p className="mt-1 text-xs text-muted-foreground">{last ? formatWhen(last.at) : "Nothing yet"}</p>
        </div>
      </div>

      <article className="overflow-hidden rounded-xl border border-border bg-card">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Xerox B305</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">NexDash office · {state.model}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <StatusIndicator size="sm" state={online ? "active" : "down"} label={online ? "online" : "offline"} />
            <StatusIndicator size="sm" state={scannerState(state.scanner)} label={state.scanner} />
            <StatusIndicator size="sm" state={adf.state} label={adf.label} />
          </div>
        </header>
        <div className="grid gap-3 p-5 sm:grid-cols-2">
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Host</p>
            <p className="mt-1 font-mono text-sm" translate="no">
              {state.printerHost || "192.168.68.52"}
            </p>
          </div>
          <div className="rounded-lg bg-muted/50 px-3 py-2">
            <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Sender</p>
            <p className="mt-1 text-sm" translate="no">
              {state.fromEmail || "SMTP_FROM_EMAIL"}
            </p>
          </div>
        </div>
        {state.supplies?.toners.length ? (
          <div className="flex flex-col gap-3 border-t border-border px-5 py-4">
            {state.supplies.toners.map((row) => (
              <SupplyRow key={row.name} name={row.name} pct={row.pct} color={row.color} />
            ))}
          </div>
        ) : null}
        <footer className="flex items-center justify-between border-t border-border px-5 py-3 text-xs text-muted-foreground">
          <span>
            {state.supplies?.pages != null ? `${state.supplies.pages} pages` : "eSCL scan · PDF mail"}
          </span>
          <span>
            {state.supplies?.checked_at
              ? `SNMP ${formatWhen(state.supplies.checked_at * 1000)}`
              : "SNMP when the office box can reach the Xerox"}
          </span>
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
    return (
      <p className="text-sm text-muted-foreground">
        No SNMP data yet. The Xerox B305 speaks Printer-MIB (community public by default). A box on the
        office LAN has to poll UDP 161 and post it here. That is the launchd dashboard or office-agent, not
        Cloudflare.
      </p>
    )
  }
  return (
    <div className="flex max-w-xl flex-col gap-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Status</p>
          <p className="mt-2 text-xl font-semibold">{supplies.status}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Page count</p>
          <p className="mt-2 text-xl font-semibold">{supplies.pages ?? "—"}</p>
        </div>
      </div>
      {supplies.console ? (
        <p className="rounded-lg border border-border bg-muted/40 px-3 py-2 font-mono text-xs">{supplies.console}</p>
      ) : null}
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Supplies</h3>
        {supplies.toners.map((row) => (
          <SupplyRow key={row.name} name={row.name} pct={row.pct} color={row.color} />
        ))}
      </section>
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-semibold">Trays</h3>
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
          <h3 className="text-sm font-semibold">Alerts</h3>
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
          {state.source === "adf"
            ? "Reads the stack in the ADF and merges it into one PDF. Mail goes from the sender to Recipients."
            : "Reads one page from the flatbed. Mail goes from the sender to Recipients."}
        </p>
        <p className="mt-2 text-sm text-muted-foreground">
          Sender{" "}
          <span className="font-medium text-foreground" translate="no">
            {state.fromEmail || "SMTP_FROM_EMAIL"}
          </span>
        </p>
      </div>
      {state.loadError ? (
        <Alert>
          <AlertTitle>Printer unreachable</AlertTitle>
          <AlertDescription>{state.loadError}</AlertDescription>
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
      <div>
        <h2 className="text-lg font-semibold">Recipients</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Each scan PDF is mailed to this list. The sender is never a recipient.
        </p>
      </div>
      <RecipientsAddForm />
      <RecipientsList />
    </div>
  )
}

function JobsView() {
  const { state } = useRecipients()
  if (state.scans.length === 0) {
    return <p className="text-sm text-muted-foreground">No scans yet. Use Scan after the office bridge is online.</p>
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
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

function viewCopy(view: View): { title: string; sub: string } {
  switch (view) {
    case "overview":
      return { title: "Overview", sub: "Xerox B305 at the office" }
    case "scan":
      return { title: "Scan", sub: "Glass or feeder, then mail the PDF" }
    case "recipients":
      return { title: "Recipients", sub: "Who gets the scanned PDF" }
    case "jobs":
      return { title: "Scan jobs", sub: "Recent jobs on the cloud API" }
    case "supplies":
      return { title: "Supplies", sub: "Toner, trays, and alerts from SNMP" }
    default: {
      const _never: never = view
      return _never
    }
  }
}

const NAV_ITEMS = ["Overview", "Supplies", "Scan", "Recipients", "Scan jobs"] as const
const NAV_VIEWS: View[] = ["overview", "supplies", "scan", "recipients", "jobs"]

export function RecipientsDashboard() {
  const { actions } = useRecipients()
  const [view, setView] = useState<View>("overview")
  const copy = viewCopy(view)

  return (
    <div className="min-h-dvh bg-background p-3">
      <MacOSSidebar
        items={[...NAV_ITEMS]}
        className="min-h-[calc(100dvh-1.5rem)] w-full max-w-none rounded-2xl shadow-none"
        onSelect={(index) => {
          const next = NAV_VIEWS[index]
          if (next) {
            setView(next)
          }
        }}
        onAdd={() => setView("scan")}
      >
        <div className="flex min-h-full flex-col py-3 pr-3">
          <header className="mb-6 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="text-base font-semibold">{copy.title}</h1>
              <p className="text-xs text-muted-foreground">{copy.sub}</p>
            </div>
            <div className="flex items-center gap-2">
              <AnimatedButton type="button" variant="outline" size="sm" onClick={() => void actions.refresh()}>
                Refresh
              </AnimatedButton>
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
          </header>
          <div className="flex-1">
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
