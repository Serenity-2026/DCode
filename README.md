# DCode

TypeScript + Electron 的 Coding Harness 基础框架。包含本机账号与密码登录、账号独立的会话和模型配置、模型流式对话，以及 React + Ant Design 桌面界面。

当前账号与模型功能的范围见 [doc/SPEC-account-models.md](doc/SPEC-account-models.md)，初始对话框架见 [doc/SPEC.md](doc/SPEC.md)。当前版本提供本机账号认证与对话，不执行终端命令、读写代码工程或同步云端账号。

## 开发与启动

需要 Node.js 22.12+（推荐 Node.js 24 LTS）和 npm。

```sh
npm ci
cp .env.example .env.local
chmod 600 .env.local
# 编辑 .env.local，填入自己的 DEEPSEEK_API_KEY
npm run dev
```

本工作区已经配置 `.env.local`，不需要重新复制示例文件。开发模式支持界面热更新。

首次启动点击“注册”，设置账号和密码。如果已有旧版聊天档案，在注册时选择“关联旧档案”即可保留历史对话。登录成功后会一直保持登录，关闭并重启无需再次输入密码；点击左下角账号菜单中的“退出登录”才会注销。

在“设置 → 模型配置”添加或编辑服务地址、API Key 和模型 ID，点击“测试并保存”。只有连通测试通过才保存，失败会提示原因并保留原配置。编辑已保存模型时，API Key 留空表示沿用原密钥。输入框下方的模型菜单可切换已保存配置，下一条消息使用新选择；点击闪电显示“仅对支持加速的模型生效”。

```sh
npm run build
npm start
```

`npm run pack` 生成当前系统可运行的应用目录到 `release/`；安装包分发、签名与公证不在首版范围。首次安装若 npm 拦截 Electron 下载脚本，执行 `node node_modules/electron/install.js` 下载运行时。

## 环境变量

| 变量 | 用途 | 默认值 |
| --- | --- | --- |
| `DEEPSEEK_BASE_URL` | 首个注册账号的初始服务地址 | `https://api.deepseek.com` |
| `DEEPSEEK_API_KEY` | 首个注册账号的初始模型 API 密钥，仅主进程读取 | 无 |
| `DEEPSEEK_MODEL` | 首个注册账号的初始模型 ID | `deepseek-flash` |
| `DCODE_USER_DATA_DIR` | 覆盖本地数据目录，供测试隔离使用 | Electron userData |

启动时加载根目录 `.env.local` 到 `process.env`，系统已有环境变量优先。环境配置仅导入首个注册账号；之后在设置页修改，其他账号自行添加模型。更改环境文件不会覆盖已保存的账号模型配置。

打包后的应用读取 userData 目录下的 `.env.local` 或系统环境变量；也可以直接注册后在设置页配置模型。通过 Finder 启动通常不会继承终端变量。

密钥由主进程通过 Electron safeStorage 加密保存，已保存密钥不回显到 renderer。保持登录使用同样加密的随机令牌，密码仅保存随机盐与 scrypt 哈希。系统安全存储不可用时会提示错误，不保存明文秘密。`.env.local` 被 Git 忽略，发布文件不包含环境文件。请求不跟随 HTTP 重定向，服务地址需为 HTTPS（本机 localhost/127.0.0.1 允许 HTTP）。

连通测试会发送一条最多 16 个输出 token 的短流式请求，15 秒内未完成则超时；测试可能产生少量模型 API 费用。

DeepSeek 模型 ID 已通过账户 `/models` 接口确认，基础聊天使用 Flash 非思考模式。接口参考：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。

## 数据与操作

macOS 默认数据文件：`~/Library/Application Support/DCode/state.json`。Windows 与 Linux 使用 Electron 对应的用户数据目录。账号、会话、主题偏好与加密的模型配置保存在此文件中，写入使用临时文件原子替换；请在应用关闭后备份数据。旧版升级前自动保留 `state.json.v1.backup`。聊天正文仍是本机 JSON，OS 用户可读取；加密的秘密依赖当前 OS 安全存储，复制数据文件到其他机器不保证可解密。

- `Enter` 发送，`Shift + Enter` 换行；中文输入法组词时不会发送。
- `Cmd/Ctrl + N` 新对话。
- 生成中点击停止按钮，保留部分回复；可重新生成最后一个回答。
- 搜索匹配标题与消息正文。每个账号只展示自己的会话、模型配置和主题。
- 切换账号需先退出，再使用其他账号的密码登录；账号菜单可修改显示名称。
- 删除会话需要确认。
- Markdown 代码块可复制，外部链接在系统浏览器打开，远端图片及 HTML 不加载。

## 检查与测试

```sh
npm run typecheck
npm test
npm run test:e2e
```

单元测试验证账号密码、保持登录与注销、旧档案迁移、账号隔离、模型测试失败回滚、配置切换、上下文与 SSE 协议；E2E 启动真实 Electron 窗口，验证注册登录、模型编辑/测试/切换、错误提示、输入框焦点、闪电提示、流式显示、停止/重试、复制、会话管理、主题、窄窗口和重启恢复。测试数据在系统临时目录中，结束后删除。

真实 DeepSeek 测试默认关闭，以免常规测试发起付费请求。可显式执行：

```sh
DCODE_LIVE_TEST=1 npm run test:e2e
```

该测试读取本地环境配置，在隔离账号中实测“测试并保存”并发送一条短消息；不会输出密钥。它会与本地服务 E2E 一起运行。

## 项目结构

```text
src/main/       窗口、安全 IPC、账号认证、安全存储、配置、持久化和模型请求
src/preload/    受限桌面 API
src/shared/     跨进程类型及通道
src/renderer/  登录、对话、模型与主题设置、Markdown
tests/unit/     账号、模型、存储与流协议测试
tests/e2e/      Electron 全链路测试
doc/SPEC.md     首版规格
doc/SPEC-account-models.md 账号与模型设置规格
```

UI API 查询使用项目自带 CLI，例如 `npx --no-install antd info Button`。Electron 安全机制参考：[官方安全文档](https://www.electronjs.org/docs/latest/tutorial/security)。
