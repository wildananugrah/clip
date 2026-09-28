/**
 * Moments the model found but nobody clipped, as a conversation.
 *
 * A sidebar beside the clips rather than a section under them: the list and the
 * chat that reshapes it are one exchange, and reading it as a thread -- what you
 * asked, what came back -- is clearer than a list that silently replaces
 * itself. On a phone it covers the clips instead, and starts closed.
 *
 * Every reply stays usable, not just the newest. POST /jobs/:id/clips takes a
 * round id, so a moment from three replies ago is as creatable as one from the
 * last; the old single-list panel just never offered it.
 *
 * One way to create: tick moments, then press the reply's "Create N clips".
 * The moment's text is plain text, not a control. Clicking a title used to
 * create a clip on the spot, which made reading a moment and spending a render
 * on it the same gesture -- easy to trigger while just tapping to read.
 */
import { useEffect, useRef, useState } from 'react'
import { Button } from './Button'
import { Chip } from './Chip'
import { cn } from '../lib/cn'
import { fmt } from '../lib/format'
import { useApp } from '../state/AppContext'
import { MAX_CHAT_CHARS } from '../data/fixtures'
import type { RecommendationRound } from '../types'

/** Moments still on offer across the whole thread: the toggle's badge. */
function available(recs: RecommendationRound[]): number {
  return recs.reduce((n, r) => n + r.candidates.filter((c) => !c.taken).length, 0)
}

/**
 * The show/hide button, for the results header.
 *
 * Absent rather than disabled when there is nothing to show: a project from
 * before the feature has no rounds, and a button that opens an empty panel
 * only to say so is noise.
 */
export function MomentsToggle() {
  const { state, toggleRecsOpen } = useApp()
  if (!state.user?.features?.recommendations || state.recs.length === 0) return null

  const n = available(state.recs)
  return (
    <Chip
      onClick={toggleRecsOpen}
      aria-expanded={state.recsOpen}
      aria-controls="moments-panel"
      className={cn('h-8 gap-1.5 px-3 text-[12.5px]', state.recsOpen && 'bg-ink/[0.055]')}
    >
      Moments
      {n > 0 && (
        <span className="rounded-full bg-ink px-1.5 text-[10.5px] leading-[17px] font-semibold text-on-ink tabular-nums">
          {n}
        </span>
      )}
    </Chip>
  )
}

/** What the system "says" above a round's moments. The server sends only data. */
function replyText(round: RecommendationRound): string {
  const n = round.candidates.length
  if (n === 0) {
    return 'Nothing new that does not overlap what you already have. Try asking for something different.'
  }
  const moments = n === 1 ? '1 moment' : `${n} moments`
  return round.message === null
    ? `I found ${moments} worth clipping beyond the ones you have.`
    : `Here ${n === 1 ? 'is' : 'are'} ${moments} for that.`
}

export function RecommendationPanel() {
  const {
    state,
    loadRecommendations,
    askRecommendations,
    toggleRecommendation,
    toggleRecsOpen,
    createFromRecommendations,
  } = useApp()
  const [draft, setDraft] = useState('')
  const end = useRef<HTMLDivElement | null>(null)

  /**
   * Fetched here because this panel is the only thing that wants it. Keyed on
   * the job, so switching projects refetches. Every hook runs before the early
   * returns below: React needs the same hooks in the same order on every
   * render, and the flag can flip under a live tab.
   */
  const jobId = state.jobId
  useEffect(() => {
    void loadRecommendations()
  }, [jobId, loadRecommendations])

  // Keep the newest exchange in view, as a chat does. Only on a new round or
  // the thinking bubble -- not on every tick, which would yank the thread away
  // from someone scrolled up reading an older reply.
  const rounds = state.recs.length
  useEffect(() => {
    if (state.recsOpen) end.current?.scrollIntoView({ block: 'end' })
  }, [rounds, state.recsAsking, state.recsOpen])

  // Defaults to false: /me may not have answered yet, and a panel that appears
  // and then disappears is worse than one that never appears.
  if (!state.user?.features?.recommendations || !state.recsOpen) return null

  /**
   * Nothing to show and nothing asked. The analyse stage produces the opening
   * round, so this is a project from before the feature -- and a chat box
   * against a transcript that may not exist would be a button that 409s.
   */
  if (state.recs.length === 0 && !state.recsLoading) return null

  const busy = state.recsAsking || state.recsCreating

  const send = () => {
    const text = draft.trim()
    if (!text || busy) return
    setDraft('')
    void askRecommendations(text)
  }

  return (
    <aside
      id="moments-panel"
      aria-label="Moments"
      className="fixed inset-0 z-40 flex flex-col bg-cream md:static md:z-auto md:w-[380px] md:flex-none md:border-l md:border-ink/8"
    >
      <header className="flex flex-none items-center gap-2 border-b border-ink/8 px-4 py-3">
        <h2 className="m-0 flex-1 text-[13.5px] font-semibold text-ink">Moments</h2>
        <button
          type="button"
          onClick={toggleRecsOpen}
          aria-label="Hide moments"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-[7px] text-[15px] text-ink/45 hover:bg-ink/[0.055] hover:text-ink"
        >
          ✕
        </button>
      </header>

      {/* role="log": a screen reader announces each new reply as it lands. */}
      <div role="log" aria-live="polite" className="min-h-0 flex-1 overflow-auto px-4 py-4">
        {state.recsLoading && state.recs.length === 0 && (
          <p className="m-0 text-[12px] text-ink/42">Loading…</p>
        )}

        <ol className="m-0 flex list-none flex-col gap-4 p-0">
          {state.recs.map((round) => {
            const picked = state.recsPicked?.roundId === round.id ? state.recsPicked.indices : []
            return (
              <li key={round.id} className="flex flex-col gap-2">
                {/* The opening round has no message: nobody asked for it. */}
                {round.message !== null && (
                  <p className="m-0 max-w-[85%] self-end rounded-[12px] rounded-br-[4px] bg-ink px-3 py-2 text-[12.5px] leading-[1.45] text-on-ink">
                    {round.message}
                  </p>
                )}

                <div className="max-w-[94%] self-start rounded-[12px] rounded-bl-[4px] border border-ink/8 bg-paper px-3 py-2.5">
                  <p className="m-0 text-[12.5px] leading-[1.45] text-ink">{replyText(round)}</p>

                  {round.candidates.length > 0 && (
                    <ul className="m-0 mt-2.5 flex list-none flex-col gap-1.5 p-0">
                      {round.candidates.map((rec) => {
                        const on = picked.includes(rec.idx)
                        return (
                          <li key={rec.idx}>
                            <div
                              className={cn(
                                'flex items-start gap-2 rounded-[9px] border-[1.5px] px-2 py-1.5',
                                rec.taken ? 'border-ink/8 opacity-55' : 'border-ink/12',
                                on && 'border-ink/35 bg-ink/[0.03]',
                              )}
                            >
                              <input
                                type="checkbox"
                                checked={on}
                                disabled={rec.taken || busy}
                                onChange={() => toggleRecommendation(round.id, rec.idx)}
                                aria-label={`Select ${rec.title}`}
                                className="mt-[3px] h-4 w-4 flex-none accent-ink"
                              />
                              <div className="min-w-0 flex-1">
                                <span className="block text-[12px] leading-[1.35] font-semibold text-ink">
                                  {rec.title}
                                </span>
                                <span className="mt-[2px] block text-[11px] text-ink/42">
                                  {fmt(rec.start)} → {fmt(rec.end)}
                                  {rec.taken && ' · already clipped'}
                                </span>
                                {rec.snippet && (
                                  <span className="mt-1 line-clamp-2 block text-[11px] leading-[1.45] text-muted">
                                    {rec.snippet}
                                  </span>
                                )}
                              </div>
                            </div>
                          </li>
                        )
                      })}
                    </ul>
                  )}

                  {picked.length > 0 && (
                    <Button
                      onClick={() => void createFromRecommendations(round.id, picked)}
                      disabled={busy}
                      className="mt-2.5 h-9 px-3.5 text-[12.5px]"
                    >
                      {state.recsCreating
                        ? 'Creating…'
                        : `Create ${picked.length} ${picked.length === 1 ? 'clip' : 'clips'}`}
                    </Button>
                  )}
                </div>
              </li>
            )
          })}
        </ol>

        {/* Five to fifteen seconds of waiting needs to look like waiting. */}
        {state.recsAsking && (
          <p className="m-0 mt-4 w-fit animate-pulse rounded-[12px] rounded-bl-[4px] border border-ink/8 bg-paper px-3 py-2 text-[12.5px] text-ink/45">
            Thinking…
          </p>
        )}
        <div ref={end} />
      </div>

      <div className="flex-none border-t border-ink/8 px-4 py-3">
        <div className="flex items-end gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter sends, as in any chat; Shift+Enter is a new line.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            rows={2}
            maxLength={MAX_CHAT_CHARS}
            disabled={busy}
            placeholder="Ask for other moments, e.g. only the parts about riba"
            aria-label="Ask for other moments"
            className="min-w-0 flex-1 resize-none rounded-[9px] border-[1.5px] border-ink/14 bg-paper px-2.5 py-2 text-[12.5px] leading-[1.45] text-ink outline-none focus:border-ink/35 disabled:bg-ink/[0.03]"
          />
          <Chip onClick={send} disabled={busy || !draft.trim()} className="h-10 px-3.5">
            {state.recsAsking ? '…' : 'Send'}
          </Chip>
        </div>
        {/*
          Beside the box it came from, not in a toast. A quota or 503 refusal is
          something to read and act on, and a toast is gone in 2.6 seconds.
        */}
        {state.recsError && (
          <p className="m-0 mt-2 text-[11.5px] text-red-600 dark:text-red-400">{state.recsError}</p>
        )}
      </div>
    </aside>
  )
}
