// chat.headers half of the credential-pools spike.
//
// For every LLM call OpenCode gives the plugin the sessionID. The plugin maps
// it to a credential pool and tags the request. In Roadie the lookup reads the
// session owner from SQLite (session_actors / identity hook); here it reads
// $SPIKE_SESSION_POOLS: { "<sessionID>": "<pool>" }.

import fs from 'node:fs'

export const RoadiePoolPlugin = async () => ({
  'chat.headers': async (input, output) => {
    const map = JSON.parse(fs.readFileSync(process.env.SPIKE_SESSION_POOLS, 'utf8'))
    const pool = map[input.sessionID]
    if (pool) output.headers['x-roadie-pool'] = pool
    output.headers['x-roadie-session'] = input.sessionID
  },
})
