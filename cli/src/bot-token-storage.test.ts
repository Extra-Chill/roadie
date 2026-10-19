// An environment-supplied bot token stays in memory (#316): the database
// keeps the app's identity, never the token.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { closeDb } from './db.js'
import { getBotToken, registerEnvironmentBot, setBotToken } from './database.js'
import { resolveCredentials } from './cli-runner.js'

const APP_ID = '123456789012345678'
const ENV_TOKEN = `${Buffer.from(APP_ID).toString('base64')}.env-token-fixture.hmac-env-secret`
const SAVED_TOKEN = `${Buffer.from(APP_ID).toString('base64')}.saved-token-fixture.hmac-saved-secret`

let dir: string
let dbPath: string
let previousDbUrl: string | undefined
let previousBotToken: string | undefined

function databaseBytes(): string {
  return [dbPath, `${dbPath}-wal`]
    .filter((file) => fs.existsSync(file))
    .map((file) => fs.readFileSync(file).toString('latin1'))
    .join('')
}

describe('environment bot token storage', () => {
  beforeEach(async () => {
    await closeDb()
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roadie-bot-token-'))
    dbPath = path.join(dir, 'discord-sessions.db')
    previousDbUrl = process.env['ROADIE_DB_URL']
    previousBotToken = process.env['ROADIE_BOT_TOKEN']
    process.env['ROADIE_DB_URL'] = `file:${dbPath}`
    delete process.env['ROADIE_BOT_TOKEN']
  })

  afterEach(async () => {
    await closeDb()
    if (previousDbUrl === undefined) delete process.env['ROADIE_DB_URL']
    else process.env['ROADIE_DB_URL'] = previousDbUrl
    if (previousBotToken === undefined) delete process.env['ROADIE_BOT_TOKEN']
    else process.env['ROADIE_BOT_TOKEN'] = previousBotToken
    fs.rmSync(dir, { recursive: true, force: true })
  })

  test('startup with ROADIE_BOT_TOKEN writes no token to the database files', async () => {
    process.env['ROADIE_BOT_TOKEN'] = ENV_TOKEN
    const credentials = await resolveCredentials({ forceRestartOnboarding: false })
    expect(credentials).toMatchObject({ appId: APP_ID, token: ENV_TOKEN, credentialSource: 'env' })

    // Subcommands in the same environment still get the token.
    expect(await getBotToken()).toMatchObject({ appId: APP_ID, token: ENV_TOKEN })

    // Read the files while the database is open, as a snapshot of a running
    // host would see them.
    const bytes = databaseBytes()
    expect(bytes).toContain(APP_ID)
    expect(bytes).not.toContain('hmac-env-secret')
  })

  test('startup with ROADIE_BOT_TOKEN clears a token saved earlier for the app', async () => {
    await setBotToken(APP_ID, SAVED_TOKEN)
    expect(await getBotToken()).toMatchObject({ token: SAVED_TOKEN })

    process.env['ROADIE_BOT_TOKEN'] = ENV_TOKEN
    await resolveCredentials({ forceRestartOnboarding: false })

    const bytes = databaseBytes()
    expect(bytes).not.toContain('hmac-saved-secret')
    expect(bytes).not.toContain('hmac-env-secret')
  })

  test('without the environment token an environment-registered bot is not configured', async () => {
    await registerEnvironmentBot(APP_ID)
    expect(await getBotToken()).toBeUndefined()

    // A token for a different app does not stand in for this one.
    process.env['ROADIE_BOT_TOKEN'] = `${Buffer.from('876543210987654321').toString('base64')}.other.hmac`
    expect(await getBotToken()).toBeUndefined()
  })

  test('a saved token keeps being stored and returned', async () => {
    await setBotToken(APP_ID, SAVED_TOKEN)
    expect(await getBotToken()).toMatchObject({ appId: APP_ID, token: SAVED_TOKEN })
  })
})
