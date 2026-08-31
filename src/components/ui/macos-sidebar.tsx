"use client"

import { SidebarLeftIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon } from "@hugeicons/react"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react"

import { cn } from "@/lib/utils"

export function MacOSSidebar({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "relative flex min-h-0 w-full min-w-0 flex-1 overflow-hidden rounded-3xl bg-muted p-3",
        className
      )}
    >
      {children}
    </div>
  )
}

export function MacOSSidebarRail({
  open,
  children,
  className,
}: {
  open: boolean
  children: ReactNode
  className?: string
}) {
  const reduce = useReducedMotion()
  return (
    <motion.div
      initial={false}
      animate={{ width: open ? 232 : 64 }}
      transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0.28, duration: 0.7 }}
      className={cn(
        "flex shrink-0 flex-col items-stretch rounded-2xl p-2",
        open ? "bg-background" : "bg-transparent",
        className
      )}
    >
      {children}
    </motion.div>
  )
}

export function MacOSSidebarToggle({
  open,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { open: boolean }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-label={open ? "Collapse sidebar" : "Expand sidebar"}
      className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      {...props}
    >
      <HugeiconsIcon icon={SidebarLeftIcon} className="size-5" aria-hidden="true" />
    </button>
  )
}

export function MacOSSidebarNav({ children, className }: HTMLAttributes<HTMLElement>) {
  return (
    <nav aria-label="Desk" className={cn("mt-3 flex min-h-0 flex-1 flex-col gap-1", className)}>
      {children}
    </nav>
  )
}

export function MacOSSidebarItem({
  selected,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { selected: boolean }) {
  const reduce = useReducedMotion()
  return (
    <button
      type="button"
      aria-current={selected ? "page" : undefined}
      className={cn(
        "relative w-full rounded-lg px-3 py-2.5 text-left text-sm tracking-tight",
        selected ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        className
      )}
      {...props}
    >
      {selected ? (
        <motion.span
          layoutId="macos-sidebar-active"
          className="absolute inset-0 rounded-lg bg-accent"
          transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 350, damping: 32 }}
        />
      ) : null}
      <span className="relative z-10 truncate">{children}</span>
    </button>
  )
}

export function MacOSSidebarMain({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLElement>) {
  return (
    <main
      className={cn("z-0 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pl-3 sm:pl-5", className)}
      {...props}
    >
      {children}
    </main>
  )
}

export function MacOSSidebarLabels({
  open,
  children,
}: {
  open: boolean
  children: ReactNode
}) {
  const reduce = useReducedMotion()
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          initial={reduce ? false : { opacity: 0, filter: "blur(4px)" }}
          animate={{ opacity: 1, filter: "blur(0px)" }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)" }}
          transition={{ duration: reduce ? 0 : 0.18 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  )
}
