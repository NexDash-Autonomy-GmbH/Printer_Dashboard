import { useEffect, useState } from "react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { fetchIdentity, LOGOUT_URL, type Identity } from "@/lib/identity"

function initials(identity: Identity): string {
  const source = identity.name?.trim() || identity.email
  const parts = source.split(/[\s.@_-]+/).filter(Boolean)
  const letters = parts.slice(0, 2).map((p) => p[0])
  return (letters.join("") || source[0] || "?").toUpperCase()
}

export function AccountMenu() {
  const [identity, setIdentity] = useState<Identity | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    void fetchIdentity(controller.signal).then(setIdentity)
    return () => controller.abort()
  }, [])

  // Nothing to show when Access is not in front — local dev, mainly. Rendering
  // a signed-out state would be a lie: you cannot reach this page signed out.
  if (!identity) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className="focus-visible:ring-ring/50 border-border bg-muted/60 text-foreground grid size-9 shrink-0 cursor-pointer place-items-center rounded-full border text-xs font-semibold outline-none focus-visible:ring-3"
        aria-label={`Signed in as ${identity.email}`}
        title={identity.email}
      >
        {initials(identity)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <div className="border-border border-b px-3 py-2.5">
          {identity.name ? (
            <p className="truncate text-sm font-medium">{identity.name}</p>
          ) : null}
          <p className="text-muted-foreground truncate text-xs" translate="no">
            {identity.email}
          </p>
        </div>
        <div className="p-1">
          <DropdownMenuItem
            className="cursor-pointer rounded-lg"
            onClick={() => {
              // Access owns the session, so signing out is its endpoint, not ours.
              window.location.href = LOGOUT_URL
            }}
          >
            Sign out
          </DropdownMenuItem>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
