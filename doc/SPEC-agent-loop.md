# Function calling 与 Agent Loop 基础框架

## 范围与成功标准

在现有聊天入口接入「请求模型 → 校验工具调用 → 顺序执行 → 回传结果 → 再请求模型」循环。普通聊天仍可流式显示、停止、重试和恢复。此次只建立框架，生产工具注册表为空；没有文件写入、终端、网络工具、自动授权、并行执行或断点续跑。

验证必须覆盖多轮与多工具、分块参数、错误参数不执行、未知工具不执行、工具失败反馈、取消与超时、预算耗尽、断流不执行工具，以及记录保存和重启恢复。

## 分层与依赖

- `domain/agent.ts`：环境无关的模型消息、模型轮次、工具定义、执行上下文与预算；模型端口只接收 AbortSignal。
- `infrastructure/model-client.ts`：OpenAI 兼容 Chat Completions HTTP/SSE，转换工具协议，按 index 拼接参数，完整结束后才交付工具调用。
- `infrastructure/tool-parameters.ts`：Ajv 编译 JSON Schema draft-07，启动时检查开发者提供的参数定义，不隐式转换或修正模型参数。
- `services/tool-registry.ts`：工具白名单、重复注册拒绝、JSON 与 schema 校验、执行超时和输出大小限制。
- `services/agent-loop.ts`：调度模型与工具、维护本次运行的协议上下文、执行预算和取消；不持有磁盘仓库、窗口或 Electron。
- `services/chat-service.ts`：认证、会话与任务生命周期、执行记录保存、流事件与终态；不实现工具调度。
- `app/bootstrap.ts`：手动装配模型端口、工具注册表和循环；工具只在此处由可信主进程代码注入，renderer 不能注册或指定工具权限。
- `shared/types.ts`：在回复上增加可选执行记录 DTO；Repository 校验磁盘结构，StateService 在启动时将遗留待执行/运行中工具标记为 stopped。

## 执行协议

模型请求仅在工具非空时发送 `tools` 与 `tool_choice: auto`。按流的 tool_calls index 聚合 id/name/arguments，要求调用 ID 非空且唯一、function 类型及完整工具结束标记。缺失 [DONE]、截断、格式错误或结束原因不匹配时终止，绝不执行半截参数。

每轮先保存完整 assistant 工具调用，然后按声明顺序执行，每个调用都生成匹配 tool_call_id 的工具结果。未知工具、无效 JSON/schema、工具异常和工具超时产生明确失败结果供模型修正；参数失败不进入工具 handler。工具内部异常使用固定信息，不把栈或可能含密钥的异常文本回传。取消直接终止循环，不作为工具失败让模型继续。

同一运行不允许重复调用 ID。默认最多 8 次模型请求、每轮 8 个工具、总共 32 次工具调用；参数最多 64 KiB、每个结果最多 128 KiB。工具默认 30 秒超时，运行最多 5 分钟；模型请求沿用 60 秒空闲超时。预算耗尽保留部分内容并明确失败，不伪装成功。

工具必须响应执行上下文的 AbortSignal，释放其外部资源；框架停止等待不合作的异步 handler，但无法强制撤销 handler 已产生的副作用。后续具有副作用的工具需要单独定义权限与审批流程，附件选择不构成授权。

## 持久化与界面

schema 3 增加可选 `agentRounds`，旧数据无需迁移；普通用户消息不得携带执行记录。每轮保存正文、推理、调用参数、状态与工具结果，流事件沿用完整 Message DTO。工具执行前保存检查点，保存失败就不执行；重启保留已有结果并标记未完成工具为 stopped，不自动重新执行。

同次运行向模型回传完整调用与结果，包括服务要求的 reasoning_content；跨用户轮次沿用已有成功问答上下文，只发送最终展示文本，不重放工具记录或推理。重新生成从原问题与附件重新开始，有副作用工具接入前必须明确重试语义。

本轮不增加界面解释、工具按钮或配置项。执行记录供后续展示接入；现有回复保持流式追加模型各轮文本，空正文的工具调用也能继续下一轮，最终一轮必须返回非空文本。

## 后续接入

在主进程实现工具的定义与 handler，由 bootstrap 注入 ToolRegistry；JSON Schema 明确 required、类型及 additionalProperties。handler 只获取已校验参数与 AbortSignal，不获取模型密钥。系统能力通过 domain 契约和 infrastructure 实现，工具权限、业务工具与展示作为后续独立需求。

协议依据：[Chat Completions 工具调用](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[流式事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)、[Ajv schema 管理](https://github.com/ajv-validator/ajv/blob/master/docs/guide/managing-schemas.md)，实施前通过 Context7 查阅。

## 验证结果（2026-10-07）

- `npm run typecheck` 通过；`npm test` 11 个文件、94 个测试通过，含分层与循环依赖检查。
- `npm run test:e2e` 生产构建通过、5 个本地 Electron 场景通过，真实服务 smoke 跳过，未请求真实服务。
- 三轮、三次顺序工具调用走正式模型/SSE 适配器验证参数与结果回传，最终记录可由 StateRepository 重新读取。
- 验证错误参数/未知工具不执行、handler 异常不泄漏、参数/结果大小限制、非合作工具取消与超时、总体运行超时、预算耗尽、重复调用 ID、断流拒绝执行、检查点保存失败及中断恢复。
