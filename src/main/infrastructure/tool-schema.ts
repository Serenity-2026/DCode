import Ajv from 'ajv'
import type { ToolDefinition } from '../domain/llm'

/** 启动时编译可信工具的 object schema；严格校验，不转换或修改模型参数。 */
export function toolValidator(tool: ToolDefinition): (value: unknown) => boolean {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || tool.parameters.type !== 'object') throw new Error('工具定义无效。')
  return new Ajv({ strict: true }).compile(tool.parameters)
}
