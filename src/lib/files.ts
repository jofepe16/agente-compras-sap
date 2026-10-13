import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

export async function readJson<T>(file: string): Promise<T> { return JSON.parse(await readFile(file, "utf8")) as T }
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}
export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true }); await appendFile(file, `${JSON.stringify(value)}\n`, "utf8")
}
export async function appendCsv(file: string, headers: string[], row: string[]): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true })
  let existing = ""; try { existing = await readFile(file, "utf8") } catch { /* archivo nuevo */ }
  const escape = (cell: string) => `"${cell.replaceAll('"', '""')}"`
  const lines = existing ? [] : [headers.map(escape).join(",")]; lines.push(row.map(escape).join(","))
  await appendFile(file, `${lines.join("\n")}\n`, "utf8")
}
export function normalizeNit(value: string): string { const digits = value.replace(/\D/g, ""); return digits.length > 9 ? digits.slice(0, 9) : digits }
export function normalizeText(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim() }
export function isoNow(): string { return new Date().toISOString() }
