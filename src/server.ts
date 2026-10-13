import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { existsSync, readFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { AgentRunner } from "./agent/runner.js"
import { OpenAiAdapter } from "./llm/openai.js"
import { procesarCaso } from "./tools/oc.js"

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
loadEnv(path.join(directory, ".env"))

const port = Number(process.env.PORT ?? 3000)
const model = process.env.LLM_MODEL ?? "gpt-5.6-luna"
const apiKey = process.env.OPENAI_API_KEY
const agent = apiKey
  ? new AgentRunner(directory, new OpenAiAdapter(model, apiKey), Number(process.env.MAX_AGENT_ITERATIONS ?? 12), Number(process.env.MAX_SESSION_TOKENS ?? 100_000))
  : null

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
    if (request.method === "GET" && url.pathname === "/api/health") {
      return json(response, 200, { ok: true, provider: apiKey ? "openai" : "modo-demo", model: apiKey ? model : "reglas deterministas" })
    }

    const processMatch = request.method === "POST" && url.pathname.match(/^\/api\/cases\/(sol-00[1-6])\/process$/)
    if (processMatch) {
      const body = z.object({ confirmado: z.boolean().optional() }).safeParse(await readBody(request))
      if (!body.success) return json(response, 400, { ok: false, error: "Solicitud inválida." })
      const result = await procesarCaso(processMatch[1]!, { directory, sessionId: crypto.randomUUID() }, body.data.confirmado ?? false)
      return json(response, 200, { ok: true, data: result })
    }

    if (request.method === "POST" && url.pathname === "/api/chat") {
      const body = z.object({ sessionId: z.string().min(1), message: z.string().min(1).max(2_000) }).safeParse(await readBody(request))
      if (!body.success) return json(response, 400, { error: "Escribe un mensaje válido." })
      if (!agent) return json(response, 503, { error: "El chat no está configurado. Usa la bandeja o configura OPENAI_API_KEY." })
      return json(response, 200, await agent.run(body.data.sessionId, body.data.message))
    }

    const sessionMatch = request.method === "GET" && url.pathname.match(/^\/api\/sessions\/([^/]+)$/)
    if (sessionMatch) return json(response, 200, { sessionId: sessionMatch[1], messages: agent?.getSession(sessionMatch[1]!) ?? [] })
    if (url.pathname.startsWith("/api/")) return json(response, 404, { error: "Ruta no encontrada." })

    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1)
    const safeName = ["index.html", "styles.css", "app.js"].includes(requested) ? requested : "index.html"
    const content = await readFile(path.join(directory, "web", safeName))
    response.writeHead(200, { "content-type": contentType(safeName) })
    response.end(content)
  } catch (error) {
    console.error(error)
    json(response, 500, { error: error instanceof Error ? error.message : "Error interno." })
  }
})

server.listen(port, "0.0.0.0", () => console.log(`Mesa de Compras disponible en http://localhost:${port}`))

function loadEnv(file: string): void {
  if (!existsSync(file)) return
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.trim()
  }
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  let value = ""
  for await (const chunk of request) {
    value += chunk
    if (value.length > 1_000_000) throw new Error("Solicitud demasiado grande.")
  }
  return value ? JSON.parse(value) : {}
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  response.end(JSON.stringify(value))
}

function contentType(file: string): string {
  if (file.endsWith(".css")) return "text/css; charset=utf-8"
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8"
  return "text/html; charset=utf-8"
}
