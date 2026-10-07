import { StateRepository } from '../../src/main/repositories/state-repository'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Auth } from '../../src/main/services/auth-service'
import { Models } from '../../src/main/services/model-service'
import { StateService } from '../../src/main/services/state-service'
import type { SecretCodec } from '../../src/main/domain/ports'
import type { ModelConfig } from '../../src/main/domain/model-config'
import type { AgentTool } from '../../src/main/domain/llm'
import { AgentLoop } from '../../src/main/services/agent-loop'
import { streamModel } from '../../src/main/infrastructure/model-client'

/** 注入测试工具但使用正式协议适配器，生产不注册这些测试能力。 */
export function createAgent(tools: AgentTool[] = []): AgentLoop {
  return new AgentLoop((config, messages, controller, onDelta, tools) => streamModel(config, messages, controller, onDelta, { tools }), tools)
}

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
  const store = new StateService(new StateRepository(path))
  const models = new Models(store, secrets, initial)
  const auth = new Auth(store, secrets, models)
  await auth.register({ username: 'developer', password: 'test-password' })
  // 单元测试预置已获取的目录；模型目录网络行为由 models.test 验证，E2E 使用真实 /models 请求。
  const user = store.requireUser()
  if (user.providers[0]) { user.providers[0].availableModels = [initial.model]; user.selectedModel = initial.model; store.save() }
  return { store, auth, models, path, directory }
}

/** 测试结束只删除该测试创建的临时目录。 */
export function cleanup(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
}
