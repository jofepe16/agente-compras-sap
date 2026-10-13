import { readFile } from "node:fs/promises"
import path from "node:path"
import type { ToolContext } from "../domain/types.js"
import type { ChatMessage, LlmAdapter, ToolCall, ToolDefinition } from "../llm/adapter.js"
import { tools } from "../tools/oc.js"

type VisibleToolCall = { name: string; arguments: Record<string, unknown>; result: unknown }
type ToolObject = { description: string; execute(args: never, ctx: ToolContext): Promise<string> }

const definitions: ToolDefinition[] = [
  { type: "function", function: { name: "oc_leer_paquete", description: tools.oc_leer_paquete.description, parameters: { type: "object", properties: { caso: { type: "string", pattern: "^sol-00[1-6]$" } }, required: ["caso"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_validar", description: tools.oc_validar.description, parameters: { type: "object", properties: { caso: { type: "string" }, paquete: { type: "object" } }, required: ["caso", "paquete"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_generar_evidencia", description: tools.oc_generar_evidencia.description, parameters: { type: "object", properties: { caso: { type: "string" } }, required: ["caso"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_construir_payload", description: tools.oc_construir_payload.description, parameters: { type: "object", properties: { caso: { type: "string" }, paquete: { type: "object" }, derivados: { type: "object" } }, required: ["caso", "paquete", "derivados"], additionalProperties: false } } },
  { type: "function", function: { name: "oc_crear", description: tools.oc_crear.description, parameters: { type: "object", properties: { caso: { type: "string" }, payload: { type: "object" }, confirmado: { type: "boolean" }, confirmado_por: { type: "string" } }, required: ["caso", "payload"], additionalProperties: false } } },
]

export class AgentRunner {
  private readonly sessions = new Map<string, ChatMessage[]>()
  private readonly sessionTokens = new Map<string, number>()
  constructor(private readonly directory: string, private readonly llm: LlmAdapter, private readonly maxIterations = 12, private readonly maxTokens = 20_000) {}

  async run(sessionId: string, userMessage: string): Promise<{ reply: string; toolCalls: VisibleToolCall[]; needsConfirmation: boolean }> {
    let history = this.sessions.get(sessionId)
    if (!history) {
      const [prompt, knowledge] = await Promise.all([readFile(path.join(this.directory, "agent/prompt.md"), "utf8"), readFile(path.join(this.directory, "src/knowledge/ordenes-compra.md"), "utf8")])
      history = [{ role: "system", content: `${prompt}\n\n${knowledge}` }]
    }
    history.push({ role: "user", content: userMessage })
    const visible: VisibleToolCall[] = []
    let continuationRequested = false
    for (let iteration = 0; iteration < this.maxIterations; iteration += 1) {
      const response = await this.llm.send(history, definitions)
      const tokens = (this.sessionTokens.get(sessionId) ?? 0) + response.usageTokens
      this.sessionTokens.set(sessionId, tokens)
      if (tokens > this.maxTokens) {
        const reply = "La sesión alcanzó su límite de uso. Conservé el historial y no ejecutaré más acciones. Inicia una sesión nueva si necesitas continuar."
        history.push({ role: "assistant", content: reply })
        this.sessions.set(sessionId, history)
        return { reply, toolCalls: visible, needsConfirmation: false }
      }
      history.push(response.toolCalls.length
        ? { role: "assistant", content: response.content ?? "", tool_calls: response.toolCalls }
        : { role: "assistant", content: response.content ?? "" })
      if (!response.toolCalls.length) {
        const confirmed = /\b(confirmo|confirmado|autorizo|proceda|procede)\b/i.test(userMessage)
        const payloadReady = visible.some((call) => call.name === "oc_construir_payload")
        const orderCreated = visible.some((call) => call.name === "oc_crear")
        if (confirmed && payloadReady && !orderCreated && !continuationRequested) {
          history.push({ role: "user", content: "La confirmación explícita ya fue recibida. No respondas todavía: llama ahora a oc_crear con confirmado=true usando el payload disponible." })
          continuationRequested = true
          continue
        }
        const reply = response.content?.trim() || "No fue posible completar la respuesta."
        this.sessions.set(sessionId, history)
        return { reply, toolCalls: visible, needsConfirmation: /confirm/i.test(reply) && /\?/u.test(reply) }
      }
      for (const call of response.toolCalls) {
        const result = await this.execute(call, { directory: this.directory, sessionId }); visible.push(result.visible)
        history.push({ role: "tool", tool_call_id: call.id, content: result.raw })
      }
    }
    const reply = "Alcancé el límite de pasos de este turno. Las acciones visibles quedaron registradas, pero el proceso no terminó; revisa los resultados antes de continuar."
    history.push({ role: "assistant", content: reply })
    this.sessions.set(sessionId, history)
    return { reply, toolCalls: visible, needsConfirmation: false }
  }

  getSession(sessionId: string): ChatMessage[] { return (this.sessions.get(sessionId) ?? []).filter((message) => message.role !== "system") }

  private async execute(call: ToolCall, ctx: ToolContext): Promise<{ raw: string; visible: VisibleToolCall }> {
    const tool = (tools as Record<string, ToolObject>)[call.function.name]
    if (!tool) throw new Error(`Herramienta desconocida: ${call.function.name}`)
    let args: Record<string, unknown>; try { args = JSON.parse(call.function.arguments) as Record<string, unknown> } catch { args = {} }
    const raw = await tool.execute(args as never, ctx); let result: unknown
    try { result = JSON.parse(raw) } catch { result = raw }
    return { raw, visible: { name: call.function.name, arguments: args, result } }
  }
}
