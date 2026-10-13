export type ChatMessage = { role: "system" | "user" | "assistant" | "tool"; content: string; tool_call_id?: string; tool_calls?: ToolCall[] }
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } }
export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }
export type ModelReply = { content: string | null; toolCalls: ToolCall[]; usageTokens: number }

export interface LlmAdapter {
  readonly provider: string
  readonly model: string
  send(messages: ChatMessage[], tools: ToolDefinition[]): Promise<ModelReply>
}
