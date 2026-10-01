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
    expect(markup).toContain('Copy with hashtags')
  })

  test('hides the hashtag row when there are none', () => {
    const markup = html({
      social: { captions: ['Only a caption.'], hashtags: [], createdAt: 'x' },
    })
    expect(markup).not.toContain('Copy hashtags')
    expect(markup).not.toContain('Copy with hashtags')
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
