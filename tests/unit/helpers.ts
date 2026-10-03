import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auth } from '../../src/main/auth'
import { Models } from '../../src/main/models'
import { Store } from '../../src/main/store'
import type { SecretCodec } from '../../src/main/secrets'
import type { ModelConfig } from '../../src/main/config'

/** 仅用于单元测试的替身；Electron E2E 会验证真实 safeStorage，不在生产降级加密。 */
export const secrets: SecretCodec = {
  encrypt: async value => Buffer.from(value).toString('base64'),
  decrypt: async value => Buffer.from(value, 'base64').toString('utf8')
}
export const config: ModelConfig = { baseUrl: 'https://example.com', apiKey: 'private-key', model: 'test' }
const directories: string[] = []

/** 创建隔离账号并走真实 Auth 注册流程，供存储、聊天和配置测试共用。 */
export async function create(initial: ModelConfig = config) {
  const directory = mkdtempSync(join(tmpdir(), 'dcode-unit-'))
  directories.push(directory)
  const path = join(directory, 'state.json')
  const store = new Store(path)
  const models = new Models(store, secrets, initial)
  const auth = new Auth(store, secrets, models)
  await auth.register({ username: 'developer', password: 'test-password' })
  return { store, auth, models, path, directory }
}

/** 测试结束只删除该测试创建的临时目录。 */
export function cleanup(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}
