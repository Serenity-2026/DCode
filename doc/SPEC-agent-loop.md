# 简洁代理循环与统一模型消息

## 参考与范围

2026-10-07 核对 pi 最新发布版为 [v1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4)，源码提交 `7c10bd4337495ee613f2224843ecdf349b80d1df`。

阅读 [agent-loop.ts](https://github.com/earendil-works/pi/blob/v1.0.4/packages/agent/src/agent-loop.ts)、[消息类型](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/types.ts)、[OpenAI 适配](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/api/openai-completions.ts)、[Anthropic 适配](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/api/anthropic-messages.ts)及 [跨模型转换](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/api/transform-messages.ts)。借鉴其统一内容块与工具结果消息、在模型边界转换协议、工具结果追加上下文后继续循环的结构，自行实现项目需要的子集，不引入 pi 包或复制完整运行时。

本轮仅实现文本/推理/工具调用统一消息、OpenAI Chat Completions 与 Anthropic Messages 双向适配、顺序 function call、agent loop。生产工具列表为空，后续由 bootstrap 注入具体工具。暂不加队列、steering、并行工具、审批、压缩、后台运行、执行记录持久化、断点恢复或业务工具。

## 分层

- `domain/llm.ts`：统一消息、text/thinking/toolCall 内容块、toolResult、模型调用端口和工具契约；没有供应商字段名或 Node/Electron 依赖。
- `infrastructure/llm/`：共享 SSE 解码，OpenAI 与 Anthropic 请求/回复转换；外部协议只在这里出现。
- `infrastructure/model-client.ts`：选择适配器、模型发现、HTTP、现有空闲超时与错误处理。
- `infrastructure/tool-schema.ts`：编译工具 JSON Schema；不修正或隐式转换参数。
- `services/agent-loop.ts`：一个循环服务，获取完整统一回复、验证并顺序执行工具、追加结果，无工具调用时返回；默认最多 8 次模型请求以阻止无限循环。
- `Chat`：沿用已有发送、保存正文、流推送、停止和重试；app 手动装配，不增加工具 IPC 或新的存储结构。

## 协议选择

所选模型继承它所属服务的 `api`：`openai-completions` 或 `anthropic-messages`。设置新增「API 协议」，自定义网关必须明确选择。不能凭模型 ID 判断协议，Claude 也可能由 OpenAI 兼容网关提供。

旧配置未指定协议时，只有官方 `api.anthropic.com` 自动使用 Anthropic，其余沿用 OpenAI 兼容格式；环境配置同样遵循此规则。新字段可选，schema 3 旧数据无需迁移。模型发现、编辑留空密钥、刷新和实际发送均使用同一协议。

OpenAI 使用 Bearer、`/chat/completions`、`tool_calls` 和 `role: tool`；Anthropic 使用 x-api-key、anthropic-version、`/v1/messages`、独立 system、`tool_use` 和用户消息中的 `tool_result`。原生 Anthropic 的模型列表支持分页。Anthropic 不发送 OpenAI 专用的快速模式/强度字段。

## 循环与消息转换

应用会话文本先转换为统一消息。适配器将供应商 SSE 转为统一内容块与结束原因，Chat 仅消费正文/推理增量。完整 assistant 消息与工具结果在本次运行内保留，下一次请求再转换到目标供应商格式；Anthropic 同轮多个结果合并为紧随 assistant 的用户消息。

同次调用保留供应商原生推理签名/加密推理块，仅向原 API、服务地址和模型回传；跨供应商或跨模型不发送旧签名。跨用户轮次仍沿用现有成功问答文本，不重放工具调用或推理，不新增磁盘消息格式。

工具仅由可信主进程代码注册，定义包含名称、说明、JSON Schema 与 handler。参数解析并验证通过才执行；未知工具、schema 错误、handler 失败生成 toolResult 错误供模型修正。断流、截断或不完整工具协议终止，不执行半截调用；取消信号贯穿模型与工具，取消后不继续请求。handler 需要配合 AbortSignal，框架不能撤销已发生的副作用。

## 验证

必须验证两种供应商的实际请求、流回复、工具参数分块与多轮回传；Anthropic 推理签名、tool_result 分组与错误标记；根据所选服务选协议而非模型名称；旧配置兼容、原生模型发现/分页；无效参数、未知工具、截断、取消、轮次上限与普通聊天回归。
