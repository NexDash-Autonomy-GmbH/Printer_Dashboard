/** Berlin wall-clock, day-month-year, since the desk and the printer are in one office. */
export function formatWhen(at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(at))
}

/** Byte counts for humans. Whole KB, one decimal at MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/**
 * A stored status token as a label: first letter capitalised, and every letter
 * after an underscore too, with the underscores read as spaces.
 *
 *   saved       -> Saved
 *   scan_failed -> Scan Failed
 */
export function statusLabel(token: string): string {
  return token
    .split("_")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ")
}
