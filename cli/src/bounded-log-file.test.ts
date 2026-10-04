import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createBoundedLogFile } from './bounded-log-file.js'

const dirs: string[] = []

function tempFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-bounded-log-'))
  dirs.push(dir)
  return path.join(dir, 'nested', 'server.log')
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('createBoundedLogFile', () => {
  test('appends lines and creates the directory', () => {
    const filePath = tempFile()
    const log = createBoundedLogFile({ filePath, maxBytes: 1024 })
    log.append('one')
    log.append('two\n')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('one\ntwo\n')
  })

  test('rotates to .1 once the cap is passed, keeping two files at most', () => {
    const filePath = tempFile()
    const log = createBoundedLogFile({ filePath, maxBytes: 10 })
    log.append('aaaa')
    log.append('bbbb')
    log.append('cccc')
    log.append('dddd')
    log.append('eeee')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('eeee\n')
    expect(fs.readFileSync(`${filePath}.1`, 'utf8')).toBe('cccc\ndddd\n')
    expect(fs.readdirSync(path.dirname(filePath)).sort()).toEqual(['server.log', 'server.log.1'])
  })

  test('counts an existing file toward the cap', () => {
    const filePath = tempFile()
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, '123456789\n')
    createBoundedLogFile({ filePath, maxBytes: 12 }).append('next')
    expect(fs.readFileSync(`${filePath}.1`, 'utf8')).toBe('123456789\n')
    expect(fs.readFileSync(filePath, 'utf8')).toBe('next\n')
  })
})
