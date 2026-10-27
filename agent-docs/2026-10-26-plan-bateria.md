# Plan Batería: reconocer el interés antes de preguntar el objetivo

La consulta por Plan Batería ya expresa interés en ahorro y respaldo con paneles e inversor híbrido en alquiler y batería propia. El bot reconoce el producto, responde la consulta y pide únicamente información pendiente. Una barrera rechaza la pregunta redundante sobre ahorro versus cortes y solicita regenerar la respuesta.

Publicado en Supabase SolarPower: agent-process-queue v38 y agent-cron v41. Los paquetes se construyeron sobre las versiones activas v37 y v40 conservando los demás archivos; no se publicaron otros cambios locales pendientes.

Verificación: 90 pruebas en el checkout de trabajo y comprobación de tipos; 38 pruebas y comprobación de tipos sobre main con este cambio aislado. Dos previsualizaciones internas en producción devolvieron HTTP 200: el mensaje original avanzó a pedir consumo; con 800 kWh informados avanzó a datos del proyecto sin repetir consumo ni objetivo. Las previsualizaciones no enviaron WhatsApp ni alteraron contactos.
