# Mesa de Compras

Aplicación para revisar paquetes de compra, ejecutar controles internos y crear órdenes en un adaptador SAP simulado. La interfaz prioriza la bandeja operativa; el asistente conversacional funciona como apoyo contextual.

El código propio es pequeño. `node_modules/` contiene dependencias descargadas por npm, no forma parte de la solución y está excluido por `.gitignore`.

## Requisitos

- Node.js 20 o superior.
- Una clave de OpenAI para el chat. La demo determinista y la interfaz operativa funcionan sin ella.

Comprueba la versión activa antes de instalar:

```bash
node --version
```

Debe comenzar por `v20` o una versión superior. El repositorio incluye `.nvmrc` para seleccionar Node 20 con `nvm use`.

## Inicio local

```bash
cp .env.example .env
npm install
npm run dev
```

La aplicación queda disponible en `http://localhost:3000`.

Variables opcionales:

| Variable | Uso | Predeterminado |
|---|---|---|
| `PORT` | Puerto HTTP | `3000` |
| `OPENAI_API_KEY` | Habilita el chat con herramientas | Sin configurar |
| `LLM_MODEL` | Modelo utilizado por el adaptador | `gpt-5.6-luna` |
| `MAX_AGENT_ITERATIONS` | Límite de llamadas por turno | `12` |
| `MAX_SESSION_TOKENS` | Techo de seguridad por sesión | `100000` |
| `MAX_CHAT_REQUESTS_PER_HOUR` | Límite de mensajes por IP | `30` |

## Verificación

La demo limpia `out/`, procesa los seis casos, confirma `sol-004` y ejecuta dos veces `sol-001` para comprobar idempotencia:

```bash
npm run demo
npm test
npm run typecheck
```

## Uso

1. Abre una solicitud en la bandeja.
2. Selecciona **Revisar solicitud**.
3. Consulta los diez controles en el expediente.
4. Si existe una excepción confirmable, revisa su detalle y confirma.
5. El número de OC aparece cuando el adaptador SAP registra la orden.

El panel **Abrir asistente** permite iniciar el mismo flujo con lenguaje natural cuando `OPENAI_API_KEY` está configurada. Cada llamada a una herramienta queda visible en la conversación.

## API

| Ruta | Uso |
|---|---|
| `GET /api/health` | Estado del servicio y modo activo |
| `POST /api/cases/:caso/process` | Flujo determinista de un caso |
| `POST /api/chat` | Conversación con herramientas |
| `GET /api/sessions/:id` | Historial visible de una sesión |

## Estructura

```text
agent/prompt.md                 comportamiento conversacional
src/agent/runner.ts             ciclo del agente
src/domain/                     tipos y esquemas de la OC
src/knowledge/                  conocimiento del proceso
src/llm/                        adaptador del proveedor
src/sap/                        contrato y simulador SAP
src/tools/oc.ts                 controles y herramientas
web/                            interfaz administrativa
fixtures/                       datos de entrada, solo lectura
out/                            resultados generados
demo.ts                         verificación sin modelo
```

## Despliegue

El repositorio incluye `render.yaml`. En Render se debe crear el servicio desde el repositorio y configurar `OPENAI_API_KEY` como secreto. El endpoint de salud es `/api/health` y no expone credenciales.

## Seguridad

- La clave del proveedor existe únicamente en el backend.
- El chat limita iteraciones, tokens por sesión y mensajes por IP.
- Las herramientas aceptan casos de una lista cerrada para impedir recorridos de ruta.
- Los valores de la OC provienen de fixtures o maestros, no de texto generado.
- Las excepciones requieren confirmación explícita.
- Cada operación deja trazabilidad en `out/log.jsonl` y `out/control.csv`.
