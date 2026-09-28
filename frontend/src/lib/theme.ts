import { useSyncExternalStore } from 'react'

/**
 * Light, dark, or whatever the device says.
 *
 * Kept out of the persisted app slice (persist.ts) on purpose: the theme has to
 * be on <html> before React renders, or a dark-mode user sees a cream flash on
 * every load. index.html reads this same key from an inline script for exactly
 * that; this module takes over once the bundle is running.
 */
export type ThemePref = 'system' | 'light' | 'dark'
export type Theme = 'light' | 'dark'

/** Shared with the inline script in index.html. Change both or neither. */
export const THEME_KEY = 'snipline.theme'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** Pure, so the rule is testable without a browser. */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** Anything unrecognised -- including blocked storage -- means "follow the device". */
export function parsePref(raw: string | null | undefined): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system'
}

function readPref(): ThemePref {
  try {
    return parsePref(localStorage.getItem(THEME_KEY))
  } catch {
    return 'system'
  }
}

const browser = typeof window !== 'undefined'
const media = browser && typeof window.matchMedia === 'function' ? window.matchMedia(DARK_QUERY) : null

let pref: ThemePref = browser ? readPref() : 'system'
const listeners = new Set<() => void>()

function current(): Theme {
  return resolveTheme(pref, media?.matches ?? false)
}

function apply() {
  if (!browser) return
  document.documentElement.dataset.theme = current()
  listeners.forEach((l) => l())
}

export function setThemePref(next: ThemePref) {
  pref = next
  try {
    // 'system' is the absence of a choice, so it is stored as one.
    if (next === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, next)
  } catch {
    // Blocked storage: the choice still holds for this page load.
  }
  apply()
}

if (browser) {
  // Following the device means following it live, not just at load.
  media?.addEventListener('change', () => {
    if (pref === 'system') apply()
  })
  // A choice made in another tab applies here too.
  window.addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY) return
    pref = parsePref(e.newValue)
    apply()
  })
  apply()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The stored preference, for the Settings control. */
export function useThemePref(): ThemePref {
  return useSyncExternalStore(subscribe, () => pref, () => 'system')
}

/** The theme actually showing, for the quick toggle's icon. */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, current, () => 'light')
}
