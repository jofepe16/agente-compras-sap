# Solución — Mesa de Compras

## 1. Problema

La analista de compras pierde tiempo transcribiendo información en SAP y ejecuta de memoria controles que deberían ser consistentes y auditables.

## 2. Arquitectura

```text
Interfaz web
    │
    ├── Bandeja operativa ──► API ──► herramientas ──► fixtures / out
    │                                      │
    └── Chat ──► ciclo del agente ─────────┘
                         │
                  adaptador de modelo

herramientas ──► SapAdapter ──► SapMockAdapter ──► out/sap/ordenes.jsonl
```

La bandeja y `demo.ts` llaman la misma lógica que las herramientas del agente. El comportamiento conversacional vive en `agent/prompt.md`; el conocimiento estable está en `src/knowledge/`; las decisiones operativas están en `src/tools/oc.ts`.

## 3. Ciclo del agente

El backend conserva el historial por sesión y envía al modelo las herramientas disponibles. Cuando el modelo solicita una herramienta, el backend valida y ejecuta sus argumentos, añade el resultado al historial y continúa hasta obtener una respuesta final.

El ciclo tiene límites configurables de iteraciones y tokens. El prompt obliga a detenerse ante bloqueos y a cerrar el turno con una pregunta cuando existen confirmaciones. `oc_crear` vuelve a comprobar esta condición, por lo que la seguridad no depende únicamente del prompt.

## 4. Modelo

La implementación incluye un adaptador para OpenAI y utiliza `gpt-5.6-luna` de forma predeterminada. Se eligió un modelo económico porque su función es seleccionar herramientas y explicar resultados estructurados; no debe resolver reglas financieras.

La [documentación oficial de GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) consultada el 12 de octubre de 2026 publica USD 0,20 por millón de tokens de entrada y USD 1,20 por millón de tokens de salida. Para un caso conservador de 12.000 tokens de entrada acumulados y 1.500 de salida, el costo estimado es:

```text
(12.000 × 0,20 / 1.000.000) + (1.500 × 1,20 / 1.000.000)
= USD 0,0042 por caso
= USD 4,20 por cada 1.000 casos
```

Es una estimación, no una tarifa fija: el valor real depende del historial y de las llamadas requeridas. El techo configurable de 100.000 tokens acumulados por sesión evita consumo indefinido sin interrumpir el flujo de herramientas; la bandeja determinista no consume tokens.

La demo determinista no necesita modelo ni clave.

## 5. Matriz de controles

| Control | Implementación | Resultado |
|---|---|---|
| RC1 | Busca proveedor por NIT normalizado o nombre y verifica estado | Bloqueo |
| RC2 | Exige “Aprobado” y cruza el correo con la matriz del centro | Bloqueo |
| RC3 | Compara el total contra el tope del aprobador | Bloqueo |
| RC4 | Verifica que la subárea pertenezca al centro | Bloqueo |
| RC5 | Calcula la variación entre solicitud y cotización | Confirmación si supera 2 % |
| RC6 | Verifica IVA o propone el predeterminado del proveedor | Confirmación si se deriva |
| RC7 | Verifica o deriva condiciones de pago | Informativo / bloqueo si es inválida |
| RC8 | Compara fecha de factura y solicitud | Confirmación y marca retroactiva |
| RC9 | Compara fecha de aprobación y solicitud | Confirmación |
| RC10 | Recalcula cantidad × valor unitario | Bloqueo |

RC2 es el control más delicado porque combina evidencia no estructurada, pertenencia al centro de costo y autoridad por monto. Se separó RC3 para mostrar con precisión si falla la identidad del aprobador o su atribución.

## 6. Adaptador SAP real

Usaría SAP Integration Suite como fachada y `API_PURCHASEORDER_PROCESS_SRV` cuando el landscape confirme que la API está habilitada. La aplicación conservaría `SapAdapter`; solo se reemplazaría `SapMockAdapter`.

El mapeo sería:

- `sociedad` → CompanyCode.
- `organizacion_compras` → PurchasingOrganization.
- `proveedor.codigo_sap` → Supplier.
- `condiciones_pago` → PaymentTerms.
- Cada posición → PurchaseOrderItem con centro de costo e indicador tributario.
- `referencia.solicitud_id` → referencia externa usada para idempotencia.

Las credenciales vivirían en un gestor de secretos del entorno de integración. Antes de cada reintento se consultaría la referencia externa. Una respuesta ambigua se enviaría a conciliación en lugar de repetir inmediatamente la creación.

Si la conexión no fuera viable, el sistema seguiría validando el paquete y generaría un archivo de carga o una vista lista para transcribir. La reducción de errores permanece aunque el último paso sea manual.

## 7. Lectura del proceso

Las órdenes retroactivas no son un problema de digitación sino una señal de que el compromiso con el proveedor ocurrió antes del control. Automatizar su creación sin distinguirlas haría más rápido el incumplimiento.

Propongo medir mensualmente el porcentaje de OC retroactivas por área y causa. La política debería exigir número de OC antes de iniciar el servicio, con una ruta excepcional para urgencias aprobada por Finanzas. El sistema registra la excepción, pero la dirección define su tolerancia.

## 8. Decisiones y trade-offs

### Reglas deterministas frente a decisiones del modelo

Los montos, bloqueos y payload se resuelven con TypeScript. Un enfoque completamente generativo sería más corto, pero difícil de probar y auditar.

### Archivos frente a base de datos

Se respetó el alcance usando JSONL y CSV. Una base de datos mejoraría concurrencia y consultas, pero añadiría infraestructura que no aporta valor a esta demostración.

### Interfaz operativa frente a chat como pantalla principal

La bandeja reduce el número de instrucciones que una analista debe escribir. El chat se conserva como apoyo y satisface el flujo conversacional sin convertir una tarea repetitiva en conversación obligatoria.

### Evidencia de texto frente a PDF

Se implementó el requisito P0 con texto y SHA-256. El PDF es P1 y se deja fuera para proteger el tiempo dedicado a controles e idempotencia.

## 9. Supuestos

- Los fixtures representan paquetes previamente normalizados.
- El NIT sin dígito de verificación identifica al proveedor.
- La palabra “Aprobado” es evidencia suficiente dentro del alcance.
- El total de la solicitud incluye impuestos, igual que el total de la cotización.
- Una posición por solicitud es suficiente para los casos entregados.

## 10. Cobertura

| Historia | Estado | Observación |
|---|---|---|
| HU-1 Leer paquete | Hecho | Normaliza cinco fuentes y reporta faltantes |
| HU-2 Validar | Hecho | RC1–RC10 y salida estructurada |
| HU-3 Construir payload | Hecho | Esquema Zod y trazabilidad |
| HU-4 Evidencia | Hecho P0 | Texto y SHA-256; PDF es opcional |
| HU-5 Crear en SAP | Hecho | Secuencia, idempotencia y control CSV |
| HU-6 Errores | Hecho | Respuestas tipadas y mensajes legibles |

Para producción faltan autenticación, persistencia transaccional, antivirus para adjuntos, OCR, observabilidad centralizada y conexión real con SAP.

## 11. Uso de asistentes de IA

Se utilizó OpenAI Codex para contrastar el PRD, explorar la arquitectura, revisar casos límite y acelerar tareas mecánicas de implementación y documentación. Las reglas se verificaron mediante una demo determinista y pruebas automatizadas.

Se descartaron tres propuestas surgidas durante el trabajo: usar un framework completo para el frontend, porque la interfaz no necesitaba compilación; delegar validaciones al modelo, porque montos y autorizaciones deben ser deterministas; y añadir una base de datos, porque el PRD permite archivos y la infraestructura adicional no aportaba valor a la prueba. La versión final usa un servidor HTTP nativo, JavaScript de navegador y una sola dependencia de producción.

## 12. Riesgos de producción

- **Correos manipulados:** validar identidad mediante el proveedor corporativo y conservar encabezados firmados.
- **Cambios en maestros:** consultar SAP en tiempo real y registrar la versión utilizada.
- **Concurrencia:** reemplazar archivos por almacenamiento transaccional y claves únicas.
- **Creación ambigua:** reconciliar por referencia externa antes de reintentar.
- **Exposición de datos:** autenticación, autorización por rol, cifrado y políticas de retención.
- **Indisponibilidad del modelo:** mantener la bandeja y las herramientas operativas sin LLM.
