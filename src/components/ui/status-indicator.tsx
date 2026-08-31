import { cn } from "@/lib/utils"

interface StatusIndicatorProps {
  state: "active" | "down" | "fixing" | "idle"
  label?: string
  className?: string
  size?: "sm" | "md" | "lg"
  labelClassName?: string
}

const getStateColors = (state: StatusIndicatorProps["state"]) => {
  switch (state) {
    case "active":
      return { dot: "bg-emerald-500", ping: "bg-emerald-400" }
    case "down":
      return { dot: "bg-red-500", ping: "bg-red-400" }
    case "fixing":
      return { dot: "bg-amber-500", ping: "bg-amber-400" }
    case "idle":
    default:
      return { dot: "bg-muted-foreground/50", ping: "bg-muted-foreground/30" }
  }
}

const getSizeClasses = (size: StatusIndicatorProps["size"]) => {
  switch (size) {
    case "sm":
      return { dot: "size-2", ping: "size-2" }
    case "lg":
      return { dot: "size-4", ping: "size-4" }
    case "md":
    default:
      return { dot: "size-2.5", ping: "size-2.5" }
  }
}

export function StatusIndicator({
  state = "idle",
  label,
  className,
  size = "md",
  labelClassName,
}: StatusIndicatorProps) {
  const shouldAnimate =
    state === "active" || state === "fixing" || state === "down"
  const colors = getStateColors(state)
  const sizeClasses = getSizeClasses(size)

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className="relative flex items-center">
        {shouldAnimate ? (
          <span
            className={cn(
              "absolute inline-flex rounded-full opacity-75 animate-ping",
              sizeClasses.ping,
              colors.ping
            )}
          />
        ) : null}
        <span
          className={cn(
            "relative inline-flex rounded-full",
            sizeClasses.dot,
            colors.dot
          )}
        />
      </div>
      {label ? (
        <p className={cn("text-sm text-muted-foreground", labelClassName)}>
          {label}
        </p>
      ) : null}
    </div>
  )
}
