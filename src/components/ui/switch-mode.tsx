"use client"

import { type FC } from "react"
import { motion } from "motion/react"
import { IoMoon, IoMoonOutline, IoSunny, IoSunnyOutline } from "react-icons/io5"

import { useTheme } from "@/components/theme-provider"

interface SwitchModeProps {
  width?: number
  height?: number
  darkColor?: string
  lightColor?: string
  knobDarkColor?: string
  knobLightColor?: string
  borderDarkColor?: string
  borderLightColor?: string
}

export const SwitchMode: FC<SwitchModeProps> = ({
  width = 144,
  height = 72,
  darkColor = "#0B0B0B",
  lightColor = "#FFFFFF",
  knobDarkColor = "#2A2A2E",
  knobLightColor = "#F3F2F7",
  borderDarkColor = "#4C4C50",
  borderLightColor = "#D8D6E0",
}) => {
  const { resolvedTheme, setTheme } = useTheme()

  // There was a mount gate here that rendered an empty placeholder on the
  // first pass. That pattern exists to avoid a server/client hydration
  // mismatch, and this is a client-only Vite app with no server render, so it
  // bought nothing and cost a visible blank slot plus a set-state-in-effect.
  // The provider resolves the theme in its own initialiser, synchronously, so
  // the first render already knows which icon to show.

  const isDark = resolvedTheme === "dark"
  const iconSize = height * 0.45

  return (
    <motion.button
      type="button"
      aria-label={isDark ? "Switch to light mode" : "Switch to dark mode"}
      onClick={() => setTheme(isDark ? "light" : "dark")}
      className="relative flex items-center rounded-full border-2"
      style={{
        width,
        height,
        borderColor: isDark ? borderDarkColor : borderLightColor,
      }}
    >
      <motion.div
        className="absolute inset-0 rounded-full"
        animate={{ backgroundColor: isDark ? darkColor : lightColor }}
        transition={{ duration: 0.4 }}
      />

      <motion.div
        layout
        layoutId="switch-knob"
        transition={{ type: "spring", stiffness: 260, damping: 20 }}
        className="absolute rounded-full border-2"
        style={{
          width: height,
          height,
          right: isDark ? -2 : undefined,
          left: isDark ? undefined : -2,
          backgroundColor: isDark ? knobDarkColor : knobLightColor,
          borderColor: isDark ? borderDarkColor : borderLightColor,
        }}
      />

      <motion.div
        className="relative flex items-center justify-center"
        style={{ width: height, height }}
        animate={{ rotate: isDark ? 45 : 0 }}
        transition={{ stiffness: 20 }}
      >
        {isDark ? (
          <IoSunnyOutline
            color="#8A8A8F"
            fill="#8A8A8F"
            stroke="#8A8A8F"
            style={{ width: iconSize, height: iconSize }}
          />
        ) : (
          <IoSunny
            color="#686771"
            fill="#686771"
            style={{ width: iconSize, height: iconSize }}
          />
        )}
      </motion.div>

      <motion.div
        className="relative flex items-center justify-center"
        style={{ width: height, height }}
        animate={{ rotate: isDark ? 0 : 15 }}
        transition={{ stiffness: 20, damping: 14 }}
      >
        {isDark ? (
          <IoMoon
            color="#F4F4FB"
            fill="#F4F4FB"
            style={{ width: iconSize, height: iconSize }}
          />
        ) : (
          <IoMoonOutline
            color="#ABABB4"
            fill="#ABABB4"
            stroke="#ABABB4"
            style={{ width: iconSize, height: iconSize }}
          />
        )}
      </motion.div>
    </motion.button>
  )
}
