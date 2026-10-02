/**
 * The results grid, specifically the play affordance.
 *
 * The card's big click target already means "select for download", so playing
 * has to be its own control or the two fight over the same gesture.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ResultsScreen } from './ResultsScreen'
import { AppContext } from '../state/AppContext'
import type { Snipline } from '../state/useSnipline'
import type { Clip, Ratio, Render } from '../types'

const render = (over: Partial<Render> = {}): Render => ({
  ratio: '9:16',
  url: 'https://api.test/api/media/c1.mp4?ratio=9%3A16&exp=1&sig=x',
  thumbUrl: 'https://api.test/api/media/c1.jpg?ratio=9%3A16&exp=1&sig=x',
  width: 1080,
  height: 1920,
  sizeBytes: 5_000_000,
  status: 'ready',
  ...over,
})

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({
  id,
  idx: 0,
  selected: false,
  t: `Clip ${id}`,
  s: 100,
  e: 140,
  sc: 88,
  sn: 'snippet',
  cap: 'caption',
  line: 'line',
  proxyUrl: null,
  stripUrl: null,
  peaks: null,
  win: null,
  status: 'ready',
  renders: { '9:16': render() },
  ...over,
})

const html = (
  clips: Clip[],
  filter: Ratio = '9:16',
  editorEnabled = false,
  recommendations = false,
) => {
  const stub = {
    state: {
      clips,
      filter,
      sortByScore: false,
      regenerating: {},
      formats: { '9:16': true, '1:1': false, '4:5': false },
      pending: null,
      playingClipId: null,
      source: null,
      /**
       * Recommendations off by default: this file asserts the clip grid, and the
       * panel renders null under the flag without reaching for its data.
       * RecommendationPanel.test.tsx covers it with the flag on. Only the caption
       * button's tests below turn it on, with the panel left collapsed.
       */
      user: {
        id: 'u1',
        email: 'a@b.c',
        name: null,
        pictureUrl: null,
        features: { editor: editorEnabled, recommendations },
      },
      recs: [],
      recsLoading: false,
      recsAsking: false,
      recsError: null,
      recsPicked: null,
      recsOpen: false,
      recsCreating: false,
    },
    toggleClip: () => {},
    loadRecommendations: () => {},
    askRecommendations: () => {},
    toggleRecommendation: () => {},
    toggleRecsOpen: () => {},
    createFromRecommendations: () => {},
    openEditor: () => {},
    redoClip: () => {},
    openPlayer: () => {},
    setFilter: () => {},
    toggleSort: () => {},
    selectAll: () => {},
    download: () => {},
    goNew: () => {},
    regenerateAll: () => {},
  } as unknown as Snipline
  return renderToStaticMarkup(
    <AppContext value={stub}>
      <ResultsScreen />
    </AppContext>,
  )
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1

describe('ResultsScreen play control', () => {
  test('every playable clip gets its own play button', () => {
    const markup = html([clip('a'), clip('b')])
    expect(count(markup, 'aria-label="Play ')).toBe(2)
  })

  test('the play button is separate from the select target', () => {
    // If play were folded into the card button, selecting would start playback.
    const markup = html([clip('a')])
    expect(markup).toContain('aria-label="Select Clip a"')
    expect(markup).toContain('aria-label="Play Clip a"')
  })

  test('a clip with no playable render offers no play button', () => {
    // Nothing to point <video> at, so the control would be a dead end.
    expect(html([clip('a', { renders: {} })])).not.toContain('aria-label="Play ')
    expect(
      html([clip('a', { renders: { '9:16': render({ url: null, status: 'rendering' }) } })]),
    ).not.toContain('aria-label="Play ')
  })

  test('play follows the selected ratio tab', () => {
    const c = clip('a', {
      renders: {
        '9:16': render(),
        '1:1': render({ ratio: '1:1', url: null, status: 'rendering' }),
      },
    })
    // The 1:1 render is not ready, so the 1:1 tab must not offer play.
    expect(html([c], '1:1')).not.toContain('aria-label="Play ')
    expect(html([c], '9:16')).toContain('aria-label="Play ')
  })
})

/**
 * The editor is switched off at the server, and this chip is the only way in.
 *
 * Asserted both ways round: a flag that hides the button but never shows it is
 * indistinguishable from having deleted the feature, and this one is meant to
 * come back.
 */
describe('editor entry point', () => {
  test('the Edit chip is absent while the editor is disabled', () => {
    expect(count(html([clip('a')], '9:16', false), '>Edit<')).toBe(0)
  })

  test('Redo still renders, because it is not part of the editor', () => {
    expect(count(html([clip('a')], '9:16', false), '>Redo<')).toBe(1)
  })

  test('the Edit chip comes back when the editor is re-enabled', () => {
    expect(count(html([clip('a')], '9:16', true), '>Edit<')).toBe(1)
  })
})

/**
 * Caption suggestions spend on the model, so they share the recommendations
 * off switch -- and, like the editor's chip, are asserted both ways round.
 */
describe('caption suggestions entry point', () => {
  test('every clip gets a captions button while the feature is on', () => {
    expect(count(html([clip('a'), clip('b')], '9:16', false, true), '>Captions &amp; tags<')).toBe(2)
  })

  test('no captions button while the feature is off', () => {
    expect(count(html([clip('a')], '9:16', false, false), '>Captions &amp; tags<')).toBe(0)
  })

  test('the overlay stays closed until asked for', () => {
    expect(html([clip('a')], '9:16', false, true)).not.toContain('role="dialog"')
  })
})
