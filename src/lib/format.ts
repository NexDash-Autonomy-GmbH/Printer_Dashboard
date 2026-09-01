/** Berlin wall-clock, day-month-year, since the desk and the printer are in one office. */
export function formatWhen(at: number): string {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Berlin",
  }).format(new Date(at))
}
