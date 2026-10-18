# MCP 第一版

## 使用

在「设置 → MCP 服务器」添加服务。配置属于当前 DCode 账号，使用官方 MCP TypeScript SDK v2 客户端包 `@modelcontextprotocol/client`，版本锁定为 2.3.1。

- 本地进程：选择 stdio，分别填写可执行文件、JSON 参数数组、可选环境变量 JSON。不会通过 shell 拼接执行命令。需要自行安装服务要求的 Node.js、Python、npx 或 uvx；Finder 启动时 PATH 与终端可能不同，可填写可执行文件绝对路径。
- 远程服务：选择 Streamable HTTP，填写 HTTPS 地址；localhost、127.0.0.1、::1 允许 HTTP。认证可选无认证、请求头 / Token、OAuth 浏览器登录。
- 保存只写配置；点击「连接 / 重连」测试，或在下一轮聊天开始时连接已启用的服务。
- OAuth 点击「登录」打开系统浏览器。支持服务发现、动态客户端注册、授权码 + PKCE 和 Token 刷新。只支持能动态注册原生客户端的服务，暂未提供预注册 client ID/secret 配置。
- 「断开」关闭当前连接；下一轮聊天仍可重新连接。「停用」会保存关闭状态并移除可用工具。「清除授权」删除本地 OAuth 凭据，不代表服务端撤销授权。
- 工具正在执行时不能修改服务器配置；先停止任务。

环境变量和请求头留空保留已保存值，填写 `{}` 清除。变更服务地址、连接方式、认证方式、启动命令或启动参数时，留空不会将旧凭据转交给新服务。

## 模块与数据流

1. `shared/mcp.ts`：公开配置、操作、状态及基础校验。
2. `infrastructure/mcp/client.ts`：独立 SDK 客户端，启动 stdio 进程、连接 HTTP、发现工具、处理列表通知、执行和关闭。
3. `infrastructure/mcp/oauth.ts`：回环回调、浏览器入口和凭据存储接口，OAuth 协议由 SDK 完成。
4. `infrastructure/mcp/tools.ts`：MCP Tool → AgentTool，以及 CallToolResult → 模型内容。
5. `services/mcp-service.ts`：账号配置、会话连接、凭据加密与生命周期管理。
6. `controllers/mcp-controller.ts` / preload：受窗口来源检查的业务 IPC。
7. `features/settings/McpSettings.tsx`：添加、编辑、删除、启停、连接、登录、工具列表与连接状态。

每个会话拥有自己的连接，stdio 的 cwd 和 MCP roots 指向该会话目录。同一服务在不同会话中也不会共享进程。设置中的连接测试是独立连接：使用当前会话目录，无会话时使用应用 userData 目录。

Agent 每轮开始时取得 MCP 工具快照，并复用现有参数校验、串行调度、工具状态展示与错误处理。工具名称使用 `mcp__服务器__工具` 的规范化前缀和稳定哈希，长度不超过 64。MCP 列表变更会刷新连接中的工具，新声明在下一轮生效；已被删除的工具不能继续调用。

连接失败不会阻断其他服务或普通聊天。失败原因在设置中展示；没有成功连接的工具不会向模型声明。后台后续提问建议不携带 MCP 工具。

## 生命周期与边界

- 连接握手、发现请求上限各 10 秒，工具调用上限 60 秒。
- HTTP 临时网络错误、429、5xx 连接错误有限退避重试，最多 3 次；远程连接断开也尝试重连。stdio 不自动重启，在下次需要连接或手动重连时启动。
- 不自动重放失败的 `tools/call`，因为服务可能已经产生副作用。
- 停止任务将 AbortSignal 传递到 SDK，发送取消通知。取消不撤销已产生的外部副作用。
- 删除服务、停用、清除授权会先关闭现有连接；删除会话会清理其连接。关闭窗口、退出应用、退出登录统一等待连接、登录流程与凭据保存结束。已建立的 HTTP 会话会尝试发送 DELETE，最多等待一秒再关闭本地连接。
- 只在用户点击登录时开启回调监听。监听 127.0.0.1，校验随机 state；SDK 处理 PKCE 和授权服务器 issuer 绑定。登录等待上限两分钟；取消、失败和成功均释放端口。
- 环境变量、请求头及 OAuth 状态使用现有 safeStorage 加密后保存到账号的可选 `mcpServers` 字段，不改变 schema 4。公开快照与 IPC 不回显凭据；连接错误使用固定提示，避免上游异常带出 Token。

当前版本直接向模型声明所有可用 MCP 工具，且启用的服务允许模型调用其工具；尚无逐次调用审批或工具沙箱。roots 是向服务声明工作目录，不是操作系统访问隔离。MCP 引起的外部文件修改不会被当作内置 write/edit 纳入文件撤销。

## 返回值

- 文本及文本资源：模型接收总计最多 24,000 个字符，超出部分明确标记截断。
- PNG、JPEG、GIF、WebP：通过已有图片工具结果通道送入模型，总 base64 长度上限 8,000,000。
- 结构化结果保留在 Agent 工具结果中；服务未提供内容块时，将结构化结果序列化成文本。
- 资源链接转换成名称和 URI；不自动读取链接。音频和其他二进制内容显示不支持的类型。
- 保留 `isError`，不将 MCP 的私有 `_meta` 发送给模型。
- 用量统计记录 `kind: mcp` 与 `服务器/工具` 的调用次数；不虚构外部服务 Token 或费用。

## 后续 Codemode

Codemode 让模型编写短脚本来编排工具：搜索所需工具、按依赖执行或并发调用、过滤和聚合结果，最后仅将有用摘要交回模型。MCP 提供工具通信，Codemode 提供工具编排，两者可以独立使用。

后续可新增一个 `codemode` AgentTool，使用独立受限执行环境运行脚本。脚本只能访问经宿主批准的工具桥接接口，不开放 Node.js、文件、环境变量和任意网络；不能将 node:vm 当作安全沙箱。宿主执行每次调用时仍须验证工具存在、参数、启用状态和权限，并沿用取消、超时、状态展示与 MCP 统计。

在此基础上增加工具搜索、按需加载、执行时间/内存/输出预算与小型会话状态。第一阶段保持显式输入输出，不引入无限持久 REPL。是否采用 pi 使用的 QuickJS/WASM，需要单独评估 Electron 打包、异步桥接和资源限制，并覆盖逃逸边界及取消测试。

参考：[pi MCP](https://github.com/earendil-works/pi/blob/482c1381a00d8d00bc81697e4a980c593db6803e/packages/coding-agent/docs/mcp.md)、[Claude Code MCP](https://code.claude.com/docs/en/mcp)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
