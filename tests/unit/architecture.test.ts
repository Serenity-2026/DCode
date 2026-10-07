import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { builtinModules } from 'node:module'
import ts from 'typescript'
import { expect, it } from 'vitest'

const root = resolve('src')

/** 遍历正式源码，包括声明文件；使用 TypeScript AST 而非文件名或文本匹配判断依赖。 */
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? sources(path) : /\.tsx?$/.test(path) ? [path] : []
  })
}

/** 收集静态 import/export、import type、动态 import 及 require，避免绕过分层检查。 */
function imports(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true)
  const result: string[] = []
  function visit(node: ts.Node): void {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) result.push(node.moduleSpecifier.text)
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require')) && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) result.push(node.arguments[0].text)
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) result.push(node.argument.literal.text)
    ts.forEachChild(node, visit)
  }
  visit(file)
  return result
}

/** 按项目相对导入解析实际文件，同时允许正式 SVG/CSS 资产。 */
function target(path: string, module: string): string | undefined {
  const base = resolve(dirname(path), module)
  return [base, `${base}.ts`, `${base}.tsx`, `${base}.d.ts`, join(base, 'index.ts'), join(base, 'index.tsx')].find(candidate => existsSync(candidate))
}

const paths = sources(root)
const dependencies = new Map(paths.map(path => [path, imports(path)]))
const layers: Record<string, string[]> = {
  controllers: ['controllers', 'ipc', 'services', 'domain'],
  services: ['services', 'repositories', 'infrastructure', 'domain'],
  repositories: ['repositories', 'domain'],
  infrastructure: ['infrastructure', 'domain'],
  domain: ['domain'],
  ipc: ['ipc', 'domain'],
  windows: ['windows', 'services', 'domain'],
  app: ['app', 'controllers', 'ipc', 'services', 'repositories', 'infrastructure', 'domain', 'windows']
}

/** 按运行环境限制系统包；Service 只使用纯加密能力，文件、网络和 Electron 操作留在适配层。 */
function allowsPackage(from: string, module: string): boolean {
  const node = module.startsWith('node:') || builtinModules.includes(module)
  if (from.startsWith('renderer/')) return module !== 'electron' && !node
  if (from.startsWith('shared/') || from.startsWith('main/domain/')) return false
  if (from.startsWith('main/controllers/')) return false
  if (from.startsWith('main/services/')) return module === 'node:crypto'
  if (from.startsWith('main/repositories/')) return ['node:fs', 'node:path'].includes(module)
  return true
}

it('enforces process and layer boundaries for every source import', () => {
  const violations: string[] = []
  for (const [path, modules] of dependencies) for (const module of modules) {
    const from = relative(root, path)
    if (!module.startsWith('.')) {
      if (!allowsPackage(from, module)) violations.push(`${from} -> ${module}`)
      continue
    }
    const resolved = target(path, module)
    if (!resolved) { violations.push(`${from}: unresolved ${module}`); continue }
    const to = relative(root, resolved)
    if (from.startsWith('renderer/') && !to.startsWith('renderer/') && !to.startsWith('shared/') && !to.endsWith('.svg') && !to.endsWith('.css')) violations.push(`${from} -> ${to}`)
    if (from.startsWith('preload/') && !to.startsWith('preload/') && !to.startsWith('shared/')) violations.push(`${from} -> ${to}`)
    if (from.startsWith('shared/') && !to.startsWith('shared/')) violations.push(`${from} -> ${to}`)
    if (from.startsWith('renderer/src/components/') && to.startsWith('renderer/src/features/')) violations.push(`${from} -> ${to}`)
    if (from === 'main/index.ts' && !to.startsWith('main/app/')) violations.push(`${from} -> ${to}`)
    if (from.startsWith('main/')) {
      const layer = from.split('/')[1]
      if (layers[layer] && !to.startsWith('shared/') && !(to.startsWith('main/') && layers[layer].includes(to.split('/')[1]))) violations.push(`${from} -> ${to}`)
    }
  }
  expect(violations).toEqual([])
})

it('has no circular source dependencies, including type-only imports', () => {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const cycles: string[] = []
  function visit(path: string, chain: string[]): void {
    if (visiting.has(path)) { cycles.push([...chain, path].map(item => relative(root, item)).join(' -> ')); return }
    if (visited.has(path)) return
    visiting.add(path)
    for (const module of dependencies.get(path) || []) {
      const next = module.startsWith('.') ? target(path, module) : undefined
      if (next && dependencies.has(next)) visit(next, [...chain, path])
    }
    visiting.delete(path)
    visited.add(path)
  }
  for (const path of paths) visit(path, [])
  expect(cycles).toEqual([])
})

it('keeps the Agent runtime and loop independent of application sessions and storage', () => {
  const boundaries: Record<string, string[]> = {
    'main/services/agent-loop.ts': ['main/domain/'],
    'main/services/agent.ts': ['main/domain/', 'main/services/agent-loop.ts', 'main/infrastructure/tool-schema.ts'],
    'main/services/agent-session.ts': ['shared/', 'main/domain/', 'main/services/agent.ts', 'main/services/state-service.ts']
  }
  const violations: string[] = []
  for (const [source, allowed] of Object.entries(boundaries)) {
    const path = join(root, source)
    for (const module of dependencies.get(path) || []) {
      const destination = module.startsWith('.') ? target(path, module) : undefined
      if (!destination || !allowed.some(prefix => relative(root, destination).startsWith(prefix))) violations.push(`${source} -> ${module}`)
    }
  }
  expect(violations).toEqual([])
})
