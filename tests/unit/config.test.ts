import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../../src/main/infrastructure/config'

let directory: string
let userData: string

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'dcode-config-'))
  userData = join(directory, 'user-data')
  mkdirSync(userData)
  vi.spyOn(process, 'cwd').mockReturnValue(directory)
  vi.stubEnv('BASE_URL', undefined)
  vi.stubEnv('API_KEY', undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(directory, { recursive: true, force: true })
})

it('loads a provider-independent URL and key from the development environment file', () => {
  writeFileSync(join(directory, '.env.local'), 'BASE_URL=https://custom.example.com/v1/\nAPI_KEY=" local-test-key "\n')
  expect(loadConfig(userData, false)).toEqual({ baseUrl: 'https://custom.example.com/v1', apiKey: 'local-test-key' })
})

it('uses the packaged userData environment file instead of the working directory', () => {
  writeFileSync(join(directory, '.env.local'), 'BASE_URL=https://development.example.com\nAPI_KEY=development-key\n')
  writeFileSync(join(userData, '.env.local'), 'BASE_URL=https://packaged.example.com/v1\nAPI_KEY=packaged-key\n')
  expect(loadConfig(userData, true)).toEqual({ baseUrl: 'https://packaged.example.com/v1', apiKey: 'packaged-key' })
})

it('keeps system environment values ahead of the local file', () => {
  writeFileSync(join(directory, '.env.local'), 'BASE_URL=https://file.example.com\nAPI_KEY=file-key\n')
  vi.stubEnv('BASE_URL', ' https://system.example.com/v1/ ')
  vi.stubEnv('API_KEY', ' system-key ')
  expect(loadConfig(userData, false)).toEqual({ baseUrl: 'https://system.example.com/v1', apiKey: 'system-key' })
})

it('does not invent a service address when no environment configuration exists', () => {
  expect(loadConfig(userData, false)).toEqual({ baseUrl: '', apiKey: '' })
})

it('does not fall back to the old provider-specific variables', () => {
  vi.stubEnv('DEEPSEEK_BASE_URL', 'https://old.example.com')
  vi.stubEnv('DEEPSEEK_API_KEY', 'old-key')
  expect(loadConfig(userData, false)).toEqual({ baseUrl: '', apiKey: '' })
})

it('rejects an invalid configured URL instead of silently choosing a default service', () => {
  vi.stubEnv('BASE_URL', 'not-a-url')
  expect(() => loadConfig(userData, false)).toThrow('模型服务地址格式不正确')
})
