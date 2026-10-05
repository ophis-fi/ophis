import { lazy } from 'react'

export const MotionDiv = lazy(() => import('framer-motion').then((module) => ({ default: module.motion.div })))
export const MotionButton = lazy(() => import('framer-motion').then((module) => ({ default: module.motion.button })))
export const AnimatePresence = lazy(() =>
  import('framer-motion').then((module) => ({ default: module.AnimatePresence })),
)
