import { mkdir, readFile } from "node:fs/promises"
import path from "node:path"
import type { OrdenCompra } from "../domain/types.js"
import { appendJsonLine, normalizeNit, readJson } from "../lib/files.js"
import type { SapAdapter } from "./adapter.js"

type Proveedor = { codigo_sap: string; nit: string; activo: boolean }
type RegistroOrden = { numero_oc: string; fecha: string; orden: OrdenCompra }

export class SapMockAdapter implements SapAdapter {
  constructor(private readonly directory: string) {}

  private get maestrosDir(): string { return path.join(this.directory, "fixtures/reto-03/maestros") }
  private get ordenesFile(): string { return path.join(this.directory, "out/sap/ordenes.jsonl") }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const proveedores = await readJson<Proveedor[]>(path.join(this.maestrosDir, "proveedores.json"))
    const encontrado = proveedores.find((item) => normalizeNit(item.nit) === normalizeNit(nit))
    return encontrado ? { codigo_sap: encontrado.codigo_sap, activo: encontrado.activo } : null
  }

  async buscarOrdenPorReferencia(solicitudId: string): Promise<{ numero_oc: string } | null> {
    const registros = await this.leerOrdenes()
    const existente = registros.find((item) => item.orden.referencia.solicitud_id === solicitudId)
    return existente ? { numero_oc: existente.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const existente = await this.buscarOrdenPorReferencia(orden.referencia.solicitud_id)
    if (existente) return { ...existente, fecha: colombiaToday() }
    const registros = await this.leerOrdenes()
    const numero_oc = String(4_500_000_001 + registros.length)
    const fecha = colombiaToday()
    await mkdir(path.dirname(this.ordenesFile), { recursive: true })
    await appendJsonLine(this.ordenesFile, { numero_oc, fecha, orden })
    return { numero_oc, fecha }
  }

  private async leerOrdenes(): Promise<RegistroOrden[]> {
    try {
      const contenido = await readFile(this.ordenesFile, "utf8")
      return contenido.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RegistroOrden)
    } catch { return [] }
  }
}

function colombiaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date())
}
