import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { ordenCompraSchema } from "../domain/types.js"
import type { Currency, Derivados, Hallazgo, OrdenCompra, Paquete, ResultadoValidacion, Solicitud, ToolContext, ToolResponse } from "../domain/types.js"
import { appendCsv, appendJsonLine, isoNow, normalizeNit, normalizeText, readJson, writeJson } from "../lib/files.js"
import { SapMockAdapter } from "../sap/mock.js"

type CorreoFixture = { id: string; de: string; para?: string; asunto: string; fecha: string }
type AprobacionFixture = { de: string; fecha: string; asunto: string; cuerpo: string; para?: string }
type Proveedor = { codigo_sap: string; nit: string; nombre: string; condiciones_pago_default: string; indicador_iva_default: string; activo: boolean }
type CentroCosto = { centro_costo: string; nombre: string; subareas: string[]; aprobadores: Array<{ email: string; nombre: string; tope: number }> }

const casoSchema = z.string().regex(/^sol-00[1-6]$/, "Caso inválido. Use sol-001 a sol-006.")
const paqueteSchema = z.custom<Paquete>((value) => Boolean(value && typeof value === "object"))
const derivadosSchema = z.custom<Derivados>((value) => Boolean(value && typeof value === "object"))

function ok<T>(data: T): string { return JSON.stringify({ ok: true, data } satisfies ToolResponse<T>) }
function fail(error: string): string { return JSON.stringify({ ok: false, error } satisfies ToolResponse<never>) }
function projectPath(ctx: ToolContext, ...segments: string[]): string { return path.join(ctx.directory, ...segments) }
function casePath(ctx: ToolContext, caso: string): string { return projectPath(ctx, "fixtures/reto-03/solicitudes", caso) }

async function log(ctx: ToolContext, herramienta: string, caso: string, exitoso: boolean, resumen: string): Promise<void> {
  await appendJsonLine(projectPath(ctx, "out/log.jsonl"), { ts: isoNow(), herramienta, caso, ok: exitoso, resumen, sessionId: ctx.sessionId })
}

function moneyFromLine(text: string, label: string): number | null {
  const match = text.match(new RegExp(`${label}[^\\n]*?(?:COP|USD)\\s*([\\d.,]+)`, "i"))
  return match ? Number(match[1]!.replace(/[.,]/g, "")) : null
}

function parseDatePlusDays(date: string, days: number): string {
  const result = new Date(`${date}T12:00:00Z`); result.setUTCDate(result.getUTCDate() + days); return result.toISOString().slice(0, 10)
}

function parseCotizacion(texto: string): Paquete["cotizacion"] {
  const referencia = texto.match(/COTIZACIÓN\s+([^\n]+)/i)?.[1]?.trim() ?? null
  const proveedor = texto.match(/Proveedor:\s*([^\n]+)/i)?.[1]?.trim() ?? ""
  const nitRaw = texto.match(/NIT:\s*([^\n]+)/i)?.[1]?.trim() ?? null
  const total = moneyFromLine(texto, "TOTAL[^:]*:")
  const fecha = texto.match(/Fecha:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]
  const dias = Number(texto.match(/Validez de la oferta:\s*(\d+)\s*días/i)?.[1] ?? 0)
  const moneda = texto.includes("USD") ? "USD" : "COP"
  if (!proveedor || total === null) return null
  return { referencia, proveedor, nit: nitRaw ? normalizeNit(nitRaw) : null, total, moneda, validez_hasta: fecha && dias ? parseDatePlusDays(fecha, dias) : null, texto }
}

function parseFactura(texto: string): NonNullable<Paquete["factura"]> | null {
  const numero = texto.match(/No\.\s*([^\n]+)/i)?.[1]?.trim()
  const fecha = texto.match(/Fecha de emisión:\s*(\d{4}-\d{2}-\d{2})/i)?.[1]
  const total = moneyFromLine(texto, "TOTAL:")
  return numero && fecha && total !== null ? { numero, fecha, total } : null
}

async function leerPaqueteImpl(caso: string, ctx: ToolContext): Promise<Paquete> {
  const base = casePath(ctx, caso)
  const correo = await readJson<CorreoFixture>(path.join(base, "correo.json"))
  const solicitud = await readJson<Solicitud>(path.join(base, "solicitud.json"))
  let cotizacion: Paquete["cotizacion"] = null
  let aprobacion: Paquete["aprobacion"] = null
  let factura: Paquete["factura"] = null
  const faltantes: string[] = []
  try { cotizacion = parseCotizacion(await readFile(path.join(base, "cotizacion.txt"), "utf8")) } catch { faltantes.push("cotización") }
  try {
    const item = await readJson<AprobacionFixture>(path.join(base, "aprobacion.json"))
    aprobacion = { de: item.de.toLowerCase(), fecha: item.fecha, aprobado: /\baprobado\b/i.test(item.cuerpo), texto: item.cuerpo }
  } catch { faltantes.push("aprobación") }
  try { factura = parseFactura(await readFile(path.join(base, "factura.txt"), "utf8")) } catch { /* opcional */ }
  return { correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha }, solicitud, cotizacion, aprobacion, factura, faltantes }
}

export const leer_paquete = {
  description: "Lee y normaliza el correo, solicitud, cotización, aprobación y factura opcional de un caso de compra.",
  args: { caso: casoSchema.describe("Carpeta del caso: sol-001 a sol-006") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try { casoSchema.parse(args.caso); const data = await leerPaqueteImpl(args.caso, ctx); await log(ctx, "oc_leer_paquete", args.caso, true, `Paquete leído; ${data.faltantes.length} faltantes`); return ok(data) }
    catch (error) { const message = error instanceof Error ? error.message : "No fue posible leer el paquete"; await log(ctx, "oc_leer_paquete", args.caso, false, message); return fail(message) }
  },
}

function hallazgo(codigo: string, titulo: string, detalle: string, accion: string): Hallazgo { return { codigo, titulo, detalle, accion } }

async function validarImpl(paquete: Paquete, ctx: ToolContext): Promise<ResultadoValidacion> {
  const maestros = projectPath(ctx, "fixtures/reto-03/maestros")
  const [proveedores, centros, indicadores, condiciones] = await Promise.all([
    readJson<Proveedor[]>(path.join(maestros, "proveedores.json")), readJson<CentroCosto[]>(path.join(maestros, "centros-costo.json")),
    readJson<Array<{ codigo: string }>>(path.join(maestros, "indicadores-iva.json")), readJson<Array<{ codigo: string }>>(path.join(maestros, "condiciones-pago.json")),
  ])
  const { solicitud, cotizacion, aprobacion, factura } = paquete
  const bloqueos: Hallazgo[] = [], confirmaciones: Hallazgo[] = [], advertencias: Hallazgo[] = [], controles: ResultadoValidacion["controles"] = []
  const nit = solicitud.proveedor_nit ? normalizeNit(solicitud.proveedor_nit) : cotizacion?.nit
  const proveedor = proveedores.find((item) => nit ? normalizeNit(item.nit) === nit : normalizeText(item.nombre) === normalizeText(solicitud.proveedor_nombre))
  const derivados: ResultadoValidacion["derivados"] = {}
  if (!proveedor || !proveedor.activo) {
    bloqueos.push(hallazgo("RC1", "Proveedor no habilitado", proveedor ? "El proveedor está inactivo en el maestro." : "El proveedor no existe en el maestro.", "Solicitar su creación o reactivación en SAP."))
    controles.push({ codigo: "RC1", nombre: "Proveedor habilitado", estado: "bloqueo", detalle: bloqueos.at(-1)!.detalle })
  } else {
    derivados.codigo_proveedor = proveedor.codigo_sap; derivados.proveedor_nit = normalizeNit(proveedor.nit)
    controles.push({ codigo: "RC1", nombre: "Proveedor habilitado", estado: "aprobado", detalle: `${proveedor.nombre} · SAP ${proveedor.codigo_sap}` })
  }
  const centro = centros.find((item) => item.centro_costo === solicitud.centro_costo)
  const aprobador = centro?.aprobadores.find((item) => item.email.toLowerCase() === aprobacion?.de.toLowerCase())
  if (!aprobacion?.aprobado || !aprobador) {
    bloqueos.push(hallazgo("RC2", "Aprobación inválida", !aprobacion?.aprobado ? "No hay una aprobación explícita." : `${aprobacion.de} no puede aprobar compras de ${solicitud.centro_costo}.`, "Obtener aprobación de un responsable autorizado."))
    controles.push({ codigo: "RC2", nombre: "Aprobación autorizada", estado: "bloqueo", detalle: bloqueos.at(-1)!.detalle })
  } else controles.push({ codigo: "RC2", nombre: "Aprobación autorizada", estado: "aprobado", detalle: `${aprobador.nombre} figura en la matriz.` })
  if (aprobador && solicitud.valor_total > aprobador.tope) {
    bloqueos.push(hallazgo("RC3", "Monto fuera del límite", `El valor ${solicitud.valor_total} supera el tope ${aprobador.tope}.`, "Escalar a un aprobador con atribución suficiente."))
    controles.push({ codigo: "RC3", nombre: "Límite de aprobación", estado: "bloqueo", detalle: bloqueos.at(-1)!.detalle })
  } else controles.push({ codigo: "RC3", nombre: "Límite de aprobación", estado: aprobador ? "aprobado" : "informativo", detalle: aprobador ? "El monto está dentro del límite." : "No evaluable sin aprobador válido." })
  if (!centro || !centro.subareas.includes(solicitud.subarea)) {
    bloqueos.push(hallazgo("RC4", "Imputación inválida", `${solicitud.subarea} no pertenece a ${solicitud.centro_costo}.`, "Corregir el centro de costo o la subárea."))
    controles.push({ codigo: "RC4", nombre: "Centro de costo y subárea", estado: "bloqueo", detalle: bloqueos.at(-1)!.detalle })
  } else controles.push({ codigo: "RC4", nombre: "Centro de costo y subárea", estado: "aprobado", detalle: `${centro.nombre} / ${solicitud.subarea}` })
  if (!cotizacion) {
    confirmaciones.push(hallazgo("RC5", "Cotización ausente", "No se encontró una cotización legible.", "Confirmar que se desea continuar sin cotización."))
  } else {
    const variacion = Math.abs(cotizacion.total - solicitud.valor_total) / solicitud.valor_total
    if (variacion > 0.02) confirmaciones.push(hallazgo("RC5", "Diferencia de valores", `Solicitud: ${solicitud.valor_total}; cotización: ${cotizacion.total}; diferencia: ${(variacion * 100).toFixed(1)} %.`, "Verificar los valores y confirmar cuál respalda la compra."))
  }
  controles.push({ codigo: "RC5", nombre: "Consistencia con cotización", estado: confirmaciones.some((item) => item.codigo === "RC5") ? "confirmacion" : "aprobado", detalle: confirmaciones.find((item) => item.codigo === "RC5")?.detalle ?? "La diferencia es igual o inferior al 2 %." })
  if (!solicitud.indicador_iva && proveedor) {
    derivados.indicador_iva = proveedor.indicador_iva_default
    confirmaciones.push(hallazgo("RC6", "IVA completado desde el maestro", `Se propone ${proveedor.indicador_iva_default}.`, "Confirmar el indicador antes de crear la orden."))
  } else if (solicitud.indicador_iva && !indicadores.some((item) => item.codigo === solicitud.indicador_iva)) {
    bloqueos.push(hallazgo("RC6", "Indicador de IVA inválido", `${solicitud.indicador_iva} no existe en el maestro.`, "Corregir el indicador de IVA."))
  }
  controles.push({ codigo: "RC6", nombre: "Indicador de IVA", estado: bloqueos.some((item) => item.codigo === "RC6") ? "bloqueo" : confirmaciones.some((item) => item.codigo === "RC6") ? "confirmacion" : "aprobado", detalle: bloqueos.concat(confirmaciones).find((item) => item.codigo === "RC6")?.detalle ?? `Indicador ${solicitud.indicador_iva}.` })
  if (!solicitud.condiciones_pago && proveedor) derivados.condiciones_pago = proveedor.condiciones_pago_default
  else if (solicitud.condiciones_pago && !condiciones.some((item) => item.codigo === solicitud.condiciones_pago)) bloqueos.push(hallazgo("RC7", "Condición de pago inválida", `${solicitud.condiciones_pago} no existe en el maestro.`, "Seleccionar una condición de pago válida."))
  controles.push({ codigo: "RC7", nombre: "Condiciones de pago", estado: bloqueos.some((item) => item.codigo === "RC7") ? "bloqueo" : "aprobado", detalle: derivados.condiciones_pago ? `Se aplicará ${derivados.condiciones_pago} desde el maestro.` : `Condición ${solicitud.condiciones_pago}.` })
  const retroactiva = Boolean(factura && factura.fecha < solicitud.fecha_solicitud)
  if (retroactiva) confirmaciones.push(hallazgo("RC8", "Compra retroactiva", `La factura ${factura!.numero} es del ${factura!.fecha}, anterior a la solicitud del ${solicitud.fecha_solicitud}.`, "Registrar la excepción y confirmar antes de continuar."))
  controles.push({ codigo: "RC8", nombre: "Retroactividad", estado: retroactiva ? "confirmacion" : "aprobado", detalle: retroactiva ? confirmaciones.at(-1)!.detalle : "No se detectó factura anterior a la solicitud." })
  const aprobacionAnticipada = Boolean(aprobacion && aprobacion.fecha.slice(0, 10) < solicitud.fecha_solicitud)
  if (aprobacionAnticipada) confirmaciones.push(hallazgo("RC9", "Aprobación anterior", `La aprobación es anterior a la solicitud (${aprobacion!.fecha.slice(0, 10)}).`, "Confirmar la vigencia de la aprobación."))
  controles.push({ codigo: "RC9", nombre: "Fecha de aprobación", estado: aprobacionAnticipada ? "confirmacion" : "aprobado", detalle: aprobacionAnticipada ? confirmaciones.at(-1)!.detalle : "La aprobación es posterior o igual a la solicitud." })
  const calculado = solicitud.cantidad * solicitud.valor_unitario
  if (Math.abs(calculado - solicitud.valor_total) > 1) bloqueos.push(hallazgo("RC10", "Total inconsistente", `${solicitud.cantidad} × ${solicitud.valor_unitario} = ${calculado}, no ${solicitud.valor_total}.`, "Corregir cantidad, precio o total."))
  controles.push({ codigo: "RC10", nombre: "Cálculo del total", estado: bloqueos.some((item) => item.codigo === "RC10") ? "bloqueo" : "aprobado", detalle: bloqueos.find((item) => item.codigo === "RC10")?.detalle ?? "Cantidad, precio unitario y total cuadran." })
  return { apta: bloqueos.length === 0, bloqueos, confirmaciones, advertencias, derivados, retroactiva, controles }
}

export const validar = {
  description: "Aplica los diez controles de compra contra los maestros y separa bloqueos, confirmaciones y valores derivados.",
  args: { caso: casoSchema.describe("Caso que se está validando"), paquete: paqueteSchema.describe("Paquete devuelto por oc_leer_paquete") },
  async execute(args: { caso: string; paquete: Paquete }, ctx: ToolContext): Promise<string> {
    try {
      casoSchema.parse(args.caso); paqueteSchema.parse(args.paquete)
      const data = await validarImpl(args.paquete, ctx)
      await writeJson(projectPath(ctx, "out", args.caso, "validacion.json"), data)
      if (data.bloqueos.length) {
        await appendCsv(projectPath(ctx, "out/control.csv"), ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"], [args.paquete.solicitud.solicitud_id, "bloqueada", "", String(data.retroactiva), data.bloqueos.map((item) => item.codigo).join(";"), data.confirmaciones.map((item) => item.codigo).join(";"), isoNow()])
      }
      await log(ctx, "oc_validar", args.caso, true, `${data.bloqueos.length} bloqueos; ${data.confirmaciones.length} confirmaciones`)
      return ok(data)
    }
    catch (error) { const message = error instanceof Error ? error.message : "No fue posible validar"; await log(ctx, "oc_validar", args.caso, false, message); return fail(message) }
  },
}

async function evidenceHash(caso: string, ctx: ToolContext): Promise<string> {
  const file = projectPath(ctx, "out", caso, "aprobacion.txt")
  try {
    const evidence = await readFile(file, "utf8")
    const hash = evidence.match(/SHA-256: ([a-f0-9]{64})/)?.[1]
    if (!hash) throw new Error()
    return hash
  } catch { throw new Error("Primero debe generarse la evidencia de aprobación.") }
}

export const generar_evidencia = {
  description: "Genera una evidencia auditable de la aprobación y calcula su hash SHA-256.", args: { caso: casoSchema.describe("Caso de compra") },
  async execute(args: { caso: string }, ctx: ToolContext): Promise<string> {
    try {
      casoSchema.parse(args.caso); const base = casePath(ctx, args.caso); const [aprobacion, correo] = await Promise.all([readJson<AprobacionFixture>(path.join(base, "aprobacion.json")), readJson<CorreoFixture>(path.join(base, "correo.json"))])
      const contenido = [`De: ${aprobacion.de}`, `Para: ${aprobacion.para ?? correo.para ?? "compras@periferia-ficticia.com"}`, `Fecha: ${aprobacion.fecha}`, `Asunto: ${aprobacion.asunto}`, "", aprobacion.cuerpo].join("\n")
      const sha256 = createHash("sha256").update(contenido).digest("hex"); const ruta = projectPath(ctx, "out", args.caso, "aprobacion.txt")
      await mkdir(path.dirname(ruta), { recursive: true }); await writeFile(ruta, `${contenido}\n\nSHA-256: ${sha256}\n`, "utf8"); await log(ctx, "oc_generar_evidencia", args.caso, true, "Evidencia generada"); return ok({ ruta: path.relative(ctx.directory, ruta), sha256 })
    } catch (error) { const message = error instanceof Error ? error.message : "No fue posible generar la evidencia"; await log(ctx, "oc_generar_evidencia", args.caso, false, message); return fail(message) }
  },
}

function unidadPara(descripcion: string): "UN" | "H" { return normalizeText(descripcion).includes("hora") ? "H" : "UN" }

export const construir_payload = {
  description: "Construye y valida la vista previa de la orden SAP y guarda la trazabilidad campo a campo.",
  args: { caso: casoSchema.describe("Caso de compra"), paquete: paqueteSchema.describe("Paquete normalizado"), derivados: derivadosSchema.describe("Valores calculados por oc_validar") },
  async execute(args: { caso: string; paquete: Paquete; derivados: Derivados }, ctx: ToolContext): Promise<string> {
    try {
      casoSchema.parse(args.caso); paqueteSchema.parse(args.paquete); derivadosSchema.parse(args.derivados)
      const validacion = await readJson<ResultadoValidacion>(projectPath(ctx, "out", args.caso, "validacion.json"))
      if (!validacion.apta) return fail("La solicitud tiene bloqueos y no permite construir una orden válida.")
      const { solicitud, correo, cotizacion, aprobacion } = args.paquete; if (!aprobacion) return fail("Falta la aprobación.")
      const sha256 = await evidenceHash(args.caso, ctx); const d = args.derivados
      const payload: OrdenCompra = {
        referencia: { solicitud_id: solicitud.solicitud_id, correo_id: correo.id, cotizacion_ref: cotizacion?.referencia ?? null }, sociedad: "1000", organizacion_compras: "1000",
        proveedor: { codigo_sap: d.codigo_proveedor!, nit: d.proveedor_nit!, nombre: solicitud.proveedor_nombre }, moneda: solicitud.moneda,
        condiciones_pago: solicitud.condiciones_pago ?? d.condiciones_pago!, aprobador: { email: aprobacion.de, fecha_aprobacion: aprobacion.fecha, evidencia_sha256: sha256 },
        posiciones: [{ numero: 10, descripcion: solicitud.descripcion.slice(0, 40), cantidad: solicitud.cantidad, unidad: unidadPara(solicitud.descripcion), precio_unitario: solicitud.valor_unitario, centro_costo: solicitud.centro_costo, subarea: solicitud.subarea, indicador_iva: solicitud.indicador_iva ?? d.indicador_iva! }],
        excepciones: validacion.confirmaciones.map((item) => ({ codigo: item.codigo, detalle: item.detalle, confirmado_por: null })),
      }
      ordenCompraSchema.parse(payload)
      const trazabilidad = { "referencia.solicitud_id": "solicitud", "referencia.correo_id": "correo", proveedor: "maestro.proveedores", moneda: "solicitud", condiciones_pago: solicitud.condiciones_pago ? "solicitud" : "derivado", aprobador: "aprobacion", posiciones: "solicitud", indicador_iva: solicitud.indicador_iva ? "solicitud" : "derivado", excepciones: "validacion" }
      const ruta = projectPath(ctx, "out", args.caso, "payload.json"); await writeJson(ruta, payload); await writeJson(projectPath(ctx, "out", args.caso, "trazabilidad.json"), trazabilidad); await log(ctx, "oc_construir_payload", args.caso, true, "Payload válido"); return ok({ payload, ruta: path.relative(ctx.directory, ruta), trazabilidad_ruta: `out/${args.caso}/trazabilidad.json` })
    } catch (error) { const message = error instanceof Error ? error.message : "No fue posible construir el payload"; await log(ctx, "oc_construir_payload", args.caso, false, message); return fail(message) }
  },
}

export const crear = {
  description: "Crea una orden en SAP simulado; exige confirmación para excepciones y evita órdenes duplicadas.",
  args: { caso: casoSchema.describe("Caso de compra"), payload: z.custom<OrdenCompra>().describe("Payload validado"), confirmado: z.boolean().optional().describe("Confirmación explícita de las excepciones"), confirmado_por: z.string().optional().describe("Persona que confirmó las excepciones") },
  async execute(args: { caso: string; payload: OrdenCompra; confirmado?: boolean; confirmado_por?: string }, ctx: ToolContext): Promise<string> {
    const controlFile = projectPath(ctx, "out/control.csv"); const headers = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"]
    try {
      casoSchema.parse(args.caso); ordenCompraSchema.parse(args.payload)
      const validacion = await readJson<ResultadoValidacion>(projectPath(ctx, "out", args.caso, "validacion.json"))
      if (validacion.bloqueos.length) return fail("La solicitud conserva bloqueos y no puede crearse.")
      if (validacion.confirmaciones.length && !args.confirmado) {
        await appendCsv(controlFile, headers, [args.payload.referencia.solicitud_id, "pendiente", "", String(validacion.retroactiva), "", validacion.confirmaciones.map((item) => item.codigo).join(";"), isoNow()]); return fail("La orden requiere confirmación explícita antes de ser creada.")
      }
      const sap = new SapMockAdapter(ctx.directory); const existente = await sap.buscarOrdenPorReferencia(args.payload.referencia.solicitud_id)
      const payload = { ...args.payload, excepciones: args.payload.excepciones.map((item) => ({ ...item, confirmado_por: args.confirmado_por ?? ctx.sessionId })) }
      const result = await sap.crearOrden(payload); const idempotente = Boolean(existente)
      await appendCsv(controlFile, headers, [payload.referencia.solicitud_id, idempotente ? "existente" : "creada", result.numero_oc, String(validacion.retroactiva), "", validacion.confirmaciones.map((item) => item.codigo).join(";"), isoNow()]); await log(ctx, "oc_crear", args.caso, true, `${idempotente ? "OC existente" : "OC creada"}: ${result.numero_oc}`)
      return ok({ ...result, idempotente })
    } catch (error) { const message = error instanceof Error ? error.message : "No fue posible crear la orden"; await appendCsv(controlFile, headers, [args.payload?.referencia?.solicitud_id ?? args.caso, "error", "", "false", "", "", isoNow()]); await log(ctx, "oc_crear", args.caso, false, message); return fail(message) }
  },
}

export async function procesarCaso(caso: string, ctx: ToolContext, confirmado = false) {
  const lectura = JSON.parse(await leer_paquete.execute({ caso }, ctx)) as ToolResponse<Paquete>
  if (!lectura.ok) throw new Error(lectura.error)
  const paquete = lectura.data
  const validacionResult = JSON.parse(await validar.execute({ caso, paquete }, ctx)) as ToolResponse<ResultadoValidacion>
  if (!validacionResult.ok) throw new Error(validacionResult.error)
  const validacion = validacionResult.data
  let payload: OrdenCompra | null = null
  let creacion: ToolResponse<{ numero_oc: string; fecha: string; idempotente: boolean }> | null = null
  if (validacion.apta) {
    const evidencia = JSON.parse(await generar_evidencia.execute({ caso }, ctx)) as ToolResponse<{ ruta: string; sha256: string }>
    if (!evidencia.ok) return { caso, paquete, validacion, payload, creacion }
    const payloadRaw = await construir_payload.execute({ caso, paquete, derivados: validacion.derivados }, ctx); const parsed = JSON.parse(payloadRaw) as ToolResponse<{ payload: OrdenCompra }>
    if (parsed.ok) {
      payload = parsed.data.payload
      creacion = JSON.parse(await crear.execute({ caso, payload, confirmado, confirmado_por: confirmado ? "demo" : undefined }, ctx)) as ToolResponse<{ numero_oc: string; fecha: string; idempotente: boolean }>
    }
  }
  return { caso, paquete, validacion, payload, creacion }
}

export const tools = { oc_leer_paquete: leer_paquete, oc_validar: validar, oc_generar_evidencia: generar_evidencia, oc_construir_payload: construir_payload, oc_crear: crear }
