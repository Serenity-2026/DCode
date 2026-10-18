import Ajv from 'ajv'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import type { ToolDefinition } from '../domain/llm'

/** 内置工具采用严格 schema；外部工具允许扩展注解并支持常见格式，不转换模型参数。 */
export function toolValidator(tool: ToolDefinition, external = false): (value: unknown) => boolean {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || tool.parameters.type !== 'object') throw new Error('工具定义无效。')
  if (!external) return new Ajv({ strict: true }).compile(tool.parameters)
  const dialect = String(tool.parameters.$schema || '')
  const validator = dialect.includes('2020-12') ? new Ajv2020({ strict: false }) : new Ajv({ strict: false })
  addFormats(validator)
  return validator.compile(tool.parameters)
}
