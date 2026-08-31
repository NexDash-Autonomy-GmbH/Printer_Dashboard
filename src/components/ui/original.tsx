import { SidebarLeftIcon } from "@hugeicons/core-free-icons"
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react"
import { motion, AnimatePresence, useReducedMotion } from "motion/react"
import { useState, type ReactNode } from "react"

export interface MacOSSidebarItem {
  label: string
  icon: IconSvgElement
}

export interface MacOSSidebarProps {
  items: MacOSSidebarItem[]
  defaultOpen?: boolean
  initialSelectedIndex?: number
  children?: ReactNode
  className?: string
  onSelect?: (index: number) => void
}

export function MacOSSidebar({
  items,
  defaultOpen = true,
  initialSelectedIndex = 0,
  children,
  className = "",
  onSelect,
}: MacOSSidebarProps) {
  const [hoveredIndex, setHoveredIndex] = useState<number | null>(null)
  const [selectedIndex, setSelectedIndex] = useState<number>(initialSelectedIndex)
  const [isOpen, setIsOpen] = useState<boolean>(defaultOpen)
  const reduce = useReducedMotion()

  return (
    <div
      className={`theme-injected font-sans bg-muted relative flex w-full overflow-hidden rounded-lg p-3 sm:min-w-[480px] ${className}`}
    >
      <motion.div
        animate={{
          width: isOpen ? 240 : 64,
        }}
        transition={reduce ? { duration: 0 } : { type: "spring", bounce: 0.4, duration: 0.8 }}
        className={`flex shrink-0 flex-col items-start rounded-lg p-2 ${
          isOpen ? "bg-background" : "bg-transparent"
        }`}
      >
        <div
          className={`flex w-full items-center ${
            isOpen ? "justify-end" : "justify-center"
          } text-muted-foreground shrink-0 p-2`}
        >
          <motion.div layout className="flex shrink-0 items-center justify-center">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-label={isOpen ? "Collapse sidebar" : "Expand sidebar"}
              className="focus-visible:ring-ring/50 grid place-items-center rounded-md outline-none focus-visible:ring-3"
              onClick={() => setIsOpen(!isOpen)}
            >
              <HugeiconsIcon icon={SidebarLeftIcon} className="size-5 cursor-pointer" aria-hidden />
            </button>
          </motion.div>
        </div>

        <nav
          aria-label="Sections"
          className="relative z-10 mt-4 flex w-full flex-col gap-2 whitespace-nowrap"
          onMouseLeave={() => setHoveredIndex(null)}
        >
          {items.map((item, index) => (
            <button
              key={item.label}
              type="button"
              aria-current={selectedIndex === index ? "page" : undefined}
              aria-label={isOpen ? undefined : item.label}
              title={isOpen ? undefined : item.label}
              className={`focus-visible:ring-ring/50 relative flex w-full cursor-pointer items-center rounded-lg py-3 outline-none focus-visible:ring-3 ${
                isOpen ? "gap-3 px-5" : "justify-center px-0"
              }`}
              onMouseEnter={() => setHoveredIndex(index)}
              onFocus={() => setHoveredIndex(index)}
              onClick={() => {
                setSelectedIndex(index)
                onSelect?.(index)
              }}
            >
              <AnimatePresence>
                {selectedIndex === index && (
                  <motion.span
                    className="bg-accent absolute inset-0 z-0 rounded-lg"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
                  />
                )}
              </AnimatePresence>
              <AnimatePresence>
                {hoveredIndex === index && selectedIndex !== index && (
                  <motion.span
                    layoutId="sidebar-hover-bg"
                    className="bg-accent/50 absolute inset-0 z-0 rounded-lg"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 350, damping: 30 }}
                  />
                )}
              </AnimatePresence>
              <HugeiconsIcon
                icon={item.icon}
                className={`relative z-10 size-5 shrink-0 ${
                  selectedIndex === index ? "text-foreground" : "text-muted-foreground"
                }`}
                aria-hidden
              />
              <AnimatePresence initial={false}>
                {isOpen && (
                  <motion.span
                    initial={reduce ? false : { opacity: 0, filter: "blur(4px)" }}
                    animate={{ opacity: 1, filter: "blur(0px)" }}
                    exit={reduce ? { opacity: 0 } : { opacity: 0, filter: "blur(4px)" }}
                    transition={{ duration: reduce ? 0 : 0.2, ease: "easeOut" }}
                    className={`relative z-10 truncate tracking-tight ${
                      selectedIndex === index
                        ? "text-foreground font-medium"
                        : "text-muted-foreground"
                    }`}
                  >
                    {item.label}
                  </motion.span>
                )}
              </AnimatePresence>
            </button>
          ))}
        </nav>
      </motion.div>

      <div className="z-0 h-full min-h-full w-full flex-1 overflow-y-auto pl-4 lg:pl-8">
        {children}
      </div>
    </div>
  )
}
