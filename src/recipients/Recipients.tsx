import { useTransition } from "react"
import { motion } from "motion/react"
import { CheckIcon, CircleAlertIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AnimatedButton } from "@/components/ui/animated-button"
import { StatusIndicator } from "@/components/ui/status-indicator"
import { SwitchMode } from "@/components/ui/switch-mode"
import { Spinner } from "@/components/ui/spinner"
import { Toggle } from "@/components/ui/toggle"
import { glass } from "@/lib/glass"
import { cn } from "@/lib/utils"
import { useRecipients } from "@/recipients/context"

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
          className="h-11 min-w-0 flex-1 appearance-none rounded-full border border-input bg-background px-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
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

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-lg font-semibold tracking-tight">Recipients</h2>
      {state.emails.length === 0 ? (
        <p className="text-sm text-muted-foreground">None yet.</p>
      ) : (
        <ul className="divide-y divide-border rounded-2xl border border-border">
          {state.emails.map((email) => (
            <RecipientRow key={email} email={email} />
          ))}
        </ul>
      )}
    </section>
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

export function RecipientsDashboard() {
  const { state } = useRecipients()
  const adf = adfView(state.scanner, state.adf)

  return (
    <div className="flex min-h-dvh flex-1 flex-col bg-background">
      <header className={cn(glass.overlay, "sticky top-0 border-b border-white/20 dark:border-white/10")}>
        <div className="mx-auto flex h-16 w-full max-w-xl items-center justify-between gap-4 px-6">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold tracking-tight">Xerox B305</h1>
            <div className="mt-1 flex flex-wrap items-center gap-4">
              <StatusIndicator
                size="sm"
                state={scannerState(state.scanner)}
                label={state.scanner}
              />
              <StatusIndicator
                size="sm"
                state={adf.state}
                label={adf.label}
              />
            </div>
          </div>
          <SwitchMode
            width={84}
            height={42}
            darkColor="#111"
            lightColor="#F9F9F9"
            knobDarkColor="#1C1C1C"
            knobLightColor="#F3F3F7"
            borderDarkColor="#444"
            borderLightColor="#DDD"
          />
        </div>
      </header>

      <main className="flex flex-1 flex-col items-center justify-center bg-black/40 px-4 py-8 sm:px-6">
        <motion.div
          role="dialog"
          aria-labelledby="scan-dialog-title"
          aria-modal="true"
          initial={{
            opacity: 0,
            filter: "blur(4px)",
            transform: "perspective(500px) rotateX(-12deg) scale(0.96)",
          }}
          animate={{
            opacity: 1,
            filter: "blur(0px)",
            transform: "perspective(500px) rotateX(0deg) scale(1)",
          }}
          transition={{ type: "spring", stiffness: 150, damping: 25 }}
          className={cn(
            glass.frosted,
            "squircle grid w-full max-w-[calc(100%-2rem)] gap-4 border border-white/20 p-6 dark:border-white/10 sm:max-w-lg"
          )}
        >
          <div className="flex flex-col gap-2">
            <h2 id="scan-dialog-title" className="text-lg font-semibold leading-none">
              {state.source === "adf" ? "Feeder" : "Glass"}
            </h2>
            {state.source === "adf" ? (
              <p className="text-sm text-muted-foreground">
                Reads the stack in the ADF and merges it into one PDF. Load paper until the header says ADF loaded, then Scan. Mail goes from the sender below to Recipients.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Reads one page from the flatbed. Put the sheet on the glass, then Scan. Mail goes from the sender below to Recipients.
              </p>
            )}
            <p className="text-sm text-muted-foreground">
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
          <RecipientsAddForm />
          <RecipientsList />
          <JobBanner />
          <ScanSourceToggle />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <RecipientsScan />
          </div>
        </motion.div>
      </main>
    </div>
  )
}
