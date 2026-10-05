import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { buildRemoteSendArgs, isAuthorizedSend, remoteSendOptions, shouldSendRemotely } from './remote-send.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-remote-send-'))

describe('remote send arguments', () => {
  test('values are passed as --flag=value so they can never become flags', () => {
    expect(buildRemoteSendArgs({ options: { prompt: '-rf / --wait', user: '--agent=x' } }, tmp())).toEqual([
      'send', '--prompt=-rf / --wait', '--user=--agent=x',
    ])
  })

  test('false and missing booleans are dropped; true becomes a bare flag', () => {
    expect(buildRemoteSendArgs({ options: { prompt: 'p', wait: true, notifyOnly: false } }, tmp())).toEqual([
      'send', '--prompt=p', '--wait',
    ])
  })

  test('options outside the allowlist are refused', () => {
    for (const key of ['preRun', 'appId', 'file', 'worktree', 'dataDir']) {
      expect(() => buildRemoteSendArgs({ options: { [key]: 'x' } }, tmp())).toThrow(/not allowed/)
    }
  })

  test('types are enforced', () => {
    expect(() => buildRemoteSendArgs({ options: { wait: 'yes' } }, tmp())).toThrow(/boolean/)
    expect(() => buildRemoteSendArgs({ options: { permission: 'bash:deny' } }, tmp())).toThrow(/list/)
    expect(() => buildRemoteSendArgs({ options: { prompt: 'a\0b' } }, tmp())).toThrow(/string/)
    expect(() => buildRemoteSendArgs([], tmp())).toThrow(/options/)
  })

  test('file names never escape the upload directory', () => {
    const dir = tmp()
    const args = buildRemoteSendArgs({
      options: { prompt: 'p' },
      files: [{ name: '../../etc/passwd', contentBase64: Buffer.from('x').toString('base64') }],
    }, dir)
    const file = args.at(-1)!.slice('--file='.length)
    expect(path.dirname(file)).toBe(dir)
    expect(fs.readFileSync(file, 'utf8')).toBe('x')
  })
})

describe('remote send client', () => {
  test('auth needs the exact bearer token', () => {
    expect(isAuthorizedSend('Bearer abc', 'abc')).toBe(true)
    expect(isAuthorizedSend('Bearer abcd', 'abc')).toBe(false)
    expect(isAuthorizedSend('abc', 'abc')).toBe(false)
    expect(isAuthorizedSend('Bearer abc', undefined)).toBe(false)
  })

  test('only goes remote with a token and no usable database file', () => {
    const dir = tmp()
    expect(shouldSendRemotely({ dataDir: dir, token: undefined })).toBe(false)
    expect(shouldSendRemotely({ dataDir: dir, token: 't' })).toBe(true)
    fs.writeFileSync(path.join(dir, 'discord-sessions.db'), '')
    expect(shouldSendRemotely({ dataDir: dir, token: 't' })).toBe(false)
  })

  test('explicit paths become absolute without deriving a destination from caller cwd', () => {
    expect(remoteSendOptions({ prompt: 'p', cwd: 'sub', preRun: 'x' }, '/work')).toEqual({
      prompt: 'p', cwd: '/work/sub',
    })
    expect(remoteSendOptions({ prompt: 'p' }, '/unrelated/repo')).toEqual({ prompt: 'p' })
    expect(remoteSendOptions({ prompt: 'p', thread: '1' }, '/work')).toEqual({ prompt: 'p', thread: '1' })
  })
})
