import { createContext } from 'react'

// An inline picker is narrow even on a desktop viewport. Reuse the existing
// compact network chooser so the token search keeps the slab's full width.
export const InlineTokenPickerContext = createContext(false)
