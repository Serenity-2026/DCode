import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolExecutionError } from '../../domain/llm'
import { maxOutputBytes, truncateOutput, utf8Tail } from './output'

/** 执行真实 bash，流式写入完整日志，内存只保留有界尾部；日志目录由工具实例管理。 */
export async function runBash(command: string, cwd: string, timeout: number | undefined, signal: AbortSignal, logs: Set<string>): Promise<string> {
  signal.throwIfAborted()
  const directory = await mkdtemp(join(tmpdir(), 'dcode-bash-'))
  logs.add(directory)
  const path = join(directory, 'output.log')
  let keepLog = false
  try {
    signal.throwIfAborted()
    const log = createWriteStream(path, { mode: 0o600 })
    let tail: Buffer = Buffer.alloc(0)
    let totalBytes = 0
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const child = spawn('bash', ['-c', command], { cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

    /** POSIX 终止整个进程组；Windows 通过 taskkill 终止进程树。 */
    const kill = (): void => {
      if (!child.pid) return
      if (process.platform === 'win32') {
        const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
        killer.on('error', () => { child.kill('SIGKILL') })
      } else {
        try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL') }
      }
    }

    const capture = (chunk: Buffer): void => {
      if (failure) return
      totalBytes += chunk.length
      tail = utf8Tail(Buffer.concat([tail, chunk]), maxOutputBytes * 2)
      if (!log.write(chunk)) { child.stdout.pause(); child.stderr.pause() }
    }
    log.on('drain', () => { child.stdout.resume(); child.stderr.resume() })
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    signal.addEventListener('abort', kill, { once: true })
    if (signal.aborted) kill()
    if (timeout !== undefined) timer = setTimeout(() => { timedOut = true; kill() }, timeout * 1000)
    // 工具不支持后台任务：shell 退出时清理仍持有管道的子进程。
    child.once('exit', () => { if (process.platform !== 'win32') kill() })

    let failure: Error | undefined
    const logClosed = new Promise<void>(resolve => {
      log.on('error', error => { failure = error; kill(); child.stdout.resume(); child.stderr.resume() })
      log.once('close', resolve)
    })
    const closed = new Promise<number | null>(resolve => {
      child.on('error', error => { failure = error })
      child.once('close', code => resolve(code))
    })
    let code: number | null
    try {
      code = await closed
      log.end()
      await logClosed
    } finally {
      if (timer) clearTimeout(timer)
      signal.removeEventListener('abort', kill)
    }
    signal.throwIfAborted()
    if (failure) throw new ToolExecutionError(`无法执行 bash 或保存命令输出（${(failure as NodeJS.ErrnoException).code || 'I/O'}）。请确认 bash 可用及目录可访问。`)
    const output = truncateOutput(tail.toString('utf8'), true)
    keepLog = output.truncated || totalBytes > tail.length
    const text = (output.content || '(无输出)') + (keepLog ? `\n\n[输出已截断，完整输出：${path}]` : '')
    if (timedOut) throw new ToolExecutionError(`${text}\n\n命令超时（${timeout} 秒）。`)
    if (code !== 0) throw new ToolExecutionError(`${text}\n\n命令退出码：${code ?? '无退出码'}。`)
    return text
  } finally {
    if (!keepLog) { await rm(directory, { recursive: true, force: true }); logs.delete(directory) }
  }
}
