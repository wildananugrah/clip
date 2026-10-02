/**
 * The caption suggestions overlay.
 *
 * Props-driven like ClipPlayer, so each state renders to static markup without
 * an app provider or a network.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { CaptionsDialog, type CaptionsDialogProps } from './CaptionsDialog'

const props = (over: Partial<CaptionsDialogProps> = {}): CaptionsDialogProps => ({
  title: 'The pricing mistake',
  phase: 'ready',
  social: {
    captions: ['Stop billing hours.', 'Why does hourly pricing fail?'],
    hashtags: ['pricing', 'startup'],
    createdAt: '2026-10-01T00:00:00.000Z',
  },
  error: null,
  credit: 'Source: Close The Door (YouTube)\n"Episode 12"\nhttps://youtu.be/abc123?t=30s',
  onCopy: () => {},
  onRegenerate: () => {},
  onClose: () => {},
  ...over,
})

const html = (over: Partial<CaptionsDialogProps> = {}) =>
  renderToStaticMarkup(<CaptionsDialog {...props(over)} />)

describe('CaptionsDialog', () => {
  test('is a labelled modal naming the clip', () => {
    const markup = html()
    expect(markup).toContain('role="dialog"')
    expect(markup).toContain('aria-modal="true"')
    expect(markup).toContain('The pricing mistake')
  })

  test('lists every caption with its own copy button', () => {
    const markup = html()
    expect(markup).toContain('Stop billing hours.')
    expect(markup).toContain('Why does hourly pricing fail?')
    expect(markup.match(/aria-label="Copy caption \d"/g)).toHaveLength(2)
  })

  test('shows the hashtags with their # and offers to copy them', () => {
    const markup = html()
    expect(markup).toContain('#pricing')
    expect(markup).toContain('#startup')
    expect(markup).toContain('Copy hashtags')
    expect(markup).toContain('Copy full post')
  })

  test('hides the hashtag row when there are none', () => {
    const markup = html({
      social: { captions: ['Only a caption.'], hashtags: [], createdAt: 'x' },
    })
    expect(markup).not.toContain('Copy hashtags')
  })

  test('shows the source credit with its own copy button', () => {
    const markup = html()
    expect(markup).toContain('Source: Close The Door (YouTube)')
    expect(markup).toContain('https://youtu.be/abc123?t=30s')
    expect(markup).toContain('aria-label="Copy source"')
  })

  // The credit is read off the video, not written by the model, so a failed
  // or slow caption request must not take it away.
  test('keeps the source credit while captions are loading or failed', () => {
    expect(html({ phase: 'loading', social: null })).toContain('Source: Close The Door')
    expect(html({ phase: 'error', social: null, error: 'x' })).toContain('Source: Close The Door')
  })

  test('has no source section when the source is unknown', () => {
    const markup = html({ credit: null })
    expect(markup).not.toContain('Copy source')
  })

  test('offers the full post with no hashtags when there is a credit', () => {
    const markup = html({
      social: { captions: ['Only a caption.'], hashtags: [], createdAt: 'x' },
    })
    expect(markup).toContain('Copy full post')
  })

  test('has nothing to assemble with neither hashtags nor credit', () => {
    const markup = html({
      social: { captions: ['Only a caption.'], hashtags: [], createdAt: 'x' },
      credit: null,
    })
    expect(markup).not.toContain('Copy full post')
  })

  test('says it is writing while the first set is on its way', () => {
    const markup = html({ phase: 'loading', social: null })
    expect(markup).toContain('Writing captions')
    expect(markup).toContain('aria-busy="true"')
  })

  // Regenerating keeps the old set on screen, so it can still be copied.
  test('keeps the current set visible while regenerating', () => {
    const markup = html({ phase: 'loading' })
    expect(markup).toContain('Stop billing hours.')
    expect(markup).toContain('Writing…')
  })

  test('shows the error and a way to try again', () => {
    const markup = html({ phase: 'error', social: null, error: 'Could not write captions.' })
    expect(markup).toContain('role="alert"')
    expect(markup).toContain('Could not write captions.')
    expect(markup).toContain('Try again')
  })
})
