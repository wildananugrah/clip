import { Button } from '../components/Button'
import { Chip } from '../components/Chip'
import { LazyImage } from '../components/LazyImage'
import { ShareClip } from '../components/ShareClip'
import { ClipCaptions } from '../components/ClipCaptions'
import { MomentsToggle, RecommendationPanel } from '../components/RecommendationPanel'
import { FEATURES } from '../config'
import { RATIOS } from '../data/fixtures'
import { cn } from '../lib/cn'
import { clipAspect, clipTitle, exportLabel, selectedCount, sortClips } from '../lib/derive'
import { fmt } from '../lib/format'
import { useApp } from '../state/AppContext'

export function ResultsScreen() {
  const {
    state,
    regenerateAll,
    setFilter,
    toggleSort,
    toggleClip,
    toggleSelectAll,
    download,
    openEditor,
    redoClip,
    openPlayer,
  } = useApp()

  // Defaults to false: /me may not have answered yet, and a button that
  // appears and then disappears is worse than one that never appears.
  const editorEnabled = state.user?.features?.editor ?? false
  const recommendationsEnabled = state.user?.features?.recommendations ?? false

  const src = state.source
  const ordered = sortClips(state.clips, state.sortByScore)
  const selected = selectedCount(state.clips)
  const allSelected = state.clips.length > 0 && state.clips.every((c) => c.selected)
  const ratio = clipAspect(state.filter)
  // Fall back to all three for a project saved before a format was picked.
  const rendered = RATIOS.filter((r) => state.formats[r])
  const tabs = rendered.length ? rendered : RATIOS

  return (
    /*
      Two columns: the clips, and the moments sidebar beside them for the full
      height. The sidebar renders nothing when the feature is off or collapsed,
      so the clip column simply takes the whole width back.
    */
    <div className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/*
          flex-wrap so "Regenerate all" drops to its own line rather than
          squeezing the title into ~57px, where a 17px heading shreds into
          one-word rows.
        */}
        <div className="flex flex-none flex-wrap items-start gap-x-4 gap-y-3 px-5 pt-5 sm:px-[26px]">
          {src?.thumbnailUrl ? (
            <LazyImage
              src={src.thumbnailUrl}
              fallbackClassName="hatch-sand"
              className="w-[104px] flex-none rounded-[7px]"
              style={{ aspectRatio: '16/9' }}
            />
          ) : (
            <div
              className="hatch-sand w-[104px] flex-none rounded-[7px]"
              style={{ aspectRatio: '16/9' }}
            />
          )}
          <div className="min-w-0 flex-1 basis-[180px]">
            <h1 className="m-0 mb-1 truncate text-[17px] leading-[1.3] font-semibold text-ink">
              {src?.title ?? 'Your clips'}
            </h1>
            <p className="m-0 text-[12.5px] text-ink/45">
              {src ? `${src.platform} · ${src.length} source · ` : ''}
              {state.clips.length} clips
            </p>
          </div>
          <Button
            variant="quiet"
            onClick={regenerateAll}
            loading={state.pending === 'regenerateAll'}
            className="h-9 flex-none px-3.5 text-[12.5px]"
          >
            {state.pending === 'regenerateAll' ? 'Requeueing…' : 'Regenerate all'}
          </Button>
        </div>

        <div className="flex flex-none flex-wrap items-center gap-2.5 px-5 pt-[18px] pb-3.5 sm:px-[26px]">
          <div className="flex gap-1 rounded-[9px] bg-sand p-[3px]">
            {tabs.map((label) => {
              const on = state.filter === label
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilter(label)}
                  className={cn(
                    'flex h-[30px] cursor-pointer items-center rounded-[7px] px-[13px] text-[12.5px] font-semibold transition-colors',
                    on ? 'bg-paper text-ink shadow-[0_1px_2px_rgba(0,0,0,.08)]' : 'text-muted',
                  )}
                >
                  {label}
                </button>
              )
            })}
          </div>

          <Button variant="quiet" onClick={toggleSort} className="h-8 px-[13px] text-[12.5px]">
            {state.sortByScore ? 'Sort: hook score' : 'Sort: time in video'}
          </Button>

          <span className="ml-auto text-[12.5px] text-ink/45">{state.clips.length} clips</span>
          <MomentsToggle />
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 pb-[22px] sm:px-[26px]">
          <div className="grid max-w-[1120px] grid-cols-[repeat(auto-fill,minmax(min(152px,100%),1fr))] gap-4">
            {ordered.map((clip) => {
              const busy = !!state.regenerating[clip.id]
              const render = clip.renders[state.filter]
              const thumb = render?.thumbUrl ?? null
              return (
                <article
                  key={clip.id}
                  className={cn(
                    'group/card relative overflow-hidden rounded-[18px] border-2 bg-paper shadow-card transition-colors',
                    clip.selected ? 'border-violet' : 'border-ink/10',
                  )}
                >
                  <button
                    type="button"
                    aria-pressed={clip.selected}
                    aria-label={`${clip.selected ? 'Deselect' : 'Select'} ${clipTitle(clip)}`}
                    onClick={() => toggleClip(clip.id)}
                    className="hatch-clip relative flex w-full cursor-pointer flex-col justify-between p-[9px]"
                    style={{ aspectRatio: ratio }}
                  >
                    {/*
                      A real <img> rather than a CSS background: it can pulse
                      while loading and fall back when it fails (a background
                      that 404s leaves a blank card with no hint why), it loads
                      lazily across 24 clips, and it takes alt text. No fallback
                      class: a failed thumbnail simply shows the hatch that the
                      card already has underneath.
                    */}
                    {thumb && <LazyImage src={thumb} className="absolute inset-0 z-0" />}

                    <span className="relative z-10 flex items-start justify-between gap-1.5">
                      {FEATURES.showHookScore && (
                        <span
                          className={cn(
                            '-rotate-3 rounded-full border-[1.5px] border-on-lime px-2 py-[3px] text-[10.5px] font-bold text-on-lime',
                            clip.sc >= 80 ? 'bg-lime' : 'bg-[#FFF6E2]',
                          )}
                        >
                          {clip.sc} hook
                        </span>
                      )}
                      <span
                        className={cn(
                          'ml-auto flex size-5 flex-none items-center justify-center rounded-[5px] border-[1.5px] text-[11px] leading-none text-on-violet',
                          clip.selected
                            ? 'border-violet bg-violet'
                            : 'border-white/90 bg-black/12',
                        )}
                      >
                        {clip.selected ? '✓' : ''}
                      </span>
                    </span>
                    <span className="relative z-10 flex justify-end">
                      <span className="rounded-[4px] bg-black/60 px-[5px] py-0.5 text-[10.5px] font-medium text-white">
                        {fmt(clip.e - clip.s)}
                      </span>
                    </span>
                  </button>

                  {/*
                    A sibling of the select button, not a child -- buttons cannot
                    nest, and the card's own click already means "select". Hidden
                    until hover or keyboard focus so the grid stays quiet, but
                    never display:none, or it would leave the tab order.
                  */}
                  {render?.url && (
                    <button
                      type="button"
                      onClick={() => openPlayer(clip.id)}
                      aria-label={`Play ${clipTitle(clip)}`}
                      /*
                        Hidden until hover ONLY where hovering is possible.
                        Tailwind nests hover variants inside @media(hover:hover),
                        so hiding this at the md breakpoint alone would hide it
                        for good on a touch tablet -- wide enough for md, with no
                        pointer to reveal it. Phones stay visible for that reason.
                        (Class names are avoided in this comment: the scanner
                        reads comments too, and would emit the rule it describes.)
                      */
                      className="absolute top-1/2 left-1/2 z-20 flex size-12 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-white/25 bg-black/55 text-[15px] leading-none text-white transition-opacity hover:bg-black/75 focus-visible:opacity-100 md:[@media(hover:hover)]:opacity-0 md:group-hover/card:opacity-100"
                    >
                      ▶
                    </button>
                  )}

                  <div className="px-[11px] pt-2.5 pb-[11px]">
                    <h2 className="m-0 mb-[5px] text-[12.5px] leading-[1.35] font-semibold text-ink">
                      {busy ? 'Regenerating…' : clipTitle(clip)}
                    </h2>
                    <p className="m-0 mb-[7px] text-[11px] text-ink/42">
                      {fmt(clip.s)} → {fmt(clip.e)}
                    </p>
                    {FEATURES.showTranscriptSnippet && (
                      <p className="m-0 mb-[9px] line-clamp-2 text-[11px] leading-[1.45] text-muted">
                        {clip.sn}
                      </p>
                    )}
                    {/*
                      Its own full-width row: the action row below already holds
                      up to three buttons on a phone, and a fourth would squeeze
                      every label. Behind the recommendations flag because it
                      spends on the same model, and 404s with it server-side.
                    */}
                    {recommendationsEnabled && (
                      <div className="mb-1.5">
                        <ClipCaptions clip={clip} />
                      </div>
                    )}
                    <div className="flex gap-1.5">
                      {/*
                        The only entry point to the editor, and it is server-gated
                        while that feature is switched off. Redo is `flex-1` too,
                        so it simply fills the row -- no gap to tidy up.
                      */}
                      {editorEnabled && (
                        <Chip onClick={() => openEditor(clip.id)} className="h-10 flex-1 md:h-[30px]">
                          Edit
                        </Chip>
                      )}
                      {/* Absent where the browser cannot share a file; see ShareClip. */}
                      <ShareClip clip={clip} ratio={state.filter} />
                      <Chip
                        onClick={() => redoClip(clip.id)}
                        disabled={busy}
                        className={cn('h-10 flex-1 md:h-[30px]', busy && 'text-ink/30')}
                      >
                        {busy ? '…' : 'Redo'}
                      </Chip>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </div>

        {/*
          A minimum height, not a fixed one. The row already wrapped, but pinning
          its height cropped the wrapped lines, which put the Download button
          below the border and out of reach on a phone. Desktop is unchanged at
          66px, since the contents fit on one line there.
        */}
        <div className="flex min-h-[66px] flex-none flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-ink/8 bg-paper px-5 py-3 sm:px-[26px] sm:py-0">
          <span className="text-[13.5px] font-semibold text-ink">
            {selected === 0
              ? 'No clips selected'
              : `${selected} ${selected === 1 ? 'clip' : 'clips'} selected`}
          </span>
          <span className="text-[12.5px] text-ink/42">{exportLabel(state.filter, state.subs)}</span>
          <div className="ml-auto flex gap-2.5">
            <Button variant="outline" onClick={toggleSelectAll} className="h-10 px-4 text-[13px]">
              {allSelected ? 'Clear selection' : 'Select all'}
            </Button>
            {/*
              A zip of 24 clips outlives the 2.6s toast by a long way, so the
              button carries the wait rather than the toast.
            */}
            <Button
              armed={selected > 0}
              onClick={download}
              loading={state.pending === 'download'}
              className="h-10 px-5 text-[13px]"
            >
              {state.pending === 'download'
                ? selected > 1
                  ? 'Zipping…'
                  : 'Preparing…'
                : selected
                  ? `Download ${selected} ${selected === 1 ? 'clip' : 'clips'}`
                  : 'Download'}
            </Button>
          </div>
        </div>
      </div>
      <RecommendationPanel />
    </div>
  )
}
