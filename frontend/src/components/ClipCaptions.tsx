/**
 * The card's "Captions & tags" button, and the overlay it opens.
 *
 * Opening asks for the saved set first, which is free, and only asks the model
 * to write one when there is none -- so the second open of a clip is instant
 * and costs nothing. Regenerate always asks the model.
 *
 * State is local, like ShareClip's: it belongs to one card, nothing else on the
 * screen reads it, and putting it in useSnipline would mean a slot per clip in
 * a hook that is already the size of the app.
 */
import { useCallback, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Chip } from './Chip'
import { CaptionsDialog } from './CaptionsDialog'
import { api, ApiError } from '../lib/api'
import { clipTitle } from '../lib/derive'
import { useApp } from '../state/AppContext'
import type { Clip, SocialCopy } from '../types'

export function ClipCaptions({ clip }: { clip: Clip }) {
  const { say } = useApp()
  const [open, setOpen] = useState(false)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [social, setSocial] = useState<SocialCopy | null>(null)
  const [error, setError] = useState<string | null>(null)
  /**
   * Counts requests so only the latest one lands. Closing and reopening, or a
   * second Regenerate, must not let a slow earlier answer overwrite a newer one.
   */
  const latest = useRef(0)

  const run = useCallback(
    async (write: boolean) => {
      const ticket = ++latest.current
      setPhase('loading')
      setError(null)
      try {
        let next = write ? null : (await api.clipSocial(clip.id)).social
        if (!next) next = (await api.writeSocial(clip.id)).social
        if (ticket !== latest.current) return
        setSocial(next)
        setPhase('ready')
      } catch (e) {
        if (ticket !== latest.current) return
        setError(e instanceof ApiError ? e.message : 'Could not write captions.')
        setPhase('error')
      }
    },
    [clip.id],
  )

  const onOpen = () => {
    setOpen(true)
    // Already have a set from earlier in this visit: show it, ask nothing.
    if (!social) void run(false)
  }

  const onClose = useCallback(() => setOpen(false), [])

  const onCopy = useCallback(
    (text: string, what: string) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => say(`${what} copied.`))
        .catch(() => say('Could not reach the clipboard.'))
    },
    [say],
  )

  return (
    <>
      <Chip onClick={onOpen} aria-haspopup="dialog" className="h-10 w-full md:h-[30px]">
        Captions &amp; tags
      </Chip>
      {/*
        Portalled to <body>: the card clips its overflow, and a fixed overlay
        inside it would be at the mercy of whatever ancestor next gains a
        transform.
      */}
      {open &&
        createPortal(
          <CaptionsDialog
            title={clipTitle(clip)}
            phase={phase}
            social={social}
            error={error}
            onCopy={onCopy}
            onRegenerate={() => void run(true)}
            onClose={onClose}
          />,
          document.body,
        )}
    </>
  )
}
