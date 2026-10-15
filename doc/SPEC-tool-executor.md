# 工具批次执行

## 范围与契约

ToolExecutor 负责单个 turn 的工具查找、参数校验、分组执行、取消、结果校验及工具事件。AgentLoop 只负责模型请求、正式消息和轮次推进；执行器不依赖具体工具、文件系统、会话或存储。文件读取版本校验由文件工具实现，见 `SPEC-file-tools.md`。

AgentTool 与 WorkspaceTool 可声明本地 executionMode：parallel 或 sequential，未声明默认 sequential。ToolRuntime.bind 与 Agent 注册保留此属性；公开工具声明和供应商请求仅包含 name、description、parameters，不发送执行属性或 handler。内置 ReadTool 声明 parallel，BashTool、EditTool、WriteTool 声明 sequential。

## 分组与执行

按模型调用顺序扫描，连续 parallel 调用组成一组，每个 sequential 调用单独一组；不跨串行调用重新排序。例如 A/B 并行、C 串行、D/E 并行，得到 [A,B] → [C] → [D,E]。组内同时启动，等待整个组结束再启动下一组。不同执行批次不共享运行状态，同文件修改继续由文件工具自己的队列协调。

ToolExecutor 只发 tool_execution_start/end，结束事件按实际完成顺序发出。AgentLoop 收集完成结果，在执行批次结束后按调用顺序发 message_end，将结果记入 Agent 正式历史；取消或订阅失败时也在 finally 中记录已完成结果。message_end 表示消息进入历史，不替代工具结束事件。整批结果保持模型原顺序，全部处理后才发 turn_end 或请求模型。

未知工具、参数不匹配、校验器异常、执行异常和结果处理异常都形成结构化错误 toolResult，保留原 toolCallId 并设置 isError: true，不阻止其他调用或后续组；ToolExecutionError 保留原文本，其他异常使用“工具调用异常：原因”，不再仅返回通用失败提示。错误在单次调用边界转换，因此 Promise.allSettled 的 fulfilled 也可能包含失败结果。保留完整 AgentToolResult；整批所有结果要求 terminate 才结束，单项 terminate 不提前跳过后续组。

用户取消时，已启动调用停止等待，后续组不启动；已完成结果按顺序保留。不能撤销工具副作用，文件队列仍持有到实际磁盘操作结束。订阅者等框架异常需要等待同组的已启动调用结算后再向上抛出，避免 Agent 结束后仍有同组事件写入下一次运行。整批重复调用 ID 在执行前拒绝，跨 turn 重复仍由单次 Loop 状态检查。

## 验证

使用受控 Promise 验证并行重叠、串行屏障、连续串行和默认模式；结果源顺序、事件完成顺序、失败继续、框架异常结算、取消不启动后续组以及共享执行器的批次隔离。通过 Agent 和两种模型协议验证属性保留、工具参数不泄露本地执行属性、下一次请求等待所有组完成与整批终止规则。架构检查禁止执行器导入具体工具、应用会话或存储；异常与事件职责由 tool-executor、agent、agent-runtime、architecture 测试及类型检查验证，不使用真实服务请求。
