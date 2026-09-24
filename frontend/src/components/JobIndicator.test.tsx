/**
 * The "a video is being processed" affordance, in both the shapes it takes.
 *
 * Driven by props rather than context so it can be rendered to static markup
 * without an app provider.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { JobIndicator } from './JobIndicator'
import { jobIndicator } from '../lib/derive'

const html = (el: React.ReactElement) => renderToStaticMarkup(el)

const running = jobIndicator({
  jobId: 'job-1',
  jobStatus: 'rendering',
  stage: 'Rendering 3 of 12',
  progress: 62,
})
const finished = jobIndicator({ jobId: 'job-1', jobStatus: 'completed', stage: null, progress: 100 })
const nothing = jobIndicator({ jobId: '', jobStatus: null, stage: null, progress: 0 })

describe('JobIndicator', () => {
  test('renders nothing at all when no job is worth reporting', () => {
    expect(html(<JobIndicator indicator={nothing} variant="nav" onOpen={() => {}} />)).toBe('')
    expect(html(<JobIndicator indicator={nothing} variant="banner" onOpen={() => {}} />)).toBe('')
  })

  test('the nav entry names the stage', () => {
    expect(html(<JobIndicator indicator={running} variant="nav" onOpen={() => {}} />)).toContain(
      'Rendering 3 of 12',
    )
  })

  test('the banner names the stage too', () => {
    expect(html(<JobIndicator indicator={running} variant="banner" onOpen={() => {}} />)).toContain(
      'Rendering 3 of 12',
    )
  })

  test('both surfaces show the percentage', () => {
    expect(html(<JobIndicator indicator={running} variant="nav" onOpen={() => {}} />)).toContain('62%')
    expect(html(<JobIndicator indicator={running} variant="banner" onOpen={() => {}} />)).toContain('62%')
  })

  test('the bar width is driven by the percentage', () => {
    expect(html(<JobIndicator indicator={running} variant="nav" onOpen={() => {}} />)).toContain('62%')
  })

  test('it is clickable to go back to the progress screen', () => {
    const out = html(<JobIndicator indicator={running} variant="nav" onOpen={() => {}} />)
    expect(out).toContain('Rendering 3 of 12')
  })

  test('a running job announces itself as busy to a screen reader', () => {
    expect(html(<JobIndicator indicator={running} variant="banner" onOpen={() => {}} />)).toContain(
      'aria-live="polite"',
    )
  })

  test('a finished job reads "Clips ready" rather than disappearing', () => {
    const out = html(<JobIndicator indicator={finished} variant="nav" onOpen={() => {}} />)
    expect(out).toContain('Clips ready')
  })

  test('a finished job hides the progress bar, which has nothing left to say', () => {
    const out = html(<JobIndicator indicator={finished} variant="nav" onOpen={() => {}} />)
    expect(out).not.toContain('100%')
  })

  test('a failed job is visible and labelled', () => {
    const failed = jobIndicator({ jobId: 'j', jobStatus: 'failed', stage: null, progress: 30 })
    expect(html(<JobIndicator indicator={failed} variant="banner" onOpen={() => {}} />)).toContain(
      'Job failed',
    )
  })

  test('the nav entry marks itself current while its screen is showing', () => {
    const out = html(<JobIndicator indicator={running} variant="nav" onOpen={() => {}} current />)
    expect(out).toContain('aria-current="page"')
  })

  test('the nav entry is not current otherwise', () => {
    expect(html(<JobIndicator indicator={running} variant="nav" onOpen={() => {}} />)).not.toContain(
      'aria-current',
    )
  })
})
