// Built-in chat platforms. Discord and Slack go through the same registry a
// plugin platform uses; the CLI entry point holds no platform switch. The
// adapters are imported lazily so a Slack-only (or plugin-only) bot never
// loads discord.js, and vice versa.

import { getChatPlatform, registerChatPlatform } from './registry.js'

export function registerBuiltinChatPlatforms(): void {
  if (!getChatPlatform('discord')) {
    const failed = registerChatPlatform(
      {
        id: 'discord',
        start: async (context) => {
          const { startDiscordPlatform } = await import('../cli-runner.js')
          return startDiscordPlatform(context)
        },
      },
      { source: 'roadie' },
    )
    if (failed instanceof Error) throw failed
  }
  if (!getChatPlatform('slack')) {
    const failed = registerChatPlatform(
      {
        id: 'slack',
        start: async () => {
          const { startNativeSlackPlatform } = await import('../slack-bot.js')
          return startNativeSlackPlatform()
        },
      },
      { source: 'roadie' },
    )
    if (failed instanceof Error) throw failed
  }
}
