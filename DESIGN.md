# Printer Dashboard Design System

## 0. Research Log

- Embedded refs: Linear operate density, Xerox machine housing → the desk uses the MacOS-style sidebar shell, Xerox tokens, live printer data. A Bionis-derived shell and beUI were both tried and removed; neither is in the product UI.
- Lazyweb: skipped. This is a private office scan desk; there is no public competitor screen set worth cloning.
- Imagen drafts: skipped. Operate surface; the Xerox itself is the visual object, and motion/react supplies the motion primitives.
- Skipped lanes: lazyweb and imagen — no public screen corpus, and no hero photography in an authenticated scan UI.

## 1. Atmosphere & Identity

A fluorescent office next to a Xerox B305. The machine is light gray plastic by day and a dark lid at night, with one red Xerox mark. The sidebar is the housing; the canvas is the desk. No beUI. Signature: cool housing gray, hairline split, Xerox red on Scan. Not cream paper. Overview opens on three summary cards — bridge, recipients, last scan — above the machine panel; they earn their place by reading live state, so keep them factual and never pad the row to fill it.

## 2. Color

Restrained. Cool gray family only. One accent: Xerox red. Used on primary actions, focus, and the mark.

### Palette

| Role | Token | Light | Dark | Usage |
|------|-------|-------|------|-------|
| Surface | --background | oklch(0.965 0.004 250) | oklch(0.17 0.015 255) | Desk canvas |
| Text | --foreground | oklch(0.22 0.02 255) | oklch(0.95 0.01 95) | Body, titles |
| Panel | --card | oklch(0.99 0.002 250) | oklch(0.22 0.016 255) | Raised lists, tables |
| Accent | --primary | oklch(0.5 0.195 25) | oklch(0.64 0.18 25) | Scan, mark, focus |
| Accent text | --primary-foreground | oklch(0.99 0.005 95) | oklch(0.17 0.015 255) | On red |
| Quiet text | --muted-foreground | oklch(0.4 0.02 255) | oklch(0.74 0.015 250) | Labels, hints |
| Quiet fill | --muted | oklch(0.94 0.005 250) | oklch(0.26 0.016 255) | Secondary fills |
| Line | --border | oklch(0.86 0.01 250) | oklch(1 0 0 / 12%) | Hairlines |
| Rail | --sidebar | oklch(0.94 0.005 250) | oklch(0.14 0.016 255) | Housing. Light matches the desk; dark is the lid. |
| Rail text | --sidebar-foreground | oklch(0.22 0.02 255) | oklch(0.96 0.006 95) | Nav labels |
| Danger | --destructive | oklch(0.5 0.195 25) | oklch(0.68 0.17 25) | Failed scan (same red family) |

Toner bar fills may use SNMP-reported colors from the printer. Those are data, not theme tokens.

### Rules

- No warm cream, no teal leftover, no second accent.
- Accent is for action and selection, not decoration.
- Light rail is housing gray, not an inverted dark strip. Dark rail is the lid.

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

### Pages

- Tabular number from SNMP. No ticker.

## 6. Motion & Interaction

| Type | Duration | Usage |
|------|----------|-------|
| Color | 150ms | Hover, focus ring |
| Sidebar | shadcn width transition | Collapse |

### Rules

- No decorative motion. Honor `prefers-reduced-motion` on the spinner.
- No page-load choreography.

## 7. Depth & Surface

Strategy: **borders-only**. Sidebar is the same cool housing as the desk, split by a hairline (dark mode: a darker lid). No glass. No drop shadows.

## 8. Accessibility Constraints & Accepted Debt

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
