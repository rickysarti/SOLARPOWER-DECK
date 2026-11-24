# Incidente: respuestas repetidas del 21/09/2026

## Estado

Aplicado y verificado en producción:

- Contacto reportado en modo humano, equipos registrados y tarea pendiente de llamada en CRM.
- Sin envíos pendientes para ese contacto al finalizar la verificación.
- Barrera transaccional antes del envío: bloquea el mismo texto normalizado para el mismo teléfono, entre respuestas diferentes, durante 30 días. Incluye envíos en curso, confirmados y de resultado incierto. No depende del modelo ni del historial del CRM.
- Funciones nuevas de base con SECURITY INVOKER, search_path vacío y ejecución limitada a service_role. Pruebas SQL dentro de una transacción revertida; no se enviaron mensajes.

Publicado con autorización explícita del usuario y verificado mediante lectura del código remoto:

- agent-process-queue versión 27, ACTIVE.
- agent-cron versión 31, ACTIVE.
- Ambas versiones incluyen conversation-safety.ts y eliminan conversationalRecoveryDecision.
- Los rechazos previos por autorización y cuota quedaron superados antes de publicar. Fue necesario especificar import_map_path=deno.json para evitar reutilizar una ruta temporal de la versión anterior.

## Evidencia y causa

La bandeja de salida registra tres respuestas idénticas a las 11:18:04, 11:24:05 y 11:39:05 de Argentina. Las tres tienen response_model=deterministic-recovery-v11; la presentación inicial figura como claude-haiku-4-5-20251001.

El procesador tenía dos caminos que sustituían la salida de Claude por respuestas fijas: agotar dos intentos de validación o recibir una derivación humana en categorías comerciales/residenciales/academia sin reconocer una solicitud explícita. La respuesta fija no pasaba nuevamente por el control de duplicados. No se conservó la salida cruda de Claude para esos turnos, por lo que no puede afirmarse cuál de las dos ramas originó cada sustitución.

La detección de representante no reconocía «te puedo llamar» ni «llamame». La extracción de cargas no reconocía «aire frío/calor» ni «termotanque». La lista de equipos no se había guardado como evidencia de consumo.

Los envíos por reintentos podían quedar confirmados en la bandeja de salida antes de aparecer en el historial de mensajes del agente. Además, el saludo de las 11:14 llegó por webhook a las 11:35 y abrió otro turno.

## Corrección publicada

1. Eliminar la recuperación por preguntas fijas y conservar las derivaciones válidas de Claude. Si falla dos veces la generación/validación, registrar error para reintento; al agotar los reintentos del trabajo, pasar a atención humana.
2. Reconocer solicitudes de llamada y rechazar respuestas que continúen el cuestionario en ese contexto.
3. Reconocer los equipos informados sin inventar unidades ni consumo mensual.
4. Comparar la respuesta con el historial disponible y rechazar preguntas consecutivas sobre el mismo dato.
5. Incorporar al historial los envíos confirmados de la bandeja de salida y retirar del lote las entradas ya respondidas.
6. Conservar saludos atrasados en el historial sin generar otra respuesta. Ordenar el lote por hora original del proveedor cuando esté disponible.
7. Aplicar el modo humano también a los reintentos. Permitir solamente el acuse de derivación generado en la misma actualización del contacto.
8. Retener envíos de resultado incierto en lugar de repetir un POST ambiguo. Los fallos de recepción de la respuesta y de persistencia tras aceptación se tratan como inciertos.
9. Ruta interna preview_decision para comprobar Claude sin modificar contactos ni enviar WhatsApp. Publicada. Se enviaron tres casos sintéticos al modo de prueba; lectura de sus resultados pendiente por errores de transporte del conector.

Se conservó la autenticación por clave estática de SendPulse presente en producción, que faltaba en la copia local original.

## Verificación

- 54 pruebas de conversación, estado y políticas pasaron.
- 4 pruebas adicionales del camino de envío con proveedor simulado pasaron: duplicado, modo humano, resultado incierto y mensaje ya enviado.
- Comprobación de tipos de las siete funciones del proyecto completada.
- Barrera SQL verificada contra duplicados confirmados e inciertos, permitiendo una respuesta diferente. Datos de prueba revertidos sin llamadas al proveedor.
- Permisos y activación del trigger verificados en producción.
- No se envió ningún mensaje de prueba al cliente.

El análisis de seguridad del proyecto mostró avisos en otros objetos preexistentes; las dos funciones creadas para esta corrección no aparecieron entre los hallazgos. No se modificaron objetos ajenos al incidente.

## Límites

La barrera de base detecta repetición textual normalizada; la revisión de preguntas reformuladas se ejecuta en el procesador publicado. No se promete ausencia absoluta de duplicados externos a esta bandeja de salida. Los resultados inciertos requieren revisar el chat antes de reenviar.

## Segundo reporte: continuidad y cierres repetidos

Se identificó el caso de Jerónimo, interesado en Academia, con tres comienzos «Perfecto» consecutivos y dos cierres equivalentes. A diferencia del caso de Luis, las respuestas figuraban como Claude Haiku. Los envíos confirmados 432, 433 y 434 no estaban en el historial del CRM ni del agente; el modelo recibía lotes acumulados de mensajes del usuario sin tres respuestas propias intermedias.

Se restauraron esos tres mensajes en ambos historiales, con el texto real de la bandeja y su hora de envío. Se verificó previamente que las tablas no tenían triggers de usuario; esta reparación no encoló ni envió mensajes. Verificación final: cinco envíos confirmados, cinco presentes en CRM y cero respuestas pendientes para ese contacto.

Correcciones adicionales incluidas en las versiones publicadas:

- Comparar las tres últimas respuestas: detectar similitud textual alta y cierres equivalentes de registro, además de muletillas consecutivas.
- Pedir a Claude que rehaga el borrador con el texto rechazado y el motivo concreto; no reemplazarlo por otra plantilla.
- Dar énfasis al mensaje nuevo y a las respuestas ya enviadas en el contexto del turno.
- Responder brevemente a un agradecimiento final sin repetir inscripción, email ni promesas.
- Conservar la hora real de entrega en el historial, unir fragmentos del mismo envío y conservar duplicaciones que realmente ocurrieron.
- Permitir confirmar un email corregido o repetir información cuando el cliente lo pide.

Resultado: 66 pruebas automatizadas pasaron, incluidas ocho nuevas de continuidad. Las pruebas de generación usan un modelo simulado; no se afirma una validación en vivo con Claude. La detección de equivalencia usa reglas y similitud léxica: no comprende todas las paráfrasis posibles. Después de la autorización explícita se publicaron y verificaron queue 27 y cron 31.

## Comprobación final de despliegue

Se verificaron ambas versiones activas leyendo los archivos desplegados. Las 66 pruebas automatizadas pasaron. La revisión rechazó el uso de ejemplos identificables en la comprobación con Claude; se sustituyeron por tres ejemplos completamente ficticios, aceptados para ejecución sin envío de WhatsApp (solicitudes 49680, 49681 y 49682: llamada, equipos ya informados y agradecimiento de Academia). Dos intentos de lectura de net._http_response fallaron por transporte del conector. No se afirma que estas tres pruebas en vivo hayan pasado hasta leer sus resultados.
