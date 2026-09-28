/**
 * Motion tokens for the scan review, named after what each one is for.
 *
 * The values are the ones the desk already uses where it has one: EASE_OUT is
 * StagedPrint's entrance curve, SPRING_PRESS its Print button, SPRING_LAYOUT
 * its Sides indicator. Everything stays under 300 ms, because rotating a
 * page is something people do several times in a row and should never wait
 * on. Under reduced motion, callers drop travel and scale and keep opacity
 * and colour.
 */

/** Entrances: respond at once, then settle quietly. */
export const EASE_OUT = [0.16, 1, 0.3, 1] as const

/** Something already on screen moving to a new position, like a page turning. */
export const EASE_IN_OUT = [0.65, 0, 0.35, 1] as const

/** Pressable surfaces: fast and weighted. */
export const SPRING_PRESS = { type: "spring", stiffness: 500, damping: 30 } as const

/** A shared indicator sliding between options, so it reads as one object. */
export const SPRING_LAYOUT = { type: "spring", stiffness: 420, damping: 34 } as const

/** A quarter turn. Short, since it is repeated. */
export const TURN_S = 0.22

/** A thumbnail appearing once rendered, or fading in place of a turn. */
export const REVEAL_S = 0.18
