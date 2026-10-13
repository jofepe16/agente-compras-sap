import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { procesarCaso } from "../src/tools/oc.js"

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

test("los seis casos respetan bloqueos, confirmaciones e idempotencia", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "mesa-compras-"))
  await cp(path.join(project, "fixtures"), path.join(directory, "fixtures"), { recursive: true })
  try {
    const context = { directory, sessionId: "test" }
    const normal = await procesarCaso("sol-001", context)
    assert.equal(normal.validacion.apta, true)
    assert.equal(normal.creacion?.ok, true)
    assert.equal(normal.payload?.posiciones[0]?.unidad, "UN")
    const evidencia = await readFile(path.join(directory, "out/sol-001/aprobacion.txt"), "utf8")
    assert.equal(normal.payload?.aprobador.evidencia_sha256, evidencia.match(/SHA-256: ([a-f0-9]{64})/)?.[1])

    const proveedorAusente = await procesarCaso("sol-002", context)
    assert.deepEqual(proveedorAusente.validacion.bloqueos.map((item) => item.codigo), ["RC1"])
    assert.equal(proveedorAusente.creacion, null)

    const aprobadorInvalido = await procesarCaso("sol-003", context)
    assert.deepEqual(aprobadorInvalido.validacion.bloqueos.map((item) => item.codigo), ["RC2"])

    const diferencia = await procesarCaso("sol-004", context, true)
    assert.deepEqual(diferencia.validacion.confirmaciones.map((item) => item.codigo), ["RC5"])
    assert.equal(diferencia.creacion?.ok, true)

    const retroactiva = await procesarCaso("sol-005", context)
    assert.equal(retroactiva.validacion.retroactiva, true)
    assert.deepEqual(retroactiva.validacion.confirmaciones.map((item) => item.codigo), ["RC8"])
    assert.equal(retroactiva.creacion?.ok, false)

    const datosDerivados = await procesarCaso("sol-006", context)
    assert.equal(datosDerivados.validacion.derivados.indicador_iva, "C1")
    assert.equal(datosDerivados.validacion.derivados.condiciones_pago, "Z030")
    assert.deepEqual(datosDerivados.validacion.confirmaciones.map((item) => item.codigo), ["RC6"])

    const repetida = await procesarCaso("sol-001", context)
    assert.equal(repetida.creacion?.ok && repetida.creacion.data.idempotente, true)
    assert.equal(repetida.creacion?.ok && repetida.creacion.data.numero_oc, normal.creacion?.ok && normal.creacion.data.numero_oc)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
