-- ============================================================
-- SOLARPOWER WHATSAPP AGENT — Schema para Supabase / PostgreSQL
-- ============================================================
-- Para aplicar: ir a Supabase > SQL Editor > pegar este archivo y ejecutar
-- Todas las tablas usan RLS (Row Level Security) como buena práctica
-- ============================================================


-- ─── EXTENSIONES ─────────────────────────────────────────────────────────────

-- UUID para IDs más seguros (opcional, el schema usa BIGSERIAL por defecto)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";


-- ─── TABLA: contacts ──────────────────────────────────────────────────────────
-- Clientes y leads que contactaron al bot de SolarPower

CREATE TABLE IF NOT EXISTS contacts (
  id               BIGSERIAL PRIMARY KEY,
  phone            TEXT        UNIQUE NOT NULL,           -- Número internacional sin '+'
  name             TEXT,
  label            TEXT        NOT NULL DEFAULT 'Interesado', -- Etiqueta del lead
  stage            TEXT        NOT NULL DEFAULT 'nuevo',  -- Estado en el funnel
  -- Datos para cotización solar
  bill_received    BOOLEAN     NOT NULL DEFAULT FALSE,    -- ¿Enviaron la factura?
  roof_type        TEXT,                                  -- chapa / tejas / losa / membrana / mixto
  connection_type  TEXT,                                  -- monofasica / trifasica
  locality         TEXT,                                  -- Barrio / ciudad
  product_interest TEXT,                                  -- plan_alquiler / plan_bateria / compra_directa / academia / otro
  -- Metadata
  first_contact    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_contact     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes            TEXT,
  notified_ricardo BOOLEAN     NOT NULL DEFAULT FALSE     -- Ya se notificó a Ricardo?
);

-- Índices para búsquedas frecuentes
CREATE INDEX IF NOT EXISTS idx_contacts_phone     ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_label     ON contacts(label);
CREATE INDEX IF NOT EXISTS idx_contacts_last_contact ON contacts(last_contact DESC);

-- RLS: por ahora solo el service role tiene acceso (backend)
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  contacts IS 'Clientes y leads del bot de WhatsApp SolarPower';
COMMENT ON COLUMN contacts.phone IS 'Número WhatsApp en formato internacional sin +. Ej: 5491134583958';
COMMENT ON COLUMN contacts.label IS 'Etiqueta comercial: Interesado, Propuesta enviada, No interesado, etc.';
COMMENT ON COLUMN contacts.stage IS 'Etapa del funnel: nuevo, en_contacto, propuesta, cerrado, perdido';
COMMENT ON COLUMN contacts.bill_received IS 'True si el cliente ya enviró foto de su factura de luz';
COMMENT ON COLUMN contacts.product_interest IS 'Producto de interés: plan_alquiler, plan_bateria, compra_directa, academia, proveedor';


-- ─── TABLA: messages ──────────────────────────────────────────────────────────
-- Historial completo de conversaciones de cada cliente con el bot

CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL   PRIMARY KEY,
  contact_phone TEXT        NOT NULL REFERENCES contacts(phone) ON DELETE CASCADE,
  role          TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content       TEXT        NOT NULL,
  timestamp     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índice para cargar historial rápido
CREATE INDEX IF NOT EXISTS idx_messages_contact_phone ON messages(contact_phone);
CREATE INDEX IF NOT EXISTS idx_messages_timestamp     ON messages(timestamp DESC);

ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  messages IS 'Historial de mensajes de WhatsApp entre clientes y el bot';
COMMENT ON COLUMN messages.role IS 'user = mensaje del cliente, assistant = respuesta del bot';


-- ─── TABLA: pending_actions ───────────────────────────────────────────────────
-- Acciones pendientes que Ricardo necesita tomar manualmente

CREATE TABLE IF NOT EXISTS pending_actions (
  id            BIGSERIAL   PRIMARY KEY,
  contact_phone TEXT        NOT NULL REFERENCES contacts(phone) ON DELETE CASCADE,
  action_type   TEXT        NOT NULL,                     -- send_budget / call / visit / support
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved      BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_at   TIMESTAMPTZ
);

-- Índice para obtener rápido las pendientes
CREATE INDEX IF NOT EXISTS idx_pending_actions_resolved ON pending_actions(resolved) WHERE resolved = FALSE;
CREATE INDEX IF NOT EXISTS idx_pending_actions_created  ON pending_actions(created_at DESC);

ALTER TABLE pending_actions ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  pending_actions IS 'Acciones que Ricardo debe tomar: enviar presupuesto, llamar, visitar, soporte';
COMMENT ON COLUMN pending_actions.action_type IS 'Tipo: send_budget, call, visit, support';


-- ─── TABLA: agenda_events ─────────────────────────────────────────────────────
-- Agenda personal de Ricardo (visitas, instalaciones, reuniones, etc.)

CREATE TABLE IF NOT EXISTS agenda_events (
  id               BIGSERIAL   PRIMARY KEY,
  title            TEXT        NOT NULL,
  description      TEXT,
  date_time        TIMESTAMPTZ NOT NULL,
  duration_minutes INTEGER     NOT NULL DEFAULT 60,
  location         TEXT,
  event_type       TEXT        NOT NULL DEFAULT 'reunion'
                               CHECK (event_type IN (
                                 'visita', 'instalacion', 'reunion',
                                 'llamada', 'recordatorio', 'tramite', 'otro'
                               )),
  contact_name     TEXT,                                  -- Nombre de la persona con quien es
  contact_phone    TEXT,                                  -- Su número si se conoce
  status           TEXT        NOT NULL DEFAULT 'pendiente'
                               CHECK (status IN ('pendiente', 'completado', 'cancelado')),
  reminder_sent    BOOLEAN     NOT NULL DEFAULT FALSE,    -- Ya se envió el recordatorio?
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Índices para consultas de agenda
CREATE INDEX IF NOT EXISTS idx_agenda_events_date_time    ON agenda_events(date_time);
CREATE INDEX IF NOT EXISTS idx_agenda_events_status       ON agenda_events(status) WHERE status = 'pendiente';
CREATE INDEX IF NOT EXISTS idx_agenda_events_reminder     ON agenda_events(reminder_sent, date_time)
  WHERE status = 'pendiente' AND reminder_sent = FALSE;

ALTER TABLE agenda_events ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE  agenda_events IS 'Agenda personal de Ricardo Sarti (visitas, instalaciones, reuniones)';
COMMENT ON COLUMN agenda_events.event_type IS 'visita = visita técnica, instalacion = día de obra, reunion = meeting, llamada, recordatorio, tramite, otro';
COMMENT ON COLUMN agenda_events.reminder_sent IS 'True cuando ya se envió el recordatorio de WhatsApp 1 hora antes';
COMMENT ON COLUMN agenda_events.duration_minutes IS 'Duración en minutos. Instalaciones = 480 (8hs). Visitas = 90. Reuniones = 60.';


-- ─── TABLA: agenda_messages ───────────────────────────────────────────────────
-- Historial de conversación de Ricardo con su asistente de agenda

CREATE TABLE IF NOT EXISTS agenda_messages (
  id        BIGSERIAL   PRIMARY KEY,
  role      TEXT        NOT NULL CHECK (role IN ('user', 'assistant')),
  content   TEXT        NOT NULL,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agenda_messages_timestamp ON agenda_messages(timestamp DESC);

ALTER TABLE agenda_messages ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE agenda_messages IS 'Historial de conversación entre Ricardo y el agente de agenda personal';


-- ─── VISTAS ÚTILES ────────────────────────────────────────────────────────────

-- Vista: leads activos con su último mensaje
CREATE OR REPLACE VIEW vw_active_leads AS
  SELECT
    c.id,
    c.phone,
    c.name,
    c.label,
    c.stage,
    c.product_interest,
    c.locality,
    c.bill_received,
    c.roof_type,
    c.connection_type,
    c.first_contact,
    c.last_contact,
    c.notified_ricardo,
    (
      SELECT content FROM messages m
      WHERE m.contact_phone = c.phone
      ORDER BY m.timestamp DESC LIMIT 1
    ) AS last_message
  FROM contacts c
  WHERE c.label NOT IN ('No interesado')
  ORDER BY c.last_contact DESC;

COMMENT ON VIEW vw_active_leads IS 'Leads activos con su último mensaje. Excluye los marcados como No interesado.';

-- Vista: agenda de hoy y mañana
CREATE OR REPLACE VIEW vw_agenda_today AS
  SELECT *
  FROM agenda_events
  WHERE date(date_time AT TIME ZONE 'America/Argentina/Buenos_Aires')
          BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '1 day'
    AND status = 'pendiente'
  ORDER BY date_time;

COMMENT ON VIEW vw_agenda_today IS 'Eventos de hoy y mañana pendientes de Ricardo';

-- Vista: resumen de leads por etiqueta
CREATE OR REPLACE VIEW vw_leads_by_label AS
  SELECT
    label,
    COUNT(*) AS total,
    COUNT(*) FILTER (WHERE bill_received = TRUE)  AS with_bill,
    COUNT(*) FILTER (WHERE notified_ricardo = TRUE) AS notified
  FROM contacts
  GROUP BY label
  ORDER BY total DESC;

COMMENT ON VIEW vw_leads_by_label IS 'Resumen de leads agrupados por etiqueta comercial';


-- ─── POLÍTICAS RLS (backend-only con service_role) ───────────────────────────
-- El backend Node.js usa la service_role key → acceso total
-- Si en el futuro hay un dashboard web con usuarios, agregar políticas más específicas

-- contacts
CREATE POLICY "service_role_all" ON contacts
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- messages
CREATE POLICY "service_role_all" ON messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- pending_actions
CREATE POLICY "service_role_all" ON pending_actions
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- agenda_events
CREATE POLICY "service_role_all" ON agenda_events
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- agenda_messages
CREATE POLICY "service_role_all" ON agenda_messages
  FOR ALL TO service_role USING (true) WITH CHECK (true);


-- ─── DATOS DE EJEMPLO (comentado, descomentar para testing) ──────────────────

/*
INSERT INTO contacts (phone, name, label, stage, product_interest, locality)
VALUES
  ('5491100000001', 'Test Cliente', 'Interesado', 'en_contacto', 'plan_alquiler', 'Palermo'),
  ('5491100000002', 'Test Empresa', 'Plan comercial', 'en_contacto', 'compra_directa', 'Caballito');

INSERT INTO agenda_events (title, date_time, event_type, location, contact_name)
VALUES
  ('Visita técnica - Test', NOW() + INTERVAL '2 hours', 'visita', 'Palermo, CABA', 'Test Cliente'),
  ('Instalación - Test', NOW() + INTERVAL '1 day', 'instalacion', 'Caballito, CABA', 'Test Empresa');
*/
