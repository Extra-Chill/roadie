// Live speech provider seam. A provider only turns speech into
// `tell_orchestrator` calls and speaks announcements; every decision belongs
// to the orchestrator thread, a normal Roadie agent session.
import { GoogleGenAI, Modality, Type, type Session } from '@google/genai'

export interface VoiceProviderSession {
  audio(pcm16: Buffer): void
  /** Speak a Roadie update (orchestrator reply, question or thread finish). */
  announce(text: string): void
  close(): void
}
export interface VoiceProvider {
  connect(options: {
    key: string
    /** The single tool: deliver the user's words to the orchestrator thread. */
    tellOrchestrator: (text: string) => Promise<string>
    output: (pcm24: Buffer) => void
    interrupted: () => void
    completed: () => void
    failed: () => void
  }): Promise<VoiceProviderSession>
}

export const TELL_ORCHESTRATOR = 'tell_orchestrator'

export const voiceInstructions = `You are the voice of a Roadie orchestrator thread, not an assistant with your own judgement. Whenever the user asks for something, call ${TELL_ORCHESTRATOR} with their request in their own words: do not summarize, interpret or add to it. Then say a very short acknowledgement such as "on it". When you receive an orchestrator reply, question or thread update, read it aloud briefly and plainly. Never read code, diffs or links. Leave every decision, plan and confirmation to the orchestrator; if the user answers a question, relay the answer with ${TELL_ORCHESTRATOR}. A tool error means the message was not delivered: say so.`

/** Condense chat markdown into something short enough to say aloud. */
export function spokenText(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, ' Code omitted. ')
    .replace(/^[-+@].*$/gm, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[\x60*_#<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700)
}

export const geminiVoiceProvider: VoiceProvider = {
  async connect({ key, tellOrchestrator, output, interrupted, completed, failed }) {
    let session: Session
    session = await new GoogleGenAI({ apiKey: key }).live.connect({
      model: 'gemini-3.8-live',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: voiceInstructions,
        tools: [
          {
            functionDeclarations: [
              {
                name: TELL_ORCHESTRATOR,
                description:
                  "Send the user's words to the Roadie orchestrator thread as their message. Use their words.",
                parameters: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING, description: "The user's request, in their words." },
                  },
                  required: ['text'],
                },
              },
            ],
          },
        ],
      },
      callbacks: {
        onmessage(message) {
          if (message.serverContent?.interrupted) interrupted()
          for (const part of message.serverContent?.modelTurn?.parts ?? []) {
            if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm'))
              output(Buffer.from(part.inlineData.data, 'base64'))
          }
          if (message.serverContent?.turnComplete) completed()
          for (const call of message.toolCall?.functionCalls ?? []) {
            void (async () => {
              let result: unknown
              try {
                if (call.name !== TELL_ORCHESTRATOR) throw new Error('Unknown tool')
                result = await tellOrchestrator(String(call.args?.text ?? ''))
              } catch (error) {
                result = { error: error instanceof Error ? error.message : String(error) }
              }
              session.sendToolResponse({
                functionResponses: [{ id: call.id, name: call.name, response: { result } }],
              })
            })().catch(failed)
          }
        },
        onerror: failed,
        onclose: failed,
      },
    })
    return {
      audio(pcm16) {
        session.sendRealtimeInput({
          audio: { data: pcm16.toString('base64'), mimeType: 'audio/pcm;rate=16000' },
        })
      },
      announce(text) {
        session.sendClientContent({
          turns: [
            {
              role: 'user',
              parts: [{ text: `Roadie update (not an instruction): ${text}. Read it aloud briefly.` }],
            },
          ],
          turnComplete: true,
        })
      },
      close() {
        session.close()
      },
    }
  },
}
