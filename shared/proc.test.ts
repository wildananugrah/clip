import { test, expect } from 'bun:test'
import { run, runStreaming, runBinary } from './proc.ts'

test('run terminates immediately when AbortSignal is aborted', async () => {
  const ac = new AbortController()
  const p = run(['sleep', '10'], { signal: ac.signal })
  setTimeout(() => ac.abort(), 20)
  await expect(p).rejects.toThrow()
})

test('runStreaming terminates immediately when AbortSignal is aborted', async () => {
  const ac = new AbortController()
  const lines: string[] = []
  const p = runStreaming(['sh', '-c', 'for i in $(seq 1 100); do echo $i; sleep 0.1; done'], (l) => lines.push(l), {
    signal: ac.signal,
  })
  setTimeout(() => ac.abort(), 50)
  await expect(p).rejects.toThrow()
  expect(lines.length).toBeLessThan(10)
})

test('runBinary terminates immediately when AbortSignal is aborted', async () => {
  const ac = new AbortController()
  const p = runBinary(['sleep', '10'], { signal: ac.signal })
  setTimeout(() => ac.abort(), 20)
  await expect(p).rejects.toThrow()
})
