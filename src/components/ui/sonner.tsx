import { useTheme } from "@/components/theme-provider"
import { Toaster as Sonner, type ToasterProps } from "sonner"
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon, OctagonXIcon, Loader2Icon } from "lucide-react"

/**
 * Toasts carry a close button and dismiss themselves.
 *
 * Sonner's default duration is four seconds, but it pauses that timer while
 * the pointer is over the toast and while the window is in the background --
 * so a toast under the cursor, or raised while the tab was not in front, sits
 * there until something moves. With no close button there was nothing to do
 * about it but move the mouse away and wait.
 *
 * A caller that wants longer can pass its own duration; this version of
 * sonner has no per-level setting.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme as ToasterProps["theme"]}
      className="toaster group"
      closeButton
      duration={4000}
      icons={{
        success: (
          <CircleCheckIcon className="size-4" />
        ),
        info: (
          <InfoIcon className="size-4" />
        ),
        warning: (
          <TriangleAlertIcon className="size-4" />
        ),
        error: (
          <OctagonXIcon className="size-4" />
        ),
        loading: (
          <Loader2Icon className="size-4 animate-spin" />
        ),
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "cn-toast",
          // Sonner hides the close button until hover by default, which is no
          // use on a touch screen and easy to miss with a pointer too.
          closeButton:
            "!opacity-100 !bg-popover !text-muted-foreground hover:!text-foreground !border-border",
        },
      }}
      {...props}
    />
  )
}

export { Toaster }
