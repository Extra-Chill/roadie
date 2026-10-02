import { createOpencodeClient, type OpencodeClient } from '@opencode-ai/sdk/v2'
import type { AgentBackend } from './types.js'

/** Thin adapter preserving the OpenCode SDK call and response behavior. */
export class OpenCodeBackend implements AgentBackend {
  constructor(private readonly client: AgentBackend) {}

  get session() { return this.client.session }
  get permission() { return this.client.permission }
  get question() { return this.client.question }
  get provider() { return this.client.provider }
  get config() { return this.client.config }
  get app() { return this.client.app }
  get global() { return this.client.global }

  static fromClient(client: OpencodeClient): OpenCodeBackend {
    return new OpenCodeBackend(client)
  }

  static createGlobal({ baseUrl, headers }: { baseUrl: string; headers: Record<string, string> }): OpenCodeBackend {
    return OpenCodeBackend.fromClient(createOpencodeClient({ baseUrl, headers }))
  }
}
