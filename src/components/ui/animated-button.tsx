"use client"

import { cva, type VariantProps } from "class-variance-authority"
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react"

import { cn } from "@/lib/utils"

const animatedButtonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        outline:
          "border border-input bg-background hover:bg-muted hover:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-muted hover:text-foreground",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
      },
      size: {
        default: "h-9 px-4",
        sm: "h-8 px-3 text-[0.8rem]",
        lg: "h-11 px-5 text-base",
        icon: "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

type AnimatedButtonProps = HTMLMotionProps<"button"> &
  VariantProps<typeof animatedButtonVariants> & {
    hoverScale?: number
    tapScale?: number
  }

function AnimatedButton({
  className,
  variant,
  size,
  hoverScale = 1.04,
  tapScale = 0.96,
  type = "button",
  ...props
}: AnimatedButtonProps) {
  const reduce = useReducedMotion()
  return (
    <motion.button
      type={type}
      whileHover={reduce ? undefined : { scale: hoverScale }}
      whileTap={reduce ? undefined : { scale: tapScale }}
      transition={{ type: "spring", stiffness: 400, damping: 22 }}
      className={cn(animatedButtonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { AnimatedButton }
export type { AnimatedButtonProps }
