import { rmSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { ToolRuntime, type WorkspaceTool } from '../../src/main/infrastructure/tools/tool-runtime'

vi.mock('node:fs', () => ({ rmSync: vi.fn() }))
afterEach(() => vi.mocked(rmSync).mockReset())

it('attempts every temporary directory, reports all failures and retries only failed directories', async () => {
  const runtime = new ToolRuntime()
  runtime.setDirectory('/tmp')
  const directories = ['/tmp/dcode-first', '/tmp/dcode-success', '/tmp/dcode-third']
  const register: WorkspaceTool = {
    name: 'register', description: 'Register test resources.', parameters: { type: 'object' },
    execute: async (_args, _signal, { temporaryDirectories }) => {
      for (const directory of directories) temporaryDirectories.add(directory)
      return { content: [], details: undefined }
    }
  }
  await runtime.bind(register).execute({}, new AbortController().signal)
  vi.mocked(rmSync).mockImplementation(path => {
    if (path !== directories[1]) throw Object.assign(new Error('删除失败'), { code: path === directories[0] ? 'EACCES' : 'EPERM' })
  })
  let failure: Error | undefined
  try { runtime.dispose() } catch (error) { failure = error as Error }
  expect(failure?.message).toContain(`${directories[0]}：EACCES`)
  expect(failure?.message).toContain(`${directories[2]}：EPERM`)
  expect(vi.mocked(rmSync).mock.calls.map(call => call[0])).toEqual(directories)
  for (const call of vi.mocked(rmSync).mock.calls) expect(call[1]).toEqual({ recursive: true, force: true })
  vi.mocked(rmSync).mockReset()
  runtime.dispose()
  expect(vi.mocked(rmSync).mock.calls.map(call => call[0])).toEqual([directories[0], directories[2]])
  runtime.dispose()
  expect(rmSync).toHaveBeenCalledTimes(2)
})
