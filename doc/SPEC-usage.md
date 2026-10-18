# 账号用量统计

## 数据与口径

- 从本功能启用后的请求开始记录，旧聊天没有真实用量，不能从正文长度补算。未返回 Token 数的请求显示缺失数量；中断请求可能只有部分用量。本页是应用实际收到的用量，不替代供应商账单。
- OpenAI 兼容请求发送 `stream_options.include_usage: true`。读取 `usage.total_tokens`，缺失时使用有效的 `prompt_tokens + completion_tokens`。缓存和推理明细已经包含在这些总数中，不重复相加。未提供用量的兼容服务可继续聊天。
- Anthropic 从 `message_start`、`message_delta` 合并累计计数：`input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens`；忽略缺失或 null 字段，不覆盖已知输入用量。
- 同一请求每次只累加新增 Token；重复报告不重复入账。工具循环中的每个模型请求分别计数，失败、停止时保留已收到的数据。
- 每笔增量归入收到它时的本机自然日，日期保存为 `YYYY-MM-DD`，修改时区不会重新分配过去记录。跨午夜请求可分布在两个自然日。
- 累计 Token 数和单日峰值按账号全部记录计算；最长任务用时从一次发送/重试开始到结束，包含工具等待和失败/停止任务，不包含应用关闭后的离线时间。崩溃恢复以最后保存的活动时间结束未完成任务，可能少计崩溃前尚未保存的时间。
- 活跃日指记录到 Token 的自然日；最长连续天数按相邻日计算。当前连续天数允许今天尚未使用、但昨天有使用的连续记录；今天和昨天都没有 Token 时为零。

## 页面

- 显示账号头像缩写、名称、账号及五项统计概览。
- 活动区显示最近 53 周，周一至周日自上而下，时间从左到右。未来日期不显示按钮。
- 每天：每格为一天，悬停或键盘聚焦显示完整日期与当天 Token 数。
- 每周：每列为一周，提示日期范围和周总量。
- 累计总量：每格为截至当日的账号历史累计量，提示同时显示当天与累计 Token 数；窗口之前的消耗也计入累计。
- 颜色按当前视图最大值分四档，零用量为灰色；适配深浅主题，小窗口仅日历区域允许横向滚动。
- 常用 MCP、常用 Skill 各按调用次数降序显示前五名。无记录时显示空状态，不生成示例数据。

## MCP / Skill 计数接入

当前项目尚未实现 MCP 与 Skill 的注册和执行入口，因此真实账号暂时没有这两类记录。统计层已接通：注册 `AgentTool` 时显式提供 `usageIdentity: { kind: 'mcp' | 'skill', name: '服务或技能名称' }`。同一个 MCP 的多个工具使用同一服务名即可合并排行。

身份仅来自主进程注册信息，经过参数校验的调用开始时计一次，后续失败或停止仍计数。不根据模型生成的 `mcp_*` 名称推断身份；内置文件、命令行工具不冒充 MCP 或 Skill。身份不发送给模型。

## 保存与通知

- `StoredUser.usageRecords` 是可选字段，旧 schema 4 文件兼容。每次发送或重试创建独立记录，和消息 ID 对应；删除会话或替换回复不会删除已发生的消耗。
- `AgentSession` 处理流事件并持久化计数；`StreamEvent.usageRecord` 实时更新界面，普通快照也携带当前账号记录。未认证或切换到其他账号时不暴露原账号统计。
- 仓库验证日期、非负整数、请求数量、工具类别和记录 ID 唯一性。重启时修复未结束任务，不依赖旧会话是否存在。

## 协议来源

- [OpenAI 流式用量](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)：usage 单独出现在末尾空 choices 帧，中断时可能缺失。
- [Anthropic 流事件](https://platform.claude.com/docs/en/build-with-claude/streaming)：message_delta 用量为累计数。
- [Anthropic 官方 TypeScript 类型](https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/resources/messages/messages.ts)：输入、输出和缓存计数的定义。

## 验证

自动化覆盖两种流协议的用量解析、重复报告、多轮累加、跨午夜与停止、失败缺失数据、重试/删聊天后的保留、旧文件兼容、损坏记录拒绝、崩溃恢复、账号隔离，以及可信 MCP/Skill 身份计数。

Electron 测试通过本地 SSE 服务验证实际请求、界面即时更新、持久化和账号切换，并使用隔离测试账号的历史记录验证热力图、累计视图和排行；截图检查覆盖深浅主题和小窗口。没有调用真实付费模型，也没有向真实账号写入示例记录。

验证结果：类型检查、生产构建、233 项单元测试和 5 项相关 Electron E2E 通过。
