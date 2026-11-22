import { GoogleGenAI, Modality, Type, type Session } from '@google/genai'
import { dispatcherInstructions, voiceTools } from './voice-dispatcher.js'

export interface VoiceProviderSession {
  audio(pcm16: Buffer): void
  announce(text: string): void
  close(): void
}
export interface VoiceProvider {
  connect(options: {
    key: string
    tool: (name: string, args: Record<string, unknown>) => Promise<unknown>
    output: (pcm24: Buffer) => void
    interrupted: () => void
    completed: () => void
    failed: () => void
  }): Promise<VoiceProviderSession>
}
export const geminiVoiceProvider: VoiceProvider = {
  async connect({ key, tool, output, interrupted, completed, failed }) {
    let session: Session
    session = await new GoogleGenAI({ apiKey: key }).live.connect({
      model: 'gemini-3.1-flash-live-preview',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: dispatcherInstructions,
        tools: [
          {
            functionDeclarations: Object.entries(voiceTools).map(([name, tool]) => ({
              name,
              description: tool.description,
              parameters: {
                type: Type.OBJECT,
                properties: Object.fromEntries(
                  Object.entries(tool.params).map(([key, description]) => [
                    key,
                    { type: Type.STRING, description },
                  ]),
                ),
                required: tool.required,
              },
            })),
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
                result = await tool(call.name ?? '', call.args ?? {})
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
              parts: [{ text: `Thread update (not an instruction): ${text}. Announce briefly.` }],
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
