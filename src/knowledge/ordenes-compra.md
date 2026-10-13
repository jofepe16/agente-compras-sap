# Conocimiento del proceso de órdenes de compra

La Mesa de Compras prepara órdenes para la sociedad y organización de compras `1000`. Los datos operativos provienen de la solicitud, la cotización, la aprobación y los maestros entregados. El modelo no calcula ni corrige montos.

Los controles RC1–RC4 y RC10 son bloqueantes. RC5, RC6, RC8 y RC9 pueden requerir confirmación humana. RC7 permite completar las condiciones de pago desde el maestro del proveedor.

Una compra es retroactiva cuando existe una factura con fecha anterior a la solicitud. Puede registrarse únicamente después de una confirmación y siempre queda marcada en el control operativo.

El número de orden lo asigna SAP. Repetir una solicitud ya creada devuelve la orden existente.
