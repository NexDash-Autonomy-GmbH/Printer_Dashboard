import { useTransition } from "react"
import { motion } from "motion/react"
import { CheckIcon, CircleAlertIcon, ScanLineIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AnimatedButton } from "@/components/ui/animated-button"
import { StatusIndicator } from "@/components/ui/status-indicator"
import { SwitchMode } from "@/components/ui/switch-mode"
import { Spinner } from "@/components/ui/spinner"
import { glass } from "@/lib/glass"
import { cn } from "@/lib/utils"
import { useRecipients } from "@/recipients/context"

function scannerState(scanner: string): "active" | "idle" | "fixing" | "down" {
  const value = scanner.toLowerCase()
  if (value.includes("idle")) return "active"
  if (value.includes("processing") || value.includes("busy")) return "fixing"
  if (value.includes("unreachable") || value === "?") return "down"
  return "idle"
}

function RecipientsAddForm() {
  const { state, actions } = useRecipients()
  const [pending, startTransition] = useTransition()

  return (
    <form
      className="flex min-w-0 items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        startTransition(async () => {
          await actions.add()
        })
      }}
    >
      <input
        id="recipient-email"
        name="email"
        type="email"
        inputMode="email"
        autoComplete="off"
        spellCheck={false}
        placeholder="email"
        aria-label="Email"
        value={state.draft}
        aria-invalid={state.invalid}
        onChange={(event) => actions.setDraft(event.target.value)}
        className="h-11 min-w-0 flex-1 rounded-full border border-input bg-background px-4 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <AnimatedButton type="submit" size="lg" disabled={pending}>
        {pending ? <Spinner data-icon="inline-start" /> : null}
        Add
      </AnimatedButton>
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

function RecipientsScan() {
  const { state, actions } = useRecipients()
  const [pending, startTransition] = useTransition()
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
      disabled={pending || state.jobStatus === "scanning"}
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
      ) : (
        <ScanLineIcon data-icon="inline-start" aria-hidden="true" />
      )}
      {label}
    </AnimatedButton>
  )
}

export function RecipientsDashboard() {
  const { state } = useRecipients()
  const adfEmpty = state.adf.toLowerCase().includes("empty")

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
                state={adfEmpty ? "idle" : "active"}
                label={adfEmpty ? "ADF empty" : "ADF loaded"}
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
          <div className="flex flex-col gap-1">
            <h2 id="scan-dialog-title" className="text-lg font-semibold leading-none">
              Scan
            </h2>
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
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <RecipientsScan />
          </div>
        </motion.div>
      </main>
    </div>
  )
}
