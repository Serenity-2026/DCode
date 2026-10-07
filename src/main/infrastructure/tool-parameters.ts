import Ajv from 'ajv'
import type { ToolDefinition } from '../domain/agent'

/** 编译可信主进程定义的参数 schema；严格检查定义，不转换、补值或删除模型输入。 */
export function compileToolParameters(definition: ToolDefinition): (value: unknown) => boolean {
  if (definition.parameters.type !== 'object') throw new Error('工具参数必须定义为 JSON Schema object。')
  return new Ajv({ strict: true }).compile(definition.parameters)
}
