# Printer Dashboard Design System

## 0. Research Log

- Embedded refs: Linear operate density, Xerox machine housing → the desk uses the MacOS-style sidebar shell, Xerox tokens, live printer data. A Bionis-derived shell and beUI were both tried and removed; neither is in the product UI.
- Lazyweb: skipped. This is a private office scan desk; there is no public competitor screen set worth cloning.
- Imagen drafts: skipped. Operate surface; the Xerox itself is the visual object, and motion/react supplies the motion primitives.
- Skipped lanes: lazyweb and imagen — no public screen corpus, and no hero photography in an authenticated scan UI.

## 1. Atmosphere & Identity

A fluorescent office next to a Xerox B305. The machine is light gray plastic by day and a dark lid at night, with one red Xerox mark. The sidebar is the housing; the canvas is the desk. No beUI. Signature: cool housing gray, hairline split, NexDash green on Scan. Not cream paper. Overview opens on three summary cards — bridge, recipients, last scan — above the machine panel; they earn their place by reading live state, so keep them factual and never pad the row to fill it.

## 2. Color

The NexDash palette, ported from NexOS (`frontend/src/index.css`, HSL converted to oklch). One accent: NexDash green, `hsl(160 61% 40%)` dark / `hsl(160 61% 34%)` light — the same green as the NexOS page-header glow. Used on primary actions, focus, the accent bar and the healthy status dot.

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface | --background | oklch(1 0 0) | oklch(0.107 0.012 261.1) | Desk canvas, sidebar rail |
| Text | --foreground | oklch(0 0 0) | oklch(0.984 0.003 247.9) | Body, titles |
| Panel | --card | oklch(1 0 0) | oklch(0.136 0.016 262.7) | Raised lists, tables, stat cards |
| Accent | --primary | oklch(0.571 0.108 165.6) | oklch(0.643 0.123 165.4) | Scan, accent bar, focus |
| Accent text | --primary-foreground | oklch(1 0 0) | oklch(0.16 0.014 262) | On green |
| Quiet text | --muted-foreground | oklch(0.555 0.041 257.4) | oklch(0.71 0.035 256.8) | Labels, hints |
| Quiet fill | --muted | oklch(0.968 0.007 247.9) | oklch(0.275 0.036 259.7) | Desk behind the rail, secondary fills |
| Hover fill | --accent | oklch(0.929 0.013 255.5) | oklch(0.177 0.029 265.8) | Nav active pill, hover states |
| Line | --border | oklch(0.929 0.013 255.5) | oklch(1 0 0 / 12%) | Hairlines |
| Danger | --destructive | oklch(0.637 0.208 25.3) | oklch(0.636 0.208 25.4) | Failed scan |

### Machine status

Status is semantic, not brand. It has its own tokens so a dot never borrows a Tailwind primitive:

| Role | Token | Light | Dark |
|------|-------|-------|------|
| Reachable | --status-ok | oklch(0.571 0.108 165.6) | oklch(0.643 0.123 165.4) |
| Busy | --status-warn | oklch(0.68 0.155 70) | oklch(0.75 0.15 70) |
| Down | --status-down | oklch(0.637 0.208 25.3) | oklch(0.636 0.208 25.4) |

`--status-ok` deliberately equals `--primary`: a healthy machine is on-brand, and a second green would read as a different meaning.

Toner bar fills may use SNMP-reported colors from the printer. Those are data, not theme tokens.

### Rules

- No warm cream, no second accent. Xerox red is gone; this is a NexDash tool, so it wears NexDash green.
- Accent is for action and selection, not decoration.
- Light surfaces are white on a near-white desk; borders carry the separation, not fills.
- Never reach for a Tailwind color primitive (`bg-red-500`). Add a token here first.

## 3. Typography

### Scale

| Level | Size | Weight | Line height | Tracking | Usage |
|-------|------|--------|-------------|----------|-------|
| Title | 1.5rem | 600 | 1.2 | -0.02em | Overview machine name |
| H2 | 1.125rem | 600 | 1.3 | -0.01em | View headings |
| Body | 0.875rem | 400 | 1.45 | 0 | Default UI |
| Caption | 0.75rem | 500 | 1.4 | 0 | Meta, badges |
| Display number | 1.875rem | 600 | 1.1 | -0.03em | Page count |

### Font stack

- Primary: Instrument Sans 400/500/600/700, self-hosted. User-pinned. Fallback: Instrument Sans Fallback (same files), then sans-serif.
- Mono: ui-monospace for host, filenames, console.

### Rules

- One family. No Inter. No serif.
- Sentence case. No tracked uppercase eyebrows.
- Tabular figures on page counts and percents.

## 4. Spacing & Layout

### Base unit

4px.

| Token | Value | Usage |
|-------|-------|-------|
| --space-2 | 8px | Icon/label |
| --space-3 | 12px | Compact controls |
| --space-4 | 16px | Header, list rows |
| --space-5 | 20px | View padding (mobile) |
| --space-6 | 24px | Form stacks |
| --space-8 | 32px | View padding (desktop) |
| --space-10 | 40px | Overview column gap |

### Grid

- Shell: `MacOSSidebar` (`src/components/ui/original.tsx`), an icon rail that animates 240px ↔ 64px, plus a page header and a scrolling `main`. Collapsed, the rail keeps the icons.
- Overview: stacked machine status + four metric cards, then a 1→3 card row from `xl`.
- Scan/recipients: single column, max 28rem.
- Breakpoints: sm 640, md 768, lg 1024.

### Rules

- No three equal cards as page structure.
- Hairlines over nested cards.
- Sidebar collapses to icons, then an off-canvas drawer under 768px.

## 5. Components

### Sidebar

- `SidebarProvider`, Xerox mark, Desk nav. No footer, no sender line, no promo card.
- Expanded, collapsed, mobile sheet. Active item is a bordered pill.
- `b` toggles. URL is the view (`/`, `/scan`, `/recipients`, `/supplies`, `/jobs`).

### Theme

- Outline icon in the topbar. Local Vite `ThemeProvider` (`setTheme` / `resolvedTheme`), not `next-themes`.

### Status

- shadcn `Badge` for online, scanner, ADF.

### Scan source

- `ToggleGroup`. Feeder disabled when ADF is empty.

### Scan action

- shadcn `Button` + `Spinner` while the job runs.

### Recipients

- `Field` + `Input`. Invalid field uses `data-invalid` / `aria-invalid`.
- Each row: the address, an on/off `Switch` for whether scans go to it (saved per person by the Worker), then Remove. Switched off, the address reads muted.

### Scan mail

- `src/scan/Envelope.tsx`, at the top of Scan. One bordered card, a hairline between From and To. Read-only: who gets scans is switched on Recipients, and the card's Edit goes there.
- From: monogram, sender name, address muted.
- To: one or two recipients as chips (monogram + full address). Three or more fold into one line: up to three overlapping monograms, the first two names, and "and N more", which never truncates. It opens the full chip list, which fades in.
- Monograms are the first letter on `--muted`. No per-person colours; there is one accent and it is not decoration.
- Under 640px the label moves above the value so addresses get the full width.

### Pages

- Tabular number from SNMP. No ticker.

## 6. Motion & Interaction

| Type | Duration | Usage |
|------|----------|-------|
| Color | 150ms | Hover, focus ring |
| Sidebar | shadcn width transition | Collapse |
| Page turn | 220ms ease-in-out | Scan review thumbnails, per page and All pages |
| Segmented pill | spring 420/34 | `Segmented`: After scanning, All pages |
| Review dialog | 200ms fade + zoom | `AlertDialogContent size="lg"` |

Named tokens live in `src/lib/motion.ts`.

### Rules

- No decorative motion. Honor `prefers-reduced-motion` on the spinner.
- No page-load choreography.
- Reduced motion keeps opacity and colour, and drops travel and scale: a page snaps to its new angle and fades in, the pill jumps, dialogs fade without zooming.

## 7. Depth & Surface

Strategy: **borders-only**. Sidebar is the same cool housing as the desk, split by a hairline (dark mode: a darker lid). No glass. No drop shadows.

## 8. Accessibility Constraints & Accepted Debt

- **Text on the accent, dark mode — fixed, deviates from NexOS.** NexOS pairs near-white with `hsl(160 61% 40%)`, which measures **2.99:1** and fails AA at any size. Dark mode here puts dark ink on the same green instead: **6.22:1**. The brand colour is unchanged; only the text on it is.
- **Text on the accent, light mode — accepted debt at 4.20:1.** White on `hsl(160 61% 34%)` is NexOS's shipped pairing. It clears AA for large text but sits just under the 4.5:1 bar for normal text, and the one place it applies is the 14px semibold "Add" button in Recipients. Left as-is so the light accent matches NexOS exactly; raising it means darkening the brand green, which is a design decision, not a bug fix.


### Constraints

- WCAG 2.2 AA. Body contrast ≥4.5:1. Visible focus via `--ring`.
- Skip link to `#desk`.
- Full keyboard: nav, scan, recipients, theme, sidebar toggle.
- Both light and dark. Default follows system.
- `lang="en"` on `html`.

### Accepted Debt

| Item | Location | Why accepted | Owner / Exit |
|------|----------|--------------|--------------|
| Hugeicons (nav) + Lucide (controls) | shadcn | Two sets: Hugeicons in the sidebar, Lucide in the components | Leave |
| SNMP toner hex | API payload | Printer-reported color, not a theme token | Leave |
| Lighthouse 100 ritual | this app | Internal office tool on Pages; verify in a real browser instead of a 100-point chase | Revisit if it becomes public-facing |
