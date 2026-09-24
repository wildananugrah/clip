import { useCallback, useEffect, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { LENGTHS, RATIOS, SAMPLE_URLS, TIMELINE_LEAD_IN, TIMELINE_SPAN } from '../data/fixtures'
import { loadPersisted, savePersisted } from '../lib/persist'
import { anyProjectRunning } from '../lib/derive'
import { api, auth, ApiError, type Me } from '../lib/api'
import type { JobSnapshot } from '../lib/api'
import type { Clip, JobStatus, Project, QuotaDTO, Ratio, Screen, Source, SourceKey, RecommendationRound } from '../types'

/**
 * How often the projects list refetches while something is running.
 *
 * Fast enough that a bar visibly moves, slow enough that an open tab is ~20
 * requests a minute rather than a stream.
 */
const PROJECTS_POLL_MS = 3000

/** Smallest trim window, as a percentage of the visible timeline. */
const MIN_TRIM_SPAN = 4

/**
 * Where the handles sit before a clip is known.
 *
 * Only ever seen for the fraction of a second between opening the editor and
 * `trimForClip` replacing it -- the prototype used these numbers for every
 * clip, which put the handles in the wrong place for all real content.
 */
const DEFAULT_TRIM = { trimIn: 20, trimOut: 45 }

/**
 * The action currently in flight, or null.
 *
 * A key rather than a boolean so two async buttons on one screen do not spin
 * together. `openProject` carries its row's id (`openProject:<uuid>`) because the
 * projects list renders one button per project.
 */
export type Pending =
  | null
  | 'analyze'
  | 'startJob'
  | 'cancelJob'
  | `cancelJob:${string}`
  | 'regenerateAll'
  | 'download'
  | 'saveClip'
  | 'signIn'
  | 'signOut'
  | `openProject:${string}`
  | `deleteProject:${string}`

export interface SnipState {
  screen: Screen
  /** Who is signed in. Null until /api/auth/me answers, and after a logout. */
  user: Me | null
  url: string
  /** The resolved source, once a URL has been analysed. */
  source: Source | null
  count: number
  lengthIdx: number
  /**
   * What the user wants the clips to be about, in their own words.
   *
   * Per-video input, NOT a durable preference -- "only the parts about his
   * first startup failing" is meaningless for the next link -- so it is absent
   * from savePersisted and cleared by goNew along with the url it described.
   */
  prompt: string
  formats: Record<Ratio, boolean>
  subs: boolean
  emailMe: boolean
  progress: number
  jobDone: boolean
  /** Server-reported stage text, e.g. "Rendering 3 of 12". */
  stage: string | null
  jobStatus: JobStatus | null
  /**
   * Where the editor window sits when it has been unpinned from its clip, in
   * source seconds. Null means pinned -- the normal case.
   */
  manualStart: number | null
  jobError: string | null
  /**
   * Which action is in flight, as a key the buttons compare against -- not a
   * boolean, because a single flag makes every async button on a screen spin at
   * once (ResultsScreen has two). Per-clip work has its own `regenerating` map.
   */
  pending: Pending
  /**
   * The server's daily allowance, or null until it answers. Replaces a local
   * counter that started at zero every reload and so reported a full allowance
   * after a video had already been generated.
   */
  quota: QuotaDTO | null
  /** Finished jobs, newest first. Loaded from the server. */
  projects: Project[]
  /** Identifies the run in flight, so a regenerate replaces its project. */
  jobId: string
  clips: Clip[]
  filter: Ratio
  sortByScore: boolean
  /** The clip open in the player overlay, if any. Distinct from `editing`. */
  playingClipId: string | null
  editing: string | null
  trimIn: number
  trimOut: number
  /** The crop the editor previews and exports. A wire ratio, e.g. '9:16'. */
  ratio: Ratio
  /**
   * Playback lives in EditorScreen, not here.
   *
   * It is driven by a <video> element's own clock now, and `timeupdate` fires
   * about four times a second -- holding the playhead in this object would
   * re-render the entire app on every tick.
   */
  regenerating: Record<string, boolean>

  /**
   * Suggested moments for the open project, oldest round first, and the
   * conversation that shaped them.
   *
   * Rendered as a conversation, and every round stays usable: a moment from
   * three replies ago can still be turned into a clip. POST /jobs/:id/clips
   * takes a round id, so nothing on the server favours the newest one. Asking
   * again appends a round rather than replacing, so the thread keeps its past.
   *
   * Not persisted. The server owns every round, and a list restored from
   * localStorage would be a snapshot of somebody's clips from a week ago with
   * `taken` computed against a project that has changed since.
   */
  recs: RecommendationRound[]
  /** The first fetch, which happens on landing. Distinct from recsAsking. */
  recsLoading: boolean
  /**
   * A chat turn is in flight. Separate from recsLoading because it takes five
   * to fifteen seconds and the user is watching a box they just typed into:
   * the two states need different words on screen.
   */
  recsAsking: boolean
  recsError: string | null
  /**
   * Ticked moments, all from ONE round: POST /jobs/:id/clips takes a single
   * round id, and each reply has its own "Create N clips" button. Ticking in a
   * different reply starts a fresh selection there.
   */
  recsPicked: { roundId: string; indices: number[] } | null
  recsCreating: boolean
  /** Is the moments sidebar showing? A per-viewer preference; persisted. */
  recsOpen: boolean

  toast: string | null
  pwCurrent: string
  pwNext: string
}

const initialState: SnipState = {
  screen: 'booting',
  user: null,
  url: '',
  source: null,
  count: 12,
  lengthIdx: 1,
  prompt: '',
  formats: { '9:16': true, '1:1': true, '4:5': false },
  subs: true,
  emailMe: true,
  progress: 0,
  jobDone: false,
  stage: null,
  jobStatus: null,
  manualStart: null,
  jobError: null,
  pending: null,
  quota: null,
  projects: [],
  jobId: '',
  clips: [],
  filter: '9:16',
  sortByScore: true,
  playingClipId: null,
  editing: null,
  ...DEFAULT_TRIM,
  // A wire ratio, not a CSS aspect-ratio: the editor's crop buttons index the
  // clip's renders with this now, and only convert for the style attribute.
  ratio: '9:16',
  regenerating: {},
  recs: [],
  recsLoading: false,
  recsAsking: false,
  recsError: null,
  recsPicked: null,
  recsCreating: false,
  // Open beside the clips on a wide screen, closed on a phone -- where the panel
  // covers the clips, and landing on it would hide what the job just made. A
  // saved choice overrides this either way; see Persisted.recsOpen.
  recsOpen: typeof window !== 'undefined' && !!window.matchMedia?.('(min-width: 768px)').matches,
  toast: null,
  pwCurrent: '',
  pwNext: '',
}

/** The format tab results should open on: the first one the job rendered. */
export function firstEnabled(formats: Record<Ratio, boolean>): Ratio {
  return RATIOS.find((r) => formats[r]) ?? RATIOS[0]
}

/** The one place the trim window's bounds are enforced. */
export function clampTrim(s: SnipState, which: 'in' | 'out', pct: number): SnipState {
  const v = Math.max(0, Math.min(100, pct))
  if (which === 'in') {
    return { ...s, trimIn: Math.min(v, s.trimOut - MIN_TRIM_SPAN) }
  }
  return { ...s, trimOut: Math.max(v, s.trimIn + MIN_TRIM_SPAN) }
}

/**
 * The window of source video the editor timeline shows, in seconds.
 *
 * The server's answer wins when it has one: the window clamps at both ends of
 * the source, so a clip near the start or the end does not sit `TIMELINE_LEAD_IN`
 * after its window begins, and the proxy was encoded to the server's numbers.
 * The fallback is for clips made before proxies existed, which have no video to
 * disagree with.
 */
export function windowFor(clip: { s: number; win?: { start: number; span: number } | null }) {
  if (clip.win) return clip.win
  return { start: Math.max(0, clip.s - TIMELINE_LEAD_IN), span: TIMELINE_SPAN }
}

/** Where a source offset sits on the timeline, as a percentage. */
export function pctOf(seconds: number, win: { start: number; span: number }): number {
  if (win.span <= 0) return 0
  return Math.max(0, Math.min(100, ((seconds - win.start) / win.span) * 100))
}

/**
 * What the editor can actually play, and which stretch of source it shows.
 *
 * The screen asks this rather than "is there a proxy", because a clip cut before
 * proxies existed still has its own rendered output sitting in storage -- so
 * there is always a picture, even while the real proxy is still being built.
 */
export interface Preview {
  url: string
  /** First second of SOURCE this file shows. */
  start: number
  /** How many seconds of source it shows. */
  span: number
  /** 'proxy' covers the whole timeline; 'render' covers only the cut. */
  kind: 'proxy' | 'render'
}

export function previewFor(clip: Clip, ratio: Ratio): Preview | null {
  if (clip.proxyUrl) {
    const win = windowFor(clip)
    return { url: clip.proxyUrl, start: win.start, span: win.span, kind: 'proxy' }
  }

  // The fallback is the finished clip: it exists for every ready render, so the
  // preview is never empty. It cannot show anything outside the cut, which is
  // why it is second choice and why the screen says so.
  const url = clip.renders[ratio]?.url
  if (url) {
    return { url, start: clip.s, span: Math.max(0, clip.e - clip.s), kind: 'render' }
  }
  return null
}

/**
 * Where to seek within a preview file for a given source offset.
 *
 * Clamped to what the file holds: with a render-backed preview the handles can
 * move outside the cut, and the picture holds at the nearest frame it has
 * rather than the element rejecting the seek.
 */
export function videoTimeFor(preview: Preview, sourceSeconds: number): number {
  return Math.max(0, Math.min(preview.span, sourceSeconds - preview.start))
}

/** Where the trim handles open: on the clip's real cut, not a fixed guess. */
export function trimForClip(clip: { s: number; e: number; win?: { start: number; span: number } | null }) {
  const win = windowFor(clip)
  return { trimIn: pctOf(clip.s, win), trimOut: pctOf(clip.e, win) }
}

/**
 * Whether refocusing the tab should re-fetch the job.
 *
 * The SSE stream reconnects on error, but a browser that throttles a background
 * tab can leave the connection dead without ever firing one, so a job finishing
 * while the tab is hidden would go unnoticed. Coming back into view is the cue.
 */
export function needsCatchUp(jobId: string, status: JobStatus | null): boolean {
  if (!jobId || !status) return false
  return status !== 'completed' && status !== 'failed' && status !== 'cancelled'
}

/**
 * Merge a server job snapshot into local state.
 *
 * Selection is UI state the server knows nothing about, so it is preserved
 * across refreshes rather than reset every time the job is re-fetched.
 */
export function mergeJob(s: SnipState, job: JobSnapshot): SnipState {
  const wasSelected = new Set(s.clips.filter((c) => c.selected).map((c) => c.id))
  const firstLoad = s.clips.length === 0

  return {
    ...s,
    jobId: job.id,
    source: job.source,
    count: job.clipCount,
    lengthIdx: job.lengthIdx,
    /**
     * REPLACED, not merged.
     *
     * The job is the only authoritative record of which ratios were actually
     * rendered, and the API sends just those (`routes/jobs.ts` builds it as
     * `Object.fromEntries(enabled.map(r => [r, true]))`), so a missing key means
     * "not rendered" rather than "false".
     *
     * Merging these INTO the setup screen's preferences left ratios enabled that
     * the job never produced -- 1:1 is ticked by default. ResultsScreen renders
     * one tab per enabled format, and on such a tab `clip.renders[ratio]` is
     * undefined, so `thumbUrl` was null and EVERY card fell back to the hatch
     * placeholder instead of showing its thumbnail.
     */
    formats: Object.fromEntries(RATIOS.map((r) => [r, !!job.formats[r]])) as Record<Ratio, boolean>,
    subs: job.subs,
    progress: job.progress,
    stage: job.stage,
    jobStatus: job.status,
    jobError: job.error,
    jobDone: job.status === 'completed',
    filter: firstEnabled(job.formats),
    clips: job.clips.map((c) => ({
      ...c,
      // Default the first two ticked, matching the prototype, but only before
      // the user has made a choice.
      selected: firstLoad ? c.idx < 2 : wasSelected.has(c.id),
    })),
  }
}

/**
 * Where a visitor (no session) belongs, read from the address bar.
 *
 * The app had no URLs before the landing page: every screen lived at /. Now the
 * two public screens have paths -- the landing at /, sign-in at /login -- while
 * everything behind sign-in still lives at /, so no signed-in URL changed.
 */
export function publicScreen(pathname: string): Screen {
  return pathname.replace(/\/+$/, '') === '/login' ? 'login' : 'landing'
}

/** The path a screen shows in the address bar. */
export function pathFor(screen: Screen): string {
  return screen === 'login' ? '/login' : '/'
}

/** Reopen where we left off. Clips are re-fetched, never restored from storage. */
export function restored(): Partial<SnipState> {
  const slice = loadPersisted()
  // Neither is a place to come back to: 'booting' would never resolve without a
  // second /me, and 'login' is decided by the session, not by last time.
  if (slice.screen === 'booting' || slice.screen === 'login' || slice.screen === 'landing') {
    delete slice.screen
  }
  // The editor needs one clip in particular; come back to the grid instead.
  if (slice.screen === 'editor') slice.screen = 'results'
  // Without a job to re-fetch, the clip screens would come back empty.
  if ((slice.screen === 'results' || slice.screen === 'processing') && !slice.jobId) {
    slice.screen = 'new'
  }
  return slice
}

export function useSnipline() {
  // Read once. The restored screen is held back until the session is known:
  // applying it immediately would render someone's results before /me answers.
  const [restoredSlice] = useState(restored)
  const [state, setState] = useState<SnipState>(() => ({
    ...initialState,
    ...restoredSlice,
    screen: 'booting',
  }))

  const toastTimer = useRef<number | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)

  const patch = useCallback((next: Partial<SnipState>) => {
    setState((s) => ({ ...s, ...next }))
  }, [])

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current)
      unsubscribe.current?.()
    },
    [],
  )

  // Only durable preferences are stored. Clips and progress come from the
  // server now, so persisting them would just let them go stale.
  useEffect(() => {
    savePersisted({
      jobId: state.jobId,
      count: state.count,
      lengthIdx: state.lengthIdx,
      formats: state.formats,
      subs: state.subs,
      emailMe: state.emailMe,
      screen: state.screen,
      recsOpen: state.recsOpen,
    })
  }, [
    state.jobId,
    state.count,
    state.lengthIdx,
    state.formats,
    state.subs,
    state.emailMe,
    state.screen,
    state.recsOpen,
  ])

  /**
   * Keep the address bar in step with the screen: /login for sign-in, / for
   * everything else.
   *
   * replaceState, not push. This corrects the URL after the fact -- a signed-in
   * user who opens /login lands in the app, and the address should stop saying
   * /login -- which is not a step anyone should be able to go Back to. The one
   * deliberate navigation, landing -> sign-in, pushes in goLogin instead.
   *
   * Not while booting: the screen is undecided, and "correcting" to / would
   * throw away a /login?error=... that the sign-in callback just sent.
   */
  useEffect(() => {
    if (state.screen === 'booting') return
    const want = pathFor(state.screen)
    if (window.location.pathname !== want) window.history.replaceState(null, '', want)
  }, [state.screen])

  // Back and Forward between the two public pages. A signed-in user stays put:
  // everything behind sign-in is one URL, so there is nothing to go back to.
  useEffect(() => {
    const onPop = () =>
      setState((s) => (s.user ? s : { ...s, screen: publicScreen(window.location.pathname) }))
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  /** Landing -> sign-in. Pushed, so Back returns to the landing page. */
  const goLogin = useCallback(() => {
    window.history.pushState(null, '', '/login')
    setState((s) => ({ ...s, screen: 'login' }))
  }, [])

  const goLanding = useCallback(() => {
    window.history.pushState(null, '', '/')
    setState((s) => ({ ...s, screen: 'landing' }))
  }, [])

  const say = useCallback((toast: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setState((s) => ({ ...s, toast }))
    toastTimer.current = window.setTimeout(() => setState((s) => ({ ...s, toast: null })), 2600)
  }, [])

  const fail = useCallback(
    (e: unknown) => {
      // A 401 mid-session means the cookie expired or was revoked. Surfacing
      // "Unauthorized" in a toast would leave the app looking broken on a screen
      // whose every action now fails, so go back to the login screen instead.
      if (e instanceof ApiError && e.status === 401) {
        setState((s) => ({ ...s, pending: null, user: null, screen: 'login' }))
        say('Your session expired. Sign in again.')
        return
      }
      const message = e instanceof ApiError ? e.message : 'Something went wrong.'
      setState((s) => ({ ...s, pending: null }))
      say(message)
    },
    [say],
  )

  /**
   * Resolve the session once, then reveal the app. Until this answers the screen
   * is 'booting' and renders nothing.
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const me = await auth.me()
        if (cancelled) return
        if (!me) {
          patch({ user: null, screen: publicScreen(window.location.pathname) })
          return
        }
        patch({ user: me, screen: restoredSlice.screen ?? 'new' })

        /**
         * Pick the job back up, from the server rather than from storage.
         *
         * This runs whatever screen we land on, because the progress indicator
         * has to work everywhere -- and because the only reliable answer to "am I
         * processing something?" lives on the server. A job started on a phone is
         * absent from this browser's localStorage, and clearing site data loses
         * the id entirely.
         */
        void loadQuota()

        const running = await api.activeJob().catch(() => null)
        if (cancelled) return

        if (running) {
          setState((s) => mergeJob(s, running))
          // Subscribe regardless of screen, so the percentage ticks live in the
          // sidebar and banner rather than sitting frozen until you navigate.
          watchJob(running.id)
        } else if (
          restoredSlice.jobId &&
          (restoredSlice.screen === 'results' || restoredSlice.screen === 'processing')
        ) {
          // Nothing running, but we came back to a clip screen: re-fetch the
          // remembered job so the grid is not empty. (activeJob answers null for
          // a finished job, which is most reloads onto 'results'.)
          await refreshJob(restoredSlice.jobId)
        }
      } catch {
        // The API is unreachable. A visitor still gets the page they asked for:
        // the landing page needs no server, and sign-in will say it cannot
        // reach it when tried. Nothing behind sign-in can work either way.
        if (cancelled) return
        patch({ user: null, screen: publicScreen(window.location.pathname) })
        say('Could not reach the server.')
      }
    })()
    return () => {
      cancelled = true
    }
    // Once, on mount. restoredSlice is state and never changes identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const go = useCallback((screen: Screen) => patch({ screen }), [patch])

  // ---- job lifecycle ------------------------------------------------------

  const refreshJob = useCallback(
    async (jobId: string) => {
      try {
        const job = await api.getJob(jobId)
        setState((s) => mergeJob(s, job))
        return job
      } catch (e) {
        fail(e)
        return null
      }
    },
    [fail],
  )

  /**
   * Refetch the allowance. Called at boot and after anything that spends or
   * frees a slot, rather than adjusting a local number -- the rolling 24h window
   * only exists on the server, and guessing it is what produced "3 of 3 videos
   * left" after one had been generated.
   */
  const loadQuota = useCallback(async () => {
    try {
      patch({ quota: await api.quota() })
    } catch {
      // Secondary information; a failure here should not interrupt anything.
    }
  }, [patch])

  const loadProjects = useCallback(async () => {
    try {
      patch({ projects: await api.projects() })
    } catch {
      // The projects list is secondary; a failure here should not shout.
    }
  }, [patch])

  /**
   * Follow a job to completion over SSE.
   *
   * The final clip list is fetched once on the terminal event rather than
   * streamed, because progress frames are tiny and a full job snapshot is not.
   */
  const watchJob = useCallback(
    (jobId: string) => {
      unsubscribe.current?.()
      unsubscribe.current = api.subscribe(
        jobId,
        (e) => {
          setState((s) => ({
            ...s,
            progress: e.progress,
            stage: e.stage,
            jobStatus: e.status,
            jobError: e.error,
          }))

          if (e.status === 'completed') {
            unsubscribe.current?.()
            unsubscribe.current = null
            void refreshJob(jobId).then(() => {
              setState((s) => ({
                ...s,
                jobDone: true,
                /**
                 * Only follow the job to its clips if the user is actually
                 * watching it finish. Now that the progress indicator is visible
                 * on every screen, navigating out from under someone who is
                 * mid-edit in Settings is worse than a badge they can click --
                 * the indicator flips to "Clips ready" and waits for them.
                 */
                screen: s.screen === 'processing' ? 'results' : s.screen,
              }))
              void loadProjects()
            })
          } else if (e.status === 'failed' || e.status === 'cancelled') {
            unsubscribe.current?.()
            unsubscribe.current = null
            setState((s) => ({
              ...s,
              // Same rule: a job ending elsewhere in the app does not move you.
              // On the processing screen, a cancel returns to the start and a
              // failure stays put, because that is where the error text is.
              screen:
                s.screen === 'processing' && e.status === 'cancelled' ? 'new' : s.screen,
            }))
            if (e.status === 'failed') say(e.error ?? 'That job failed.')
          }
        },
        () => {
          // The stream dropped (proxy timeout, server restart). Fall back to a
          // single fetch so the UI cannot sit on a stale bar forever.
          void refreshJob(jobId)
        },
      )
    },
    [refreshJob, loadProjects, say],
  )

  // Resuming after a reload is handled by the boot sequence above, which asks
  // the server for the running job instead of inferring one from the screen the
  // user happened to leave. The screen-gated effect that used to live here never
  // fired for a reload onto Projects or Settings, which is why an in-flight job
  // became invisible the moment you navigated away from it.

  // Needs a session, so it waits for one rather than 401-ing on first paint.
  useEffect(() => {
    if (!state.user) return
    void loadProjects()
  }, [state.user, loadProjects])

  /**
   * Refetch on arrival at the projects screen.
   *
   * The effect above fires once per session, so starting a job and navigating
   * to Projects showed a list that predated the job entirely -- the row for the
   * thing you just started was simply absent.
   */
  useEffect(() => {
    if (!state.user || state.screen !== 'projects') return
    void loadProjects()
  }, [state.user, state.screen, loadProjects])

  /**
   * Tick the rows while work is in flight.
   *
   * Polling rather than streaming on purpose. The single SSE subscription
   * follows ONE job -- whichever this session last touched -- so patching the
   * list from it would leave a second concurrent job, or anything started on
   * another device, frozen. That is the complaint, not the fix.
   *
   * THE DEPENDENCY IS THE BOOLEAN, NOT THE ARRAY. Depending on state.projects
   * would rebuild the interval on every fetch: the fetch sets the array, which
   * restarts the effect, which fetches. Gating on `running` creates the timer
   * once when work starts and tears it down once when it ends.
   *
   * ponytail: fixed interval, no backoff and no pause on a hidden tab --
   * browsers already throttle background timers, and the visibility handler
   * below catches up on return. Add backoff if this ever shows up in the API
   * logs.
   */
  const pollProjects = state.screen === 'projects' && anyProjectRunning(state.projects)
  useEffect(() => {
    if (!pollProjects) return
    const id = setInterval(() => void loadProjects(), PROJECTS_POLL_MS)
    return () => clearInterval(id)
  }, [pollProjects, loadProjects])

  /**
   * Catch up when the tab comes back into view.
   *
   * Belt and braces next to the stream's own reconnect: a throttled background
   * tab can have its connection torn down without an error event, so nothing
   * would re-subscribe and a job that finished meanwhile would look stuck.
   */
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      if (!needsCatchUp(state.jobId, state.jobStatus)) return
      void refreshJob(state.jobId)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [state.jobId, state.jobStatus, refreshJob])

  const startJob = useCallback(async () => {
    if (!RATIOS.some((r) => state.formats[r])) {
      say('Pick at least one format to render.')
      return
    }
    if (!state.source) {
      say('Paste a link first.')
      return
    }

    patch({ pending: 'startJob' })
    try {
      const { jobId } = await api.createJob({
        videoId: state.source.videoId,
        count: state.count,
        lengthIdx: state.lengthIdx,
        formats: state.formats,
        subs: state.subs,
        prompt: state.prompt,
      })
      setState((s) => ({
        ...s,
        pending: null,
        screen: 'processing',
        jobId,
        progress: 0,
        stage: 'Queued',
        jobStatus: 'pending',
        jobError: null,
        jobDone: false,
        clips: [],
        filter: firstEnabled(s.formats),
      }))
      watchJob(jobId)
      // A slot has just been spent; ask the server rather than decrementing.
      void loadQuota()
    } catch (e) {
      fail(e)
    }
  }, [
    patch,
    say,
    fail,
    watchJob,
    loadQuota,
    state.formats,
    state.source,
    state.count,
    state.lengthIdx,
    state.subs,
  ])

  const cancelJob = useCallback(async (jobId?: string) => {
    const id = jobId ?? state.jobId
    if (!id) return
    const pendingKey = (id === state.jobId ? 'cancelJob' : `cancelJob:${id}`) as import('./useSnipline').Pending
    patch({ pending: pendingKey })
    try {
      const res = await api.cancelJob(id)
      setState((s) => {
        const stillCurrent = id === s.jobId
        if (stillCurrent && res.status === 'cancelled') {
          unsubscribe.current?.()
          unsubscribe.current = null
        }
        return {
          ...s,
          pending: s.pending === pendingKey ? null : s.pending,
          ...(stillCurrent && res.status === 'cancelled'
            ? {
                screen: s.screen === 'processing' ? 'new' : s.screen,
                progress: 0,
                jobDone: false,
                jobStatus: null,
              }
            : {}),
          projects: s.projects.map((p) =>
            p.id === id ? { ...p, status: res.status as any, stage: res.status === 'cancelled' ? 'Cancelled' : p.stage } : p,
          ),
        }
      })
      say(res.status === 'cancelled' ? 'Job cancelled.' : `Job already ${res.status}.`)
    } catch (e) {
      setState((s) => ({
        ...s,
        pending: s.pending === pendingKey ? null : s.pending,
      }))
      say(e instanceof ApiError ? e.message : 'Could not cancel job.')
    }
  }, [patch, say, state.jobId])

  const regenerateAll = useCallback(async () => {
    if (!state.jobId) return
    patch({ pending: 'regenerateAll' })
    try {
      await api.regenerate(state.jobId)
      setState((s) => ({
        ...s,
        pending: null,
        screen: 'processing',
        progress: 0,
        stage: 'Queued',
        jobStatus: 'pending',
        jobError: null,
        jobDone: false,
        clips: [],
      }))
      watchJob(state.jobId)
      say('Regenerating all clips…')
    } catch (e) {
      fail(e)
    }
  }, [patch, say, fail, watchJob, state.jobId])

  // ---- navigation ---------------------------------------------------------

  const goResults = useCallback(() => {
    if (state.clips.length) go('results')
    else say('Make some clips first — paste a link.')
  }, [go, say, state.clips.length])

  /** Leaves the app for Google's consent screen; the callback brings us back. */
  const signIn = useCallback(() => {
    // Nothing clears this: the browser is leaving the page. It exists so the
    // button reads as busy during the wait for the redirect to take effect.
    patch({ pending: 'signIn' })
    auth.signInWithGoogle()
  }, [patch])

  const signOut = useCallback(async () => {
    unsubscribe.current?.()
    unsubscribe.current = null
    patch({ pending: 'signOut' })
    // Drop the server session first, so the cookie cannot outlive the UI state.
    await auth.logout().catch(() => {
      // Already gone, or the API is down: clear the client either way.
    })
    patch({
      // Back to the front page, not the sign-in form: signing out is leaving.
      screen: 'landing',
      user: null,
      clips: [],
      progress: 0,
      jobDone: false,
      jobId: '',
      projects: [],
    })
  }, [patch])

  const goNew = useCallback(
    () => patch({ screen: 'new', url: '', source: null, prompt: '' }),
    [patch],
  )

  /** Reopen a past project, re-fetching its clips. */
  const openProject = useCallback(
    async (id: string) => {
      // Keyed by id: the list shows one button per project and only the
      // clicked row should look busy.
      patch({ pending: `openProject:${id}` })
      const job = await refreshJob(id)
      if (job) setState((s) => ({ ...s, pending: null, screen: 'results' }))
      else patch({ pending: null })
    },
    [patch, refreshJob],
  )

  /** Delete a project for good. The confirm lives in the row that calls this. */
  const deleteProject = useCallback(
    async (id: string) => {
      patch({ pending: `deleteProject:${id}` })
      try {
        await api.deleteProject(id)
        setState((s) => ({
          ...s,
          pending: null,
          projects: s.projects.filter((p) => p.id !== id),
          // Whatever was on screen from this project is now gone with it.
          ...(s.jobId === id
            ? { jobId: '', clips: [], jobDone: false, jobStatus: null, screen: 'projects' as const }
            : {}),
        }))
        say('Project deleted.')
      } catch (e) {
        patch({ pending: null })
        say(e instanceof ApiError ? e.message : 'Could not delete that project.')
      }
    },
    [patch, say],
  )

  // ---- source picking -----------------------------------------------------

  const setUrl = useCallback((url: string) => patch({ url }), [patch])

  const analyze = useCallback(async () => {
    if (!state.url.trim()) {
      say('Paste a link first, or try a sample.')
      return
    }
    patch({ pending: 'analyze' })
    try {
      const source = await api.analyze(state.url.trim())
      patch({ source, pending: null, screen: 'setup' })
    } catch (e) {
      fail(e)
    }
  }, [patch, say, fail, state.url])

  const loadSample = useCallback((source: SourceKey) => patch({ url: SAMPLE_URLS[source] }), [patch])

  // ---- job settings -------------------------------------------------------

  const setCount = useCallback((count: number) => patch({ count }), [patch])
  const setLengthIdx = useCallback((lengthIdx: number) => patch({ lengthIdx }), [patch])
  const setPrompt = useCallback((prompt: string) => patch({ prompt }), [patch])
  const cycleLength = useCallback(
    () => setState((s) => ({ ...s, lengthIdx: (s.lengthIdx + 1) % LENGTHS.length })),
    [],
  )
  const toggleFormat = useCallback(
    (label: Ratio) =>
      setState((s) => ({ ...s, formats: { ...s.formats, [label]: !s.formats[label] } })),
    [],
  )
  const toggleSubs = useCallback(() => setState((s) => ({ ...s, subs: !s.subs })), [])
  const toggleEmail = useCallback(() => setState((s) => ({ ...s, emailMe: !s.emailMe })), [])

  // ---- results ------------------------------------------------------------

  const setFilter = useCallback((filter: Ratio) => patch({ filter }), [patch])
  const toggleSort = useCallback(() => setState((s) => ({ ...s, sortByScore: !s.sortByScore })), [])

  const toggleClip = useCallback(
    (id: string) =>
      setState((s) => ({
        ...s,
        clips: s.clips.map((c) => (c.id === id ? { ...c, selected: !c.selected } : c)),
      })),
    [],
  )

  const toggleSelectAll = useCallback(
    () =>
      setState((s) => {
        const all = s.clips.every((c) => c.selected)
        return { ...s, clips: s.clips.map((c) => ({ ...c, selected: !all })) }
      }),
    [],
  )

  const download = useCallback(async () => {
    const picked = state.clips.filter((c) => c.selected)
    if (!picked.length) {
      say('Pick a clip first.')
      return
    }

    const ready = picked.filter((c) => c.renders[state.filter]?.status === 'ready')
    if (!ready.length) {
      say(`No ${state.filter} clips are ready yet.`)
      return
    }

    say(ready.length === 1 ? 'Downloading…' : `Zipping ${ready.length} clips…`)
    // The toast clears itself after 2.6s, which a multi-clip zip routinely
    // outlives -- the button is what has to stay busy for the real duration.
    patch({ pending: 'download' })
    try {
      await api.download(
        ready.map((c) => c.id),
        state.filter,
        ready[0].renders[state.filter]?.url ?? null,
      )
      patch({ pending: null })
    } catch (e) {
      fail(e)
    }
  }, [patch, say, fail, state.clips, state.filter])

  /**
   * Wait for a re-rendering clip to settle, folding each answer back into state.
   *
   * A re-cut re-downloads the source, so there is no duration worth guessing at
   * -- this polls the job until the clip leaves 'pending'/'rendering'. Resolves
   * null if it never does before the deadline.
   */
  const pollClip = useCallback(
    (clipId: string): Promise<Clip | null> =>
      new Promise((resolve) => {
        const jobId = state.jobId
        const deadline = Date.now() + 10 * 60_000

        const tick = async () => {
          if (Date.now() > deadline) return resolve(null)

          const job = await api.getJob(jobId).catch(() => null)
          const found = job?.clips.find((c) => c.id === clipId)
          if (job && found && found.status !== 'pending' && found.status !== 'rendering') {
            setState((s) => mergeJob(s, job))
            // The merged clip, so the caller sees the fresh signed render URLs.
            return resolve({ ...found, selected: false })
          }
          window.setTimeout(() => void tick(), 3000)
        }

        window.setTimeout(() => void tick(), 3000)
      }),
    [state.jobId],
  )

  /** Re-cut one clip at its current range. */
  const redoClip = useCallback(
    async (id: string) => {
      setState((s) => ({ ...s, regenerating: { ...s.regenerating, [id]: true } }))
      say('Recutting that moment…')

      try {
        await api.redoClip(id)
      } catch (e) {
        setState((s) => ({ ...s, regenerating: { ...s.regenerating, [id]: false } }))
        fail(e)
        return
      }

      const clip = await pollClip(id)
      setState((s) => ({ ...s, regenerating: { ...s.regenerating, [id]: false } }))

      if (!clip) say('That re-cut is taking unusually long; refresh to check.')
      else say(clip.status === 'ready' ? 'Clip recut.' : 'That re-cut failed.')
    },
    [say, fail, pollClip],
  )

  // ---- recommendations ----------------------------------------------------

  /**
   * Load the suggested moments for the open project.
   *
   * Tolerant of failure on purpose: this is a panel below the clips, and a
   * project whose clips rendered fine must not look broken because one extra
   * request 404'd. The flag being off is the ordinary case for that 404.
   */
  const loadRecommendations = useCallback(async () => {
    const jobId = state.jobId
    if (!jobId || !state.user?.features?.recommendations) return

    setState((s) => ({ ...s, recsLoading: true, recsError: null }))
    try {
      const { rounds } = await api.recommendations(jobId)
      setState((s) =>
        s.jobId === jobId ? { ...s, recs: rounds, recsLoading: false } : s,
      )
    } catch {
      // No toast. Nobody asked for this list; failing to fetch it is not an
      // event worth interrupting them over.
      setState((s) => (s.jobId === jobId ? { ...s, recs: [], recsLoading: false } : s))
    }
  }, [state.jobId, state.user])

  /** Ask for a different set. Appends a round; the newest one becomes live. */
  const askRecommendations = useCallback(
    async (message: string) => {
      const jobId = state.jobId
      const text = message.trim()
      if (!jobId || !text) return

      setState((s) => ({ ...s, recsAsking: true, recsError: null }))
      try {
        const round = await api.recommend(jobId, text)
        setState((s) =>
          s.jobId === jobId
            ? { ...s, recs: [...s.recs, round], recsAsking: false }
            : s,
        )
      } catch (e) {
        /**
         * Shown in the panel, not as a toast. The message belongs next to the
         * box it came from -- a quota or 503 refusal is something to read and
         * act on, and a toast is gone in 2.6 seconds.
         */
        const msg = e instanceof ApiError ? e.message : 'Could not reach the server.'
        setState((s) => (s.jobId === jobId ? { ...s, recsAsking: false, recsError: msg } : s))
      }
    },
    [state.jobId],
  )

  const toggleRecommendation = useCallback(
    (roundId: string, idx: number) =>
      setState((s) => {
        // A tick in another reply starts over there: one create call, one round.
        const cur = s.recsPicked?.roundId === roundId ? s.recsPicked.indices : []
        const indices = cur.includes(idx) ? cur.filter((i) => i !== idx) : [...cur, idx]
        return { ...s, recsPicked: indices.length ? { roundId, indices } : null }
      }),
    [],
  )

  const toggleRecsOpen = useCallback(
    () => setState((s) => ({ ...s, recsOpen: !s.recsOpen })),
    [],
  )

  /**
   * Render chosen moments as clips.
   *
   * They arrive `pending` and render on the same queue as Redo, so this waits
   * on them the same way. refreshJob first, so the cards appear immediately
   * rather than at the end of the last render.
   */
  const createFromRecommendations = useCallback(
    async (roundId: string, indices: number[]) => {
      const jobId = state.jobId
      if (!jobId || indices.length === 0) return

      setState((s) => ({ ...s, recsCreating: true, recsError: null }))

      let created: Clip[]
      try {
        created = await api.createClips(jobId, roundId, indices)
      } catch (e) {
        const msg = e instanceof ApiError ? e.message : 'Could not reach the server.'
        setState((s) => ({ ...s, recsCreating: false, recsError: msg }))
        return
      }

      say(created.length === 1 ? 'Creating that clip…' : `Creating ${created.length} clips…`)
      /**
       * Re-read the rounds NOW, not after the renders. `taken` is computed by
       * the server against the clips that exist, and the rows exist from the
       * moment the create returns. Waiting for the render left a moment that
       * was already a clip on offer for minutes -- and clickable a second time.
       */
      await Promise.all([refreshJob(jobId), loadRecommendations()])
      setState((s) => ({ ...s, recsCreating: false, recsPicked: null }))

      const settled = await Promise.all(created.map((c) => pollClip(c.id)))

      const ok = settled.filter((c) => c?.status === 'ready').length
      if (ok === settled.length) say(ok === 1 ? 'Clip ready.' : `${ok} clips ready.`)
      else say('Some of those are still rendering; refresh to check.')
    },
    [state.jobId, say, refreshJob, pollClip, loadRecommendations],
  )

  // ---- player -------------------------------------------------------------

  const openPlayer = useCallback((id: string) => patch({ playingClipId: id }), [patch])
  const closePlayer = useCallback(() => patch({ playingClipId: null }), [patch])

  // ---- editor -------------------------------------------------------------

  /**
   * Open a clip for editing, with the handles on its actual cut.
   *
   * The ratio defaults to one the job really rendered. Offering a crop with no
   * file behind it was harmless while the buttons did nothing, but they pick the
   * preview and the download now.
   */
  const openEditor = useCallback(
    (id: string) =>
      setState((s) => {
        /**
         * The editor is off. Nothing should be calling this -- the Edit chip is
         * not rendered -- but a stale tab or a replayed action must not be able
         * to navigate to a screen whose API routes answer 404.
         */
        if (!s.user?.features?.editor) return s

        const clip = s.clips.find((c) => c.id === id)
        return {
          ...s,
          screen: 'editor',
          editing: id,
          // Opening a clip always starts pinned to it. Carrying a window over
          // from the last clip would put the handles somewhere unrelated.
          manualStart: null,
          ...(clip ? trimForClip(clip) : DEFAULT_TRIM),
          ratio: firstEnabled(s.formats),
        }
      }),
    [],
  )

  /**
   * Unpin the window and put it here, or re-pin it to the clip with null.
   *
   * The trim handles reset to the full window: they were percentages of a
   * different stretch of video a moment ago, and silently reinterpreting them
   * against a new window would move the cut without being asked.
   */
  const setManualStart = useCallback((startSeconds: number | null) => {
    setState((s) => {
      if (startSeconds === null) {
        const clip = s.clips.find((c) => c.id === s.editing)
        return { ...s, manualStart: null, ...(clip ? trimForClip(clip) : DEFAULT_TRIM) }
      }
      return { ...s, manualStart: startSeconds, trimIn: 0, trimOut: 100 }
    })
  }, [])

  /**
   * Ask the server for the full-length assets and wait for them.
   *
   * Same shape as preparePreview: the build is a re-download plus three
   * encodes, so this polls rather than holding a request open. Returns false
   * when nothing is coming, which leaves the caller on the pinned window.
   */
  const prepareSource = useCallback(
    async (jobId: string, stopped: () => boolean): Promise<boolean> => {
      let res
      try {
        res = await api.prepareSource(jobId)
      } catch {
        // 409 (still running) or 404. Nothing is coming.
        return false
      }
      if (res.ready) {
        const job = await api.getJob(jobId).catch(() => null)
        if (job) setState((s) => mergeJob(s, job))
        return true
      }

      const deadline = Date.now() + 15 * 60_000
      while (!stopped() && Date.now() < deadline) {
        await new Promise((r) => window.setTimeout(r, 10_000))
        if (stopped()) return false

        const job = await api.getJob(jobId).catch(() => null)
        if (job?.source.proxyUrl) {
          setState((s) => mergeJob(s, job))
          return true
        }
      }
      // The build outlives this poll on a long source. It keeps going on the
      // server, so reopening manual mode later finds it ready.
      return false
    },
    [],
  )

  const setTrim = useCallback((which: 'in' | 'out', value: number) => {
    setState((s) => clampTrim(s, which, value))
  }, [])


  const beginDrag = useCallback(
    (which: 'in' | 'out') => (e: ReactPointerEvent) => {
      e.preventDefault()
      const el = trackRef.current
      if (!el) return
      const move = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect()
        setTrim(which, ((ev.clientX - r.left) / r.width) * 100)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      move(e.nativeEvent)
    },
    [setTrim],
  )

  /** Snap the trim window to a transcript line. */
  const pickRange = useCallback(
    (a: number, b: number) => patch({ trimIn: Math.max(0, a), trimOut: Math.min(100, b) }),
    [patch],
  )

  /** Back to the cut the analyser chose, not to a fixed pair of percentages. */
  const resetTrim = useCallback(
    () =>
      setState((s) => {
        const clip = s.clips.find((c) => c.id === s.editing)
        return { ...s, ...(clip ? trimForClip(clip) : DEFAULT_TRIM) }
      }),
    [],
  )

  const setRatio = useCallback((ratio: Ratio) => patch({ ratio }), [patch])

  /**
   * Ask the server to build this project's missing editor assets, then wait.
   *
   * Resolves true once THIS clip has a proxy. The wait is long by design -- the
   * backfill downloads the source -- but it is never blocking: the editor is
   * already playing the rendered clip while this runs, and a false answer just
   * means it keeps doing so.
   *
   * `stopped` lets the caller abandon the poll when the screen closes, rather
   * than leaving it fetching the job for a quarter of an hour.
   */
  const preparePreview = useCallback(
    async (jobId: string, clipId: string, stopped: () => boolean): Promise<boolean> => {
      try {
        await api.prepareAssets(jobId)
      } catch {
        // 409 (job not finished) or 404. Nothing is coming; the caller keeps
        // its fallback. Not worth a toast -- the preview still works.
        return false
      }

      const deadline = Date.now() + 15 * 60_000
      while (!stopped() && Date.now() < deadline) {
        // Every 10s, not every second: each poll is a full job snapshot with
        // freshly signed URLs for every render, and the work being waited on is
        // a download measured in minutes.
        await new Promise((r) => window.setTimeout(r, 10_000))
        if (stopped()) return false

        const job = await api.getJob(jobId).catch(() => null)
        const found = job?.clips.find((c) => c.id === clipId)
        if (job && found?.proxyUrl) {
          setState((s) => mergeJob(s, job))
          return true
        }
      }
      return false
    },
    [],
  )

  const backToResults = useCallback(() => patch({ screen: 'results' }), [patch])

  /**
   * Save the edited range as a NEW clip, then download it.
   *
   * The clip being edited is left exactly as it was: trimming away from a cut
   * should not destroy the cut. The server answers the copy it created, already
   * queued, so everything after this follows the NEW id -- polling the edited
   * one would watch a clip that is never going to change.
   *
   * The wait is real, because rendering the copy re-downloads the source with
   * yt-dlp, so this stays on the editor screen with the button busy rather than
   * pretending to be instant.
   */
  const saveTrim = useCallback(
    async (clipId: string, startSeconds: number, endSeconds: number, ratio: Ratio) => {
      patch({ pending: 'saveClip' })

      let copyId: string
      try {
        const copy = await api.copyClip(clipId, startSeconds, endSeconds)
        copyId = copy.id
      } catch (e) {
        fail(e)
        return
      }

      say('Saved as a new clip. Rendering it…')
      const clip = await pollClip(copyId)
      patch({ pending: null })

      if (!clip) {
        say('That render is taking unusually long; check back from the grid.')
        return
      }
      if (clip.status !== 'ready') {
        say('Rendering the new clip failed.')
        return
      }

      const url = clip.renders[ratio]?.url
      if (!url) {
        say(`New clip saved, but ${ratio} is not ready.`)
        return
      }
      await api.download([copyId], ratio, url)
    },
    [patch, say, fail, pollClip],
  )

  // ---- settings -----------------------------------------------------------

  const setPwCurrent = useCallback((pwCurrent: string) => patch({ pwCurrent }), [patch])
  const setPwNext = useCallback((pwNext: string) => patch({ pwNext }), [patch])

  const updatePassword = useCallback(() => {
    if (!state.pwCurrent) {
      say('Enter your current password.')
      return
    }
    if (state.pwNext.length < 8) {
      say('New password needs 8 characters.')
      return
    }
    patch({ pwCurrent: '', pwNext: '' })
    say('Accounts are not implemented yet.')
  }, [patch, say, state.pwCurrent, state.pwNext])

  return {
    state,
    trackRef,
    say,
    go,
    refreshJob,
    signIn,
    signOut,
    goLogin,
    goLanding,
    goNew,
    goResults,
    openProject,
    deleteProject,
    setUrl,
    analyze,
    loadSample,
    setCount,
    setLengthIdx,
    setPrompt,
    loadRecommendations,
    askRecommendations,
    toggleRecommendation,
    toggleRecsOpen,
    createFromRecommendations,
    cycleLength,
    toggleFormat,
    toggleSubs,
    toggleEmail,
    startJob,
    cancelJob,
    regenerateAll,
    setFilter,
    toggleSort,
    toggleClip,
    toggleSelectAll,
    download,
    redoClip,
    openPlayer,
    closePlayer,
    openEditor,
    setTrim,
    beginDrag,
    pickRange,
    resetTrim,
    setRatio,
    preparePreview,
    prepareSource,
    setManualStart,
    backToResults,
    saveTrim,
    setPwCurrent,
    setPwNext,
    updatePassword,
  }
}

export type Snipline = ReturnType<typeof useSnipline>
