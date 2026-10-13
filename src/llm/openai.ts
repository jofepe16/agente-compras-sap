import type { ChatMessage, LlmAdapter, ModelReply, ToolDefinition } from "./adapter.js"

export class OpenAiAdapter implements LlmAdapter {
  readonly provider = "openai"
  constructor(readonly model: string, private readonly apiKey: string) {}

  async send(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelReply> {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages, tools, tool_choice: "auto", reasoning_effort: "none", temperature: 0.1 }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => null) as { error?: { message?: string } } | null
      const detail = body?.error?.message ?? "No se recibió información adicional."
      throw new Error(`El proveedor respondió ${response.status}: ${detail}`)
    }
    const body = await response.json() as { choices?: Array<{ message: { content: string | null; tool_calls?: ModelReply["toolCalls"] } }>; usage?: { total_tokens?: number } }
    const message = body.choices?.[0]?.message
    if (!message) throw new Error("El proveedor no devolvió una respuesta utilizable.")
    return { content: message.content, toolCalls: message.tool_calls ?? [], usageTokens: body.usage?.total_tokens ?? 0 }
  }
}
