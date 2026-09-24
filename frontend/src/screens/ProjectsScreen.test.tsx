/**
 * The projects list, which until now could only open a project.
 *
 * Deleting is destructive and irreversible from the UI, so the row asks before
 * it acts rather than firing on the first click.
 */
import { test, expect, describe } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProjectsScreen } from './ProjectsScreen'
import { AppContext } from '../state/AppContext'
import type { Snipline } from '../state/useSnipline'
import type { Project } from '../types'

const project = (id: string, title: string): Project => ({
  id,
  title,
  source: {
    videoId: `v-${id}`,
    platform: 'YouTube',
    title,
    length: '45:12',
    durationSeconds: 2712,
    meta: 'chan · 1080p',
    eta: '~3 min',
    thumbnailUrl: null,
  },
  clipCount: 3,
  createdAt: Date.now(),
  // Finished unless a test says otherwise: these cases are about opening and
  // deleting, which a running project does not offer.
  status: 'completed',
  stage: null,
  progress: 100,
})

const html = (projects: Project[], pending: string | null = null) => {
  const stub = {
    state: { projects, pending },
    goNew: () => {},
    openProject: () => {},
    deleteProject: () => {},
  } as unknown as Snipline
  return renderToStaticMarkup(
    <AppContext value={stub}>
      <ProjectsScreen />
    </AppContext>,
  )
}

const count = (markup: string, needle: string) => markup.split(needle).length - 1

describe('ProjectsScreen', () => {
  test('offers a delete control on every row', () => {
    const markup = html([project('a', 'First'), project('b', 'Second')])
    // `>Delete<` and not `Delete`, so the aria-labels are not counted twice.
    expect(count(markup, '>Delete<')).toBe(2)
  })

  test('the delete control names the project for screen readers', () => {
    const markup = html([project('a', 'First')])
    expect(markup).toContain('Delete First')
  })

  test('deleting does not fire on the first click — it asks', () => {
    // The confirm step is what stops a mis-click destroying a finished render,
    // so the initial markup must not be the confirming variant.
    const markup = html([project('a', 'First')])
    expect(markup).not.toContain('Confirm')
  })

  test('a row being deleted says so', () => {
    const markup = html([project('a', 'First')], 'deleteProject:a')
    expect(markup).toContain('Deleting…')
  })

  test('still lists and opens projects', () => {
    const markup = html([project('a', 'First')])
    expect(markup).toContain('First')
    expect(markup).toContain('Open')
  })

  test('shows Cancel button when project is running', () => {
    const running = {
      ...project('a', 'First'),
      status: 'downloading' as const,
      stage: 'Downloading source',
      progress: 15,
    }
    const markup = html([running])
    expect(markup).toContain('Cancel')
    expect(markup).not.toContain('Open')
  })
})
