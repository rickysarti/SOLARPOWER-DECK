-- ============================================================
-- SolarPower WhatsApp Bot — tablas adicionales en Supabase
-- Ejecutar en Supabase SQL Editor
-- ============================================================

-- ── CONTACTOS DE WHATSAPP ─────────────────────────────────────

CREATE TABLE IF NOT EXISTS chatbot_wa_contacts (
    phone             TEXT PRIMARY KEY,
    name              TEXT,
    label             TEXT DEFAULT 'Interesado',
    stage             TEXT DEFAULT 'nuevo',
    bill_received     BOOLEAN DEFAULT false,
    roof_type         TEXT,
    connection_type   TEXT,
    locality          TEXT,
    product_interest  TEXT,
    human_mode        BOOLEAN DEFAULT false,
    notified_ricardo  BOOLEAN DEFAULT false,
    notes             TEXT,
    first_contact     TIMESTAMPTZ DEFAULT now(),
    last_contact      TIMESTAMPTZ DEFAULT now(),
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── EVENTOS DE AGENDA ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chatbot_agenda_events (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    sqlite_id        INTEGER UNIQUE,
    google_event_id  TEXT,
    title            TEXT NOT NULL,
    description      TEXT,
    date_time        TIMESTAMPTZ NOT NULL,
    duration_minutes INTEGER DEFAULT 60,
    location         TEXT,
    event_type       TEXT DEFAULT 'reunion',
    contact_name     TEXT,
    contact_phone    TEXT,
    status           TEXT DEFAULT 'pendiente',
    reminder_sent    BOOLEAN DEFAULT false,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── ACCIONES PENDIENTES ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS chatbot_pending_actions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    contact_phone  TEXT NOT NULL,
    contact_name   TEXT,
    action_type    TEXT NOT NULL,
    description    TEXT,
    resolved       BOOLEAN DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── INDEXES ───────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_chatbot_wa_contacts_label
    ON chatbot_wa_contacts (label);

CREATE INDEX IF NOT EXISTS idx_chatbot_wa_contacts_last_contact
    ON chatbot_wa_contacts (last_contact DESC);

CREATE INDEX IF NOT EXISTS idx_chatbot_agenda_events_date
    ON chatbot_agenda_events (date_time DESC);

CREATE INDEX IF NOT EXISTS idx_chatbot_pending_actions_phone
    ON chatbot_pending_actions (contact_phone, created_at DESC);

-- ── TRIGGER updated_at ────────────────────────────────────────

DROP TRIGGER IF EXISTS trg_chatbot_wa_contacts_updated_at ON chatbot_wa_contacts;
CREATE TRIGGER trg_chatbot_wa_contacts_updated_at
    BEFORE UPDATE ON chatbot_wa_contacts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS trg_chatbot_agenda_events_updated_at ON chatbot_agenda_events;
CREATE TRIGGER trg_chatbot_agenda_events_updated_at
    BEFORE UPDATE ON chatbot_agenda_events
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ── RLS ───────────────────────────────────────────────────────

ALTER TABLE chatbot_wa_contacts    ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_agenda_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE chatbot_pending_actions ENABLE ROW LEVEL SECURITY;
