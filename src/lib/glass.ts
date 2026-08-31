/**
 * Floating glass from Shoogle @ai2/glass (Delphi-style inset highlight).
 * Header uses overlay; the scan dialog uses frosted. Do not stack glass on glass.
 */
export const glass = {
  overlay:
    "bg-background/60 backdrop-blur-[8px] " +
    "[box-shadow:0_-1px_1px_0_rgba(255,255,255,0.5)_inset,0_1px_1px_0_rgba(255,255,255,1)_inset,0_2px_4px_0_rgba(0,0,0,0.1)] " +
    "dark:[box-shadow:0_-1px_1px_0_rgba(255,255,255,0.1)_inset,0_1px_1px_0_rgba(255,255,255,0.15)_inset,0_2px_4px_0_rgba(0,0,0,0.5)]",
  frosted:
    "bg-background/70 dark:bg-background/80 backdrop-blur-[8px] " +
    "[box-shadow:0_-1px_1px_0_rgba(255,255,255,0.5)_inset,0_1px_1px_0_rgba(255,255,255,1)_inset,0_24px_24px_0_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)] " +
    "dark:[box-shadow:0_-1px_1px_0_rgba(255,255,255,0.1)_inset,0_1px_1px_0_rgba(255,255,255,0.15)_inset,0_24px_24px_0_rgba(0,0,0,0.05),0_0_0_1px_rgba(0,0,0,0.05)]",
} as const
