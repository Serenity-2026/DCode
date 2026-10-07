# DCode 分层架构规范

## 研究与决策

2026-10-06 查阅的项目一手资料：

- [VS Code 源码组织规范](https://github.com/microsoft/vscode/wiki/Source-Code-Organization)：按基础能力、平台服务、编辑器和工作台划分，区分 common、browser、node、electron 等运行环境，并明确依赖约束。
- [Cherry Studio 架构](https://github.com/CherryHQ/cherry-studio/blob/main/docs/references/architecture/README.md)及 [IPC Router](https://github.com/CherryHQ/cherry-studio/blob/main/src/main/ipc/IpcRouter.ts)：分开进程入口、IPC 分发、业务服务及 UI。
- [Joplin 架构](https://github.com/laurent22/joplin/blob/dev/readme/dev/spec/architecture.md)：区分界面、服务、持久化模型和系统集成，跨客户端复用后端能力。
- [Electron IPC 文档](https://github.com/electron/electron/blob/main/docs/tutorial/ipc.md)：preload 暴露业务白名单，主进程处理请求与响应，页面不获得通用 IPC 权限。

结论：大型 Electron 项目需要明确职责和依赖方向，目录名没有统一强制标准。DCode 采用进程边界外加 Controller / Service / Repository 分层；业务服务采用构造器注入，启动装配统一管理实例。无需引入装饰器、依赖注入框架或数据库来完成这次结构调整。

## 目录与职责

```text
src/main/
  index.ts                         只调用应用启动入口
  app/bootstrap.ts                 读取配置、装配实例、注册控制器、应用生命周期
  windows/main-window.ts           窗口创建、网页权限、加载、关闭和流事件推送
  ipc/ipc-router.ts                来源校验、Result 包装、互斥操作
  controllers/                    按账号、模型、聊天、状态、桌面操作注册接口
  services/                       AgentSession、Agent、AgentLoop、Auth、Models、StateService、DesktopService
  repositories/state-repository.ts JSON 读取、格式验证、原子保存与内存回滚
  infrastructure/                 模型 HTTP/SSE、附件文件读取、系统密钥、环境配置、原生桌面适配
  domain/                         主进程内部数据类型、模型配置、系统能力契约、纯校验函数
src/preload/index.ts                有限的 window.dcode API，保持原有 IPC 协议
src/shared/                        跨进程 DTO、通道和纯上下文规则
src/renderer/src/
  app/App.tsx                      根组件、登录路由、主题
  features/auth/                   账号界面
  features/settings/               设置界面
  features/chat/                   工作台及聊天组件
  components/                     品牌与通用布局
  main.tsx                         React 挂载入口
```

## 依赖规则

1. app 是装配入口，可连接全部主进程模块；其他层不得反向导入 app。
2. Controller 只连接 IPC Router 和 Service；不得直接读写仓库、文件或调用模型 HTTP。
3. Service 管理业务规则，依赖同层服务、领域类型、Repository 和基础设施；不得导入 Electron、Controller、窗口或 IPC。
4. Repository 只负责数据结构有效性和存储，不能依赖 Service、Controller 或 Electron。账号权限、快照裁剪、会话准备和偏好规则属于 StateService。
5. infrastructure 负责外部系统适配，不依赖 Service 或 Controller；桌面适配通过领域契约注入 DesktopService。
6. domain 与 shared 保持环境独立，不能导入 Electron、Node 系统模块或 UI。
7. renderer 不得导入 main、preload、Electron 或 Node；preload 不得导入 main 或 renderer。跨进程只传 DTO，不共享业务实例。
8. 通用 UI components 不依赖 features；根 app 负责装配 feature。

StateRepository 保持一份 schema 3 的 JSON 数据和一个事务边界，避免把同一次账号/会话修改拆成多次磁盘写入。StateService 负责运行时认证身份及业务状态规则，事务失败时同时恢复数据与认证身份。已有文件格式、用户目录、账号密文、模型协议和 UI 行为不改变。

## 新功能落点

- 新 IPC 操作：shared 定义 DTO/通道 → preload 白名单 → 对应 Controller → Service。
- 新模型协议：infrastructure 实现请求/解析，Service 管理请求生命周期。
- 工具循环与消息转换：domain 定义统一消息和 ModelStream 契约，infrastructure 做供应商适配与参数 schema 编译，AgentLoop 顺序执行工具并继续请求，通过事件更新 Agent 的消息与运行状态；AgentSession 负责应用会话与保存，不持有取消控制器。Agent/AgentLoop 不依赖会话、存储或 IPC，app 装配三个对象并注入工具。范围及 pi 参考版本见 `SPEC-agent-loop.md`。
- 新持久化规则：领域数据类型和 Repository；业务权限检查放 Service。
- 新桌面能力：领域能力契约 → infrastructure 原生适配 → Service → Controller。
- 新页面：features 下对应业务目录；跨业务复用的展示组件放 components。
- 类和核心方法使用中文注释说明职责、依赖；规格解释留在 doc，界面只保留操作所需文字。

## 验证标准

- 重构前已有 54 个单元测试通过；重构后全量单元测试、类型检查、构建和本地模拟服务 E2E 均通过。
- 架构测试扫描 import / export / 动态 import / require，阻止跨进程导入、反向依赖和循环依赖。
- IPC 测试验证来源拒绝、结果包装、互斥释放，以及停止操作不受生成锁阻止。
- 保留既有未提交内容；删除被迁移实现的旧入口，不增加兼容转发文件。

## 本次验证结果

- `npm run typecheck`：通过。
- `npm test`：9 个测试文件、61 个测试通过，包括依赖边界/循环检测、IPC 来源与互斥验证、持久化失败时身份和数据回滚。
- `npm run test:e2e`：构建通过，5 个本地模拟服务场景通过；真实服务 smoke 为 opt-in，本次跳过，未发送真实模型请求。
- E2E 覆盖账号、模型发现/切换、快速模式、流式回复、停止、重启、附件、上下文/强度控件、欢迎页、侧栏及消息导航。
