import { z } from "zod"

export type Currency = "COP" | "USD"

export type Solicitud = {
  solicitud_id: string
  solicitante: string
  proveedor_nombre: string
  proveedor_nit?: string | null
  descripcion: string
  centro_costo: string
  subarea: string
  cantidad: number
  valor_unitario: number
  valor_total: number
  moneda: Currency
  indicador_iva?: string | null
  condiciones_pago?: string | null
  fecha_solicitud: string
}

export type Paquete = {
  correo: { id: string; de: string; asunto: string; fecha: string }
  solicitud: Solicitud
  cotizacion: { referencia: string | null; proveedor: string; nit: string | null; total: number; moneda: Currency; validez_hasta: string | null; texto: string } | null
  aprobacion: { de: string; fecha: string; aprobado: boolean; texto: string } | null
  factura: { numero: string; fecha: string; total: number } | null
  faltantes: string[]
}

export type Hallazgo = { codigo: string; titulo: string; detalle: string; accion: string }
export type Derivados = { codigo_proveedor?: string; proveedor_nit?: string; indicador_iva?: string; condiciones_pago?: string }

export type ResultadoValidacion = {
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  advertencias: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
  controles: Array<{ codigo: string; nombre: string; estado: "aprobado" | "bloqueo" | "confirmacion" | "informativo"; detalle: string }>
}

export type OrdenCompra = {
  referencia: { solicitud_id: string; correo_id: string; cotizacion_ref: string | null }
  sociedad: "1000"
  organizacion_compras: "1000"
  proveedor: { codigo_sap: string; nit: string; nombre: string }
  moneda: Currency
  condiciones_pago: string
  aprobador: { email: string; fecha_aprobacion: string; evidencia_sha256: string }
  posiciones: Array<{ numero: number; descripcion: string; cantidad: number; unidad: "UN" | "H" | "MES"; precio_unitario: number; centro_costo: string; subarea: string; indicador_iva: string }>
  excepciones: Array<{ codigo: string; detalle: string; confirmado_por: string | null }>
}

export type ToolContext = { directory: string; sessionId: string }
export type ToolResponse<T> = { ok: true; data: T } | { ok: false; error: string }

export const ordenCompraSchema = z.object({
  referencia: z.object({ solicitud_id: z.string().min(1), correo_id: z.string().min(1), cotizacion_ref: z.string().nullable() }),
  sociedad: z.literal("1000"), organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string().min(1), nit: z.string().min(1), nombre: z.string().min(1) }),
  moneda: z.enum(["COP", "USD"]), condiciones_pago: z.string().min(1),
  aprobador: z.object({ email: z.email(), fecha_aprobacion: z.string().min(1), evidencia_sha256: z.string().length(64) }),
  posiciones: z.array(z.object({
    numero: z.number().int().positive().multipleOf(10), descripcion: z.string().min(1).max(40), cantidad: z.number().positive(),
    unidad: z.enum(["UN", "H", "MES"]), precio_unitario: z.number().nonnegative(), centro_costo: z.string().min(1),
    subarea: z.string().min(1), indicador_iva: z.string().min(1),
  })).min(1),
  excepciones: z.array(z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() })),
})
