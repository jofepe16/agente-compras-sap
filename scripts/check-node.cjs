const major = Number(process.versions.node.split(".")[0])

if (major < 20) {
  console.error("\nMesa de Compras requiere Node.js 20 o superior.")
  console.error(`Versión activa: ${process.version}`)
  console.error("Actualiza Node y vuelve a ejecutar npm install.\n")
  process.exit(1)
}
