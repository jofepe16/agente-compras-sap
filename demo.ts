import { rm } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import type { OrdenCompra, Paquete, ResultadoValidacion, ToolResponse } from "./src/domain/types.js"
import { tools } from "./src/tools/oc.js"

const directory = path.dirname(fileURLToPath(import.meta.url))
const ctx = { directory, sessionId: "demo" }
await rm(path.join(directory, "out"), { recursive: true, force: true })

function parse<T>(raw: string): ToolResponse<T> { return JSON.parse(raw) as ToolResponse<T> }

async function run(caso: string, confirmado = false) {
  const lectura = parse<Paquete>(await tools.oc_leer_paquete.execute({ caso }, ctx))
  if (!lectura.ok) return { caso, error: lectura.error }

  const validacionResult = parse<ResultadoValidacion>(await tools.oc_validar.execute({ caso, paquete: lectura.data }, ctx))
  if (!validacionResult.ok) return { caso, error: validacionResult.error }
  const validacion = validacionResult.data
  if (!validacion.apta) return { caso, validacion, motivo: validacion.bloqueos.map((item) => item.detalle).join("; ") }

  const evidencia = parse<{ ruta: string; sha256: string }>(await tools.oc_generar_evidencia.execute({ caso }, ctx))
  if (!evidencia.ok) return { caso, validacion, error: evidencia.error }
  const payloadResult = parse<{ payload: OrdenCompra }>(await tools.oc_construir_payload.execute({ caso, paquete: lectura.data, derivados: validacion.derivados }, ctx))
  if (!payloadResult.ok) return { caso, validacion, error: payloadResult.error }
  const creacion = parse<{ numero_oc: string; fecha: string; idempotente: boolean }>(await tools.oc_crear.execute({ caso, payload: payloadResult.data.payload, confirmado, confirmado_por: confirmado ? "demo" : undefined }, ctx))
  return { caso, validacion, creacion, motivo: creacion.ok ? undefined : creacion.error }
}

console.log("Mesa de Compras · verificación determinista\n")
for (let index = 1; index <= 6; index += 1) {
  const caso = `sol-${String(index).padStart(3, "0")}`
  const result = await run(caso, caso === "sol-004")
  if (!("validacion" in result) || !result.validacion) { console.log(`${caso} · ERROR\n  ${result.error}\n`); continue }
  const estado = result.validacion.bloqueos.length ? "BLOQUEADA" : result.creacion?.ok ? "CREADA" : "PENDIENTE"
  console.log(`${caso} · ${estado}`)
  console.log(`  apta: ${result.validacion.apta} · retroactiva: ${result.validacion.retroactiva}`)
  console.log(`  bloqueos: ${result.validacion.bloqueos.map((item) => item.codigo).join(", ") || "ninguno"}`)
  console.log(`  confirmaciones: ${result.validacion.confirmaciones.map((item) => item.codigo).join(", ") || "ninguna"}`)
  console.log(`  resultado: ${result.creacion?.ok ? `OC ${result.creacion.data.numero_oc}` : result.motivo}`)
  console.log()
}

console.log("Idempotencia · segunda ejecución de sol-001")
const repeated = await run("sol-001")
console.log(repeated.creacion?.ok ? `  OC: ${repeated.creacion.data.numero_oc} · idempotente: ${repeated.creacion.data.idempotente}` : `  ${repeated.motivo}`)
