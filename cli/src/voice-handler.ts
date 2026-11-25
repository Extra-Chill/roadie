// Discord voice transport: joins the configured voice channel for an
// authorized speaker, pipes audio to the speech provider and back, and hands
// everything else to the orchestrator bridge (voice-bridge.ts).
import { PassThrough } from 'node:stream'
import { ChannelType, Events, type Client, type VoiceState } from 'discord.js'
import {
  AudioPlayerStatus,
  EndBehaviorType,
  StreamType,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  joinVoiceChannel,
} from '@discordjs/voice'
import prism from 'prism-media'
import { readRoadieSecret } from './config.js'
import { resolveChannelPolicy } from './channel-policy.js'
import { startVoiceBridge, voiceSpeakerAllowed, type VoiceBridge, type VoiceIntake } from './voice-bridge.js'
import { geminiVoiceProvider, type VoiceProvider } from './voice-provider.js'

/** 48k stereo signed PCM → 16k mono. Discord decoder frames are 20ms. */
export function voiceInput(frame: Buffer): Buffer {
  const output = Buffer.alloc(Math.floor(frame.length / 12) * 2)
  for (let i = 0; i < output.length / 2; i++)
    output.writeInt16LE(
      Math.round((frame.readInt16LE(i * 12) + frame.readInt16LE(i * 12 + 2)) / 2),
      i * 2,
    )
  return output
}
/** Gemini 24k mono → Discord 48k stereo PCM. */
export function voiceOutput(frame: Buffer): Buffer {
  const output = Buffer.alloc(Math.floor(frame.length / 2) * 8)
  for (let i = 0; i < Math.floor(frame.length / 2); i++)
    for (let j = 0; j < 4; j++) output.writeInt16LE(frame.readInt16LE(i * 2), i * 8 + j * 2)
  return output
}

/**
 * Join an authorized speaker's voice channel when its policy names an
 * orchestrator text channel (`voice: { channel }`), and leave with them.
 */
export function installVoiceBridge(
  client: Client,
  intake: VoiceIntake,
  provider: VoiceProvider = geminiVoiceProvider,
): () => void {
  const sessions = new Map<string, { userId: string; channelId: string; close: () => void }>()
  const pending = new Set<string>()
  let disposed = false
  const update = async (_old: VoiceState, state: VoiceState) => {
    const active = sessions.get(state.guild.id)
    if (active?.userId === state.id && state.channelId !== active.channelId) active.close()
    if (
      disposed ||
      active ||
      pending.has(state.guild.id) ||
      !state.channel ||
      state.channel.type !== ChannelType.GuildVoice ||
      !state.member ||
      !resolveChannelPolicy(state.channel.id)?.voice?.channel
    )
      return
    pending.add(state.guild.id)
    let cleanup: (() => void) | undefined
    try {
      if (!(await voiceSpeakerAllowed(state.member, state.channel.id))) return
      const key = readRoadieSecret('ROADIE_GEMINI_API_KEY')
      if (!key) {
        await state.member
          .send(
            'Roadie cannot join voice: configure ROADIE_GEMINI_API_KEY or ROADIE_GEMINI_API_KEY_FILE.',
          )
          .catch(() => {})
        return
      }
      const channelId = state.channel.id
      const connection = joinVoiceChannel({
        channelId,
        guildId: state.guild.id,
        adapterCreator: state.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      })
      const player = createAudioPlayer()
      connection.subscribe(player)
      let bridge: VoiceBridge | undefined
      let audio: PassThrough | undefined
      const streams = new Set<{ destroy(): unknown }>()
      let closed = false
      const close = () => {
        if (closed) return
        closed = true
        for (const stream of streams) stream.destroy()
        streams.clear()
        audio?.destroy()
        player.stop(true)
        bridge?.close()
        connection.destroy()
        sessions.delete(state.guild.id)
      }
      cleanup = close
      sessions.set(state.guild.id, { userId: state.id, channelId, close })
      player.on('error', close)
      connection.on('error', close)
      connection.on(VoiceConnectionStatus.Disconnected, close)
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000)
      bridge = await startVoiceBridge({
        client,
        member: state.member,
        voiceChannelId: channelId,
        intake,
        provider,
        key,
        audio: {
          output(frame) {
            if (closed) return
            if (
              !audio ||
              audio.destroyed ||
              audio.writableEnded ||
              player.state.status === AudioPlayerStatus.Idle
            ) {
              audio?.destroy()
              audio = new PassThrough()
              player.play(createAudioResource(audio, { inputType: StreamType.Raw }))
            }
            // Bound playback buffering rather than retaining unbounded model audio.
            if (audio.writableLength > 48_000 * 4 * 10) {
              close()
              return
            }
            audio.write(voiceOutput(frame))
          },
          completed() {
            audio?.end()
          },
          interrupted() {
            audio?.destroy()
            audio = undefined
            player.stop(true)
          },
          failed: close,
        },
      })
      if (!bridge || closed || disposed || state.member.voice.channelId !== channelId) {
        bridge?.close()
        close()
        return
      }
      const live = bridge.live
      connection.receiver.speaking.on('start', (userId) => {
        if (closed || userId !== state.id) return
        void (async () => {
          if (!(await voiceSpeakerAllowed(state.member!, channelId)) || closed) return
          const input = connection.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 350 },
          })
          const decoder = new prism.opus.Decoder({ rate: 48000, channels: 2, frameSize: 960 })
          streams.add(input)
          streams.add(decoder)
          input.on('error', close)
          decoder.on('error', close)
          decoder.on('data', (frame: Buffer) => {
            if (!closed) live.audio(voiceInput(frame))
          })
          input.on('end', () => {
            streams.delete(input)
            streams.delete(decoder)
            decoder.destroy()
          })
          input.pipe(decoder)
        })().catch(close)
      })
    } catch (error) {
      cleanup?.()
      console.error(
        'Roadie voice session failed:',
        error instanceof Error ? error.message : String(error),
      )
    } finally {
      pending.delete(state.guild.id)
    }
  }
  const onState = (old: VoiceState, state: VoiceState) => {
    void update(old, state)
  }
  client.on(Events.VoiceStateUpdate, onState)
  const disconnected = () => {
    for (const session of sessions.values()) session.close()
  }
  client.on(Events.ShardDisconnect, disconnected)
  return () => {
    disposed = true
    client.removeListener(Events.VoiceStateUpdate, onState)
    client.removeListener(Events.ShardDisconnect, disconnected)
    for (const session of sessions.values()) session.close()
  }
}
