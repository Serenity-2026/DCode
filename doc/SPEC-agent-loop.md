# 简洁代理循环与统一模型消息

## 参考与范围

2026-10-07 核对 pi 最新发布版为 [v1.0.4](https://github.com/earendil-works/pi/releases/tag/v1.0.4)，源码提交 `7c10bd4337495ee613f2224843ecdf349b80d1df`。

阅读 [agent-loop.ts](https://github.com/earendil-works/pi/blob/v1.0.4/packages/agent/src/agent-loop.ts)、[消息类型](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/types.ts)、[OpenAI 适配](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/api/openai-completions.ts)、[Anthropic 适配](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/api/anthropic-messages.ts)及 [跨模型转换](https://github.com/earendil-works/pi/blob/v1.0.4/packages/ai/src/api/transform-messages.ts)。借鉴其统一内容块与工具结果消息、在模型边界转换协议、工具结果追加上下文后继续循环的结构，自行实现项目需要的子集，不引入 pi 包或复制完整运行时。

实现文本/推理/工具调用统一消息、OpenAI Chat Completions 与 Anthropic Messages 双向适配、顺序 function call、agent loop。生产工具已由 bootstrap 注入 read、bash、edit、write，具体行为见 `SPEC-file-tools.md`。暂不加生成队列、steering、并行工具、审批、压缩、后台运行、执行记录持久化或断点恢复。

## 分层

- `domain/llm.ts`：统一消息、text/thinking/toolCall 内容块、toolResult、模型调用端口和工具契约；没有供应商字段名或 Node/Electron 依赖。
- `infrastructure/llm/`：共享 SSE 解码，OpenAI 与 Anthropic 请求/回复转换；外部协议只在这里出现。
- `infrastructure/model-client.ts`：选择适配器、模型发现、HTTP、现有空闲超时与错误处理。
- `infrastructure/tool-schema.ts`：编译工具 JSON Schema；不修正或隐式转换参数。
- `domain/agent.ts`：循环上下文、编译后的工具、AgentState 与生命周期事件契约。
- `services/agent-loop.ts`：只执行一次运行的模型/工具循环，通过事件上报消息、轮次与工具结果；没有持久会话状态或取消控制器。默认最多 8 次模型请求。
- `services/agent.ts`：独立 Agent 运行时，拥有统一消息、工具、公开模型配置、运行状态、取消控制器与事件订阅；用循环事件更新状态。
- `services/agent-session.ts`：应用会话层，替代原 Chat；准备成功历史、保存正文、订阅 Agent 事件并推送现有 StreamEvent，停止时调用 Agent.abort/waitForIdle。app 手动装配，不增加工具 IPC；目录附件可保存工作路径，其他消息存储结构不变。

## Agent 分层与事件

对应 pi v1.0.4 的 [AgentSession](https://github.com/earendil-works/pi/blob/v1.0.4/packages/coding-agent/src/core/agent-session.ts) → [Agent](https://github.com/earendil-works/pi/blob/v1.0.4/packages/agent/src/agent.ts) → agent loop：应用会话服务依赖 Agent，Agent 依赖 AgentLoop；Agent/AgentLoop 不依赖存储、IPC、窗口或会话服务。复现职责边界，保留当前项目的最小功能，不照搬 pi 的全部 API。

Agent 提供 replaceMessages、prompt、subscribe、abort、waitForIdle 和只读状态快照。prompt 追加用户消息，运行前同步占用执行状态，实际循环延迟到微任务，因此调用后立即取消可以阻止首次模型请求。成功与失败都在 agent_end 后释放运行状态；waitForIdle 包含会话订阅者的同步保存收尾。

事件包括 agent_start/end、turn_start/end、message_start/update/end 与 tool_execution_start/end。订阅回调为同步接口；本轮没有异步插件回调或事件队列。message_update 带正文/推理增量，message_end 带完整统一消息；Agent 保存完整工具记录，AgentSession 沿用一条回复的展示与磁盘格式。公开模型配置不包含 API Key，handler 不进入公开状态；状态与订阅事件均复制，避免外部修改运行上下文。

每次应用发送前，AgentSession 用成功问答历史替换 Agent 内存消息，随后 prompt 当前问题，防止会话或账号切换时混入前一轮上下文。独立使用 Agent 时，成功后可以连续 prompt 保留完整工具上下文；停止或失败后重试由调用方 replaceMessages 提供有效历史，当前不自动修复未完成的工具调用。应用会话层每次发送都重新提供有效历史。停止调用 abort 并等待 idle；工具仍需要配合 AbortSignal。

验证：独立 Agent 无 Electron/存储依赖；完整事件顺序与状态、工具上下文保留、快照/订阅隔离、并发拒绝、取消前后不继续请求、失败后可再次运行；会话停止等待最终保存，旧 IPC/重试/双协议与桌面场景继续通过。

## 协议选择

所选模型继承它所属服务的 `api`：`openai-completions` 或 `anthropic-messages`。设置新增「API 协议」，自定义网关必须明确选择。不能凭模型 ID 判断协议，Claude 也可能由 OpenAI 兼容网关提供。

旧配置未指定协议时，只有官方 `api.anthropic.com` 自动使用 Anthropic，其余沿用 OpenAI 兼容格式；环境配置同样遵循此规则。新字段可选，schema 3 旧数据无需迁移。模型发现、编辑留空密钥、刷新和实际发送均使用同一协议。

OpenAI 使用 Bearer、`/chat/completions`、`tool_calls` 和 `role: tool`；Anthropic 使用 x-api-key、anthropic-version、`/v1/messages`、独立 system、`tool_use` 和用户消息中的 `tool_result`。原生 Anthropic 的模型列表支持分页。Anthropic 不发送 OpenAI 专用的快速模式/强度字段。

OpenAI 兼容请求不按 DeepSeek 等服务域名特判参数：所选强度控制 `reasoning_effort`，快速模式控制 `service_tier: "priority"`，不自动追加供应商专有 `thinking`。Base URL 只用于请求地址和同源判断；同一协议与选项在官方地址、代理和自定义网关上生成相同请求体。服务拒绝选项时返回对应提示，不自动降级重发。

## 循环与消息转换

应用会话文本先转换为统一消息。适配器将供应商 SSE 转为统一内容块与结束原因，AgentSession 仅消费正文/推理增量。完整 assistant 消息与工具结果在本次运行内保留，下一次请求再转换到目标供应商格式；Anthropic 同轮多个结果合并为紧随 assistant 的用户消息。

同次调用保留供应商原生推理签名/加密推理块，仅向原 API、服务地址和模型回传；跨供应商或跨模型不发送旧签名。跨用户轮次仍沿用现有成功问答文本，不重放工具调用或推理，不新增磁盘消息格式。

工具仅由可信主进程代码注册，定义包含名称、说明、JSON Schema 与 handler。参数解析并验证通过才执行；未知工具、schema 错误、handler 失败生成 toolResult 错误供模型修正。断流、截断或不完整工具协议终止，不执行半截调用；取消信号贯穿模型与工具，取消后不继续请求。handler 需要配合 AbortSignal，框架不能撤销已发生的副作用。

## 验证

必须验证两种供应商的实际请求、流回复、工具参数分块与多轮回传；Anthropic 推理签名、tool_result 分组与错误标记；根据所选服务选协议而非模型名称；旧配置兼容、原生模型发现/分页；无效参数、未知工具、截断、取消、轮次上限与普通聊天回归。

本轮验证通过：类型检查、生产构建、12 个文件共 92 个单元测试与 6 个本地 Electron E2E。真实服务 smoke 默认跳过，未使用真实服务密钥进行付费请求。
