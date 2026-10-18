# 设置分类、字体与服务地址预设

- 用户设置：模型、用量统计、记忆、已归档。
- 通用设置：外观、沙箱、插件市场、电脑操控、技能、MCP 服务器。未实现的功能继续显示占位页。
- 账号入口移到设置侧栏底部，保留编辑名称与退出登录。
- 外观包含主题、字体和字号。字体使用本机字体栈（系统默认、无衬线、衬线、等宽）；字号提供 12 / 14 / 16 / 18 px。字体应用于界面文字，字号应用于聊天正文、输入框和 Ant Design 控件；固定的导航标签、标题层级与代码块样式保留。预览即时更新。
- 字体偏好通过既有 action IPC 按账号保存；主进程校验白名单，旧账号无此字段时使用系统字体、14 px，不变更 schema 版本。
- 服务地址允许选择预设或手工输入。切换协议时仅转换完整匹配的预设地址，不重写自定义代理地址。缺少对应协议的供应商选项禁用；切换到其不支持的协议会清空预设地址，要求重新选择。
- 地址输入前缀和预设列表复用聊天模型图标，增加 MiMo 图标及 bigmodel 地址识别。图标随应用打包。
- 设置下拉框与聊天模型菜单共用选中、悬浮、文字配色和即时展开行为。设置弹窗自身保留原动画。
- 预设仅帮助填写地址；模型列表和密钥仍由“测试并保存”验证，不预置模型 ID、不请求真实供应商验证密钥。

## 官方地址来源

核对日期：2026-10-18。地址按服务实际协议映射，不使用统一字符串替换。Anthropic 传输层会补齐 `/v1`。

| 供应商 | OpenAI 兼容 | Anthropic Messages | 来源 |
| --- | --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `https://api.deepseek.com/anthropic` | [首次调用](https://api-docs.deepseek.com/)、[Anthropic 兼容](https://api-docs.deepseek.com/guides/anthropic_api/) |
| Kimi | `https://api.moonshot.cn/v1` | `https://api.moonshot.cn/anthropic` | [快速开始](https://platform.kimi.com/docs/get-api-key)、[Messages](https://platform.kimi.com/docs/api/messages) |
| GLM | `https://open.bigmodel.cn/api/paas/v4` | `https://open.bigmodel.cn/api/anthropic` | [API 示例](https://docs.bigmodel.cn/cn/best-practice/case/ai-search-engine)、[Anthropic 接入](https://docs.bigmodel.cn/cn/guide/develop/claude) |
| MiMo | `https://api.xiaomimimo.com/v1` | `https://api.xiaomimimo.com/anthropic` | [OpenAI 调用](https://platform.xiaomimimo.com/docs/en-US/usage-guide/passing-back-reasoning_content)、[官方接入示例](https://github.com/XiaomiMiMo/awesome-mimo-agent/blob/main/docs/claude_code.md) |
| OpenAI / ChatGPT | `https://api.openai.com/v1` | — | [Chat API](https://developers.openai.com/api/reference/resources/chat) |
| Claude | — | `https://api.anthropic.com` | [Messages API](https://platform.claude.com/docs/en/api/messages/create) |

GLM 普通 API 与 Coding Plan、MiMo 按量服务与 Token Plan 的密钥和端点可能不同；套餐专用地址仍可手工填写。协议兼容也不保证所有供应商均提供本项目要求的模型列表接口，保存失败时保留原有配置。

## 验证记录

类型检查与生产构建通过；221 项单元测试通过，包含字体偏好保存、账号隔离、旧文件兼容、非法值拒绝和官方地址别名识别。4 项相关 Electron E2E 通过，覆盖设置分组、账号编辑及退出、字体字号重启恢复、四家双协议地址互转、单协议供应商禁用、自定义地址保留、深浅主题下拉配色、窄窗口，以及原有模型保存和协议请求流程。视觉检查覆盖字体预览、带品牌图标的地址列表和 API 协议下拉框。
