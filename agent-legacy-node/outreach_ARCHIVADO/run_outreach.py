#!/usr/bin/env python3
"""
outreach/run_outreach.py
Runner de outreach en Python — reemplaza Node.js cuando better-sqlite3
no puede correr en Linux (binario compilado para Windows).

Uso:
  python3 outreach/run_outreach.py            → envíos reales
  python3 outreach/run_outreach.py --dry-run  → simula sin enviar
"""

import os
import sys
import re
import json
import sqlite3
import smtplib
import time
import requests
from datetime import datetime, date
from pathlib import Path
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from dotenv import load_dotenv

# ── Setup ──────────────────────────────────────────────────────────────────────

PROJECT_DIR = Path(__file__).resolve().parent.parent
os.chdir(PROJECT_DIR)
load_dotenv(PROJECT_DIR / '.env')

DB_PATH           = os.getenv('DB_PATH', str(PROJECT_DIR / 'data' / 'solarpower.db'))
DAILY_LIMIT       = int(os.getenv('DAILY_EMAIL_LIMIT', '20'))
SEND_DELAY        = int(os.getenv('DELAY_BETWEEN_SENDS_MS', '35000')) / 1000
PERPLEXITY_API_KEY = os.getenv('PERPLEXITY_API_KEY')
GMAIL_USER        = os.getenv('GMAIL_USER')
GMAIL_APP_PASSWORD = os.getenv('GMAIL_APP_PASSWORD')
DRY_RUN           = '--dry-run' in sys.argv

PENDING_THRESHOLD = 50  # no buscar en Perplexity si hay más de este número pendientes

RUBRO_PRIORITY = {
    'frigoríficos y plantas de frío industrial':        1,
    'galpones logísticos y centros de distribución':    2,
    'supermercados y mayoristas':                       3,
    'industrias alimenticias y de bebidas':             4,
    'plantas industriales y fábricas':                  5,
    'metalúrgicas y talleres industriales grandes':     6,
    'viveros y establecimientos de jardinería comercial': 7,
    'colegios y universidades privadas grandes':        8,
    'gimnasios y clubes deportivos grandes':            9,
}

# ── DB ─────────────────────────────────────────────────────────────────────────

def get_db():
    # Copy DB to local /tmp to avoid Windows filesystem I/O issues, then work on copy
    # After writing, copy back.
    db_src = Path(DB_PATH)
    db_tmp = Path('/tmp/solarpower_outreach.db')
    import shutil
    shutil.copy2(db_src, db_tmp)
    conn = sqlite3.connect(str(db_tmp))
    conn.row_factory = sqlite3.Row
    # Ensure outreach tables exist
    conn.execute("""
        CREATE TABLE IF NOT EXISTS outreach_leads (
            id               INTEGER PRIMARY KEY AUTOINCREMENT,
            nombre           TEXT NOT NULL,
            rubro            TEXT,
            zona             TEXT,
            email            TEXT,
            whatsapp         TEXT,
            contacto_nombre  TEXT,
            sitio_web        TEXT,
            fuente           TEXT,
            canal_envio      TEXT,
            estado           TEXT DEFAULT 'pendiente',
            email_asunto     TEXT,
            mensaje_cuerpo   TEXT,
            fecha_encontrado TEXT,
            fecha_enviado    TEXT,
            notas            TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS outreach_searches (
            id                   INTEGER PRIMARY KEY AUTOINCREMENT,
            zona                 TEXT NOT NULL,
            rubro                TEXT NOT NULL,
            fecha_busqueda       TEXT NOT NULL,
            empresas_encontradas INTEGER DEFAULT 0
        )
    """)
    try:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_searches_zona_rubro ON outreach_searches(zona, rubro)")
    except Exception:
        pass
    try:
        conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_outreach_email ON outreach_leads(email) WHERE email IS NOT NULL AND email != ''")
    except Exception:
        pass
    conn.commit()
    return conn, db_src, db_tmp

def flush_db(conn, db_src, db_tmp):
    """Write tmp DB back to Windows filesystem."""
    import shutil
    conn.close()
    shutil.copy2(db_tmp, db_src)

def count_sent_today(conn):
    row = conn.execute(
        "SELECT COUNT(*) as cnt FROM outreach_leads WHERE estado='enviado' AND date(fecha_enviado)=date('now')"
    ).fetchone()
    return row['cnt'] if row else 0

def get_pending_leads(conn, limit=9999):
    rows = conn.execute(
        "SELECT * FROM outreach_leads WHERE estado='pendiente' AND fecha_enviado IS NULL"
    ).fetchall()
    rows = [dict(r) for r in rows]
    rows.sort(key=lambda r: RUBRO_PRIORITY.get(r.get('rubro') or '', 99))
    return rows[:limit]

def get_lead_by_email(conn, email):
    if not email:
        return None
    return conn.execute("SELECT * FROM outreach_leads WHERE email=?", (email,)).fetchone()

def save_lead(conn, lead):
    today = date.today().isoformat()
    try:
        conn.execute("""
            INSERT INTO outreach_leads
              (nombre, rubro, zona, email, whatsapp, contacto_nombre, sitio_web, fuente, fecha_encontrado)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, (
            lead.get('nombre'), lead.get('rubro'), lead.get('zona'),
            lead.get('email') or None, lead.get('whatsapp') or None,
            lead.get('contacto_nombre') or None, lead.get('sitio_web') or None,
            lead.get('fuente') or None, lead.get('fecha_encontrado', today)
        ))
        conn.commit()
        return conn.execute("SELECT last_insert_rowid()").fetchone()[0]
    except sqlite3.IntegrityError:
        return None

def update_lead(conn, lead_id, estado, **extras):
    # CRÍTICO: bloquear reset a 'pendiente' si ya fue enviado
    if estado == 'pendiente':
        existing = conn.execute("SELECT fecha_enviado FROM outreach_leads WHERE id=?", (lead_id,)).fetchone()
        if existing and existing['fecha_enviado']:
            print(f"[db] BLOQUEADO: reset de id={lead_id} que ya fue enviado")
            return

    fields = {'estado': estado}
    fields.update(extras)
    if estado == 'enviado' and 'fecha_enviado' not in fields:
        fields['fecha_enviado'] = datetime.now().strftime('%Y-%m-%d %H:%M:%S')

    set_clause = ', '.join(f"{k}=?" for k in fields)
    values = list(fields.values()) + [lead_id]
    conn.execute(f"UPDATE outreach_leads SET {set_clause} WHERE id=?", values)
    conn.commit()

def get_search(conn, zona, rubro):
    return conn.execute(
        "SELECT * FROM outreach_searches WHERE zona=? AND rubro=?", (zona, rubro)
    ).fetchone()

def save_search(conn, zona, rubro, count):
    fecha = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    conn.execute("""
        INSERT INTO outreach_searches (zona, rubro, fecha_busqueda, empresas_encontradas)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(zona, rubro) DO UPDATE SET
          fecha_busqueda=excluded.fecha_busqueda,
          empresas_encontradas=excluded.empresas_encontradas
    """, (zona, rubro, fecha, count))
    conn.commit()

# ── Templates ──────────────────────────────────────────────────────────────────

def get_asunto(lead):
    rubro = (lead.get('rubro') or '').lower()
    zona  = lead.get('zona') or 'GBA Norte'
    if re.search(r'frigor|fr[ií]o|c[aá]mara', rubro):
        return '¿Cuánto pagás de luz en tus cámaras de frío? Podemos ayudarte a reducirlo'
    if re.search(r'galp[oó]n|log[íi]stic|distribuci', rubro):
        return f'Sistema solar para tu galpón en {zona} — propuesta a medida sin compromiso'
    if re.search(r'supermercado|mayorista', rubro):
        return 'Reducí la factura eléctrica de tu comercio con energía solar'
    if re.search(r'industria|f[áa]brica|aliment|bebida|pl[áa]nta', rubro):
        return f'Energía solar para industrias en {zona} — evaluación gratuita'
    if re.search(r'metal[úu]rg|taller', rubro):
        return f'Energía solar para industrias en {zona} — evaluación gratuita'
    if re.search(r'vivero|jardiner', rubro):
        return 'Sistema solar para tu vivero — cuota fija, ahorro desde el primer mes'
    return f'Energía solar para empresas en {zona} — propuesta personalizada'

def describir(rubro):
    r = (rubro or '').lower()
    if re.search(r'frigor|fr[ií]o|c[aá]mara', r):
        return 'mantener cámaras de frío en funcionamiento continuo'
    if re.search(r'galp[oó]n|log[íi]stic|distribuci', r):
        return 'operar un galpón o centro de distribución de alta actividad'
    if re.search(r'supermercado|mayorista', r):
        return 'mantener refrigeración, iluminación y cajas funcionando todo el día'
    if re.search(r'industria|f[áa]brica|aliment|bebida', r):
        return 'sostener una planta industrial con consumo eléctrico elevado'
    if re.search(r'metal[úu]rg|taller', r):
        return 'operar maquinaria y equipos industriales de alto consumo'
    if re.search(r'vivero|jardiner', r):
        return 'mantener riego, iluminación y climatización en producción vegetal'
    if re.search(r'colegio|universidad', r):
        return 'sostener la operación de una institución educativa de gran escala'
    if re.search(r'gimnasio|club', r):
        return 'mantener iluminación, climatización y equipos deportivos activos'
    return 'sostener la operación con consumo eléctrico significativo'

def get_saludo(lead):
    if lead.get('contacto_nombre'):
        return lead['contacto_nombre']
    return f"equipo de {lead['nombre']}"

def get_email_content(lead):
    asunto = get_asunto(lead)
    cuerpo = f"""Hola {get_saludo(lead)},

Somos SolarPower, instalamos sistemas fotovoltaicos para industrias y comercios en GBA Norte.

Viendo el tipo de operación que tienen — {describir(lead.get('rubro'))} — es muy probable que la factura eléctrica sea uno de sus costos fijos más importantes.

Tenemos dos opciones para empresas del sector:

→ Plan SolarPower: inversión inicial accesible más cuota mensual fija en uvas. El ahorro neto en el gasto eléctrico total (cuota + nueva factura reducida) puede llegar al 30-50%. El sistema es nuestro, el ahorro es de ustedes.

→ Compra con financiamiento bancario: el sistema queda de su propiedad desde el primer día.

Para evaluar si aplican a nuestro plan comercial y armar una propuesta a medida, necesitamos que nos manden:

• Foto o PDF de la factura de luz más reciente
• Tipo de techo (chapa, losa, teja u otro)
• Tipo de conexión (monofásica o trifásica)
• Localidad

Con eso les enviamos números concretos, sin ningún compromiso de su parte.

Saludos,
Ricardo
SolarPower Energy
WhatsApp: +54 9 11 3458-3958

---
Si no querés recibir más información, respondé este email y te damos de baja."""

    return asunto, cuerpo

# ── Perplexity Search ──────────────────────────────────────────────────────────

RUBROS = [
    'frigoríficos y plantas de frío industrial',
    'galpones logísticos y centros de distribución',
    'supermercados y mayoristas',
    'industrias alimenticias y de bebidas',
    'plantas industriales y fábricas',
    'metalúrgicas y talleres industriales grandes',
    'viveros y establecimientos de jardinería comercial',
    'colegios y universidades privadas grandes',
    'gimnasios y clubes deportivos grandes',
]

ZONAS = [
    'Tigre', 'San Isidro', 'San Fernando', 'Vicente López', 'Olivos',
    'Martínez', 'Pilar', 'Escobar', 'Campana', 'Zárate', 'General Pacheco',
]

DAYS_RECHECK = 14

def run_search(conn):
    all_empresas = []
    search_count = 0

    for zona in ZONAS:
        for rubro in RUBROS:
            search_rec = get_search(conn, zona, rubro)
            if search_rec:
                fecha_dt = datetime.strptime(search_rec['fecha_busqueda'][:10], '%Y-%m-%d').date()
                if (date.today() - fecha_dt).days < DAYS_RECHECK:
                    continue

            query = (
                f"Listado de empresas de {rubro} ubicadas en {zona}, Gran Buenos Aires, Argentina. "
                f"Para cada empresa incluir: nombre completo, email de contacto oficial y sitio web. "
                f"Solo empresas reales y verificables."
            )

            try:
                resp = requests.post(
                    'https://api.perplexity.ai/chat/completions',
                    headers={
                        'Authorization': f'Bearer {PERPLEXITY_API_KEY}',
                        'Content-Type': 'application/json',
                    },
                    json={
                        'model': 'sonar',
                        'messages': [
                            {
                                'role': 'system',
                                'content': (
                                    'Eres un asistente de investigación empresarial. '
                                    'Responde ÚNICAMENTE con un JSON array válido. '
                                    'Sin texto extra, sin markdown, solo el JSON.'
                                )
                            },
                            {
                                'role': 'user',
                                'content': (
                                    query +
                                    '\n\nFormato de respuesta (JSON array):\n'
                                    '[{"nombre":"Empresa SA","email":"info@empresa.com.ar","sitio_web":"www.empresa.com.ar"}]'
                                )
                            }
                        ],
                        'max_tokens': 2000,
                    },
                    timeout=30
                )

                if resp.status_code == 200:
                    content = resp.json()['choices'][0]['message']['content']
                    json_match = re.search(r'\[.*\]', content, re.DOTALL)
                    if json_match:
                        empresas = json.loads(json_match.group())
                        con_email = [
                            e for e in empresas
                            if e.get('email') and '@' in e.get('email', '')
                        ]
                        for emp in con_email:
                            emp['rubro'] = rubro
                            emp['zona'] = zona
                            emp['fuente'] = 'perplexity'
                        all_empresas.extend(con_email)
                        save_search(conn, zona, rubro, len(con_email))
                        search_count += 1
                        print(f"  [search] {zona}/{rubro[:30]}: {len(con_email)} con email")

                time.sleep(1)

            except Exception as e:
                print(f"  [search] Error {zona}/{rubro[:20]}: {e}")

    print(f"[outreach] Búsqueda completada: {search_count} combinaciones, {len(all_empresas)} empresas")
    return all_empresas

# ── Email Sender ───────────────────────────────────────────────────────────────

def send_email(to_addr, subject, body):
    msg = MIMEMultipart()
    msg['From']    = f'"SolarPower" <{GMAIL_USER}>'
    msg['To']      = to_addr
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain', 'utf-8'))

    server = smtplib.SMTP('smtp.gmail.com', 587)
    server.ehlo()
    server.starttls()
    server.login(GMAIL_USER, GMAIL_APP_PASSWORD)
    server.sendmail(GMAIL_USER, to_addr, msg.as_string())
    server.quit()

# ── Main ───────────────────────────────────────────────────────────────────────

def main():
    if DRY_RUN:
        print('[outreach] === MODO DRY-RUN — no se enviará nada ===')
    print(f'[outreach] Iniciando — {datetime.now().strftime("%d/%m/%Y %H:%M:%S")}')

    if not GMAIL_USER or not GMAIL_APP_PASSWORD:
        print('[outreach] ERROR: Faltan GMAIL_USER / GMAIL_APP_PASSWORD en .env')
        sys.exit(1)

    conn, db_src, db_tmp = get_db()

    try:
        # ── 1. Verificar límite diario ─────────────────────────────────────────
        ya_enviados = count_sent_today(conn)
        if ya_enviados >= DAILY_LIMIT:
            print(f'[outreach] Límite diario alcanzado ({ya_enviados}/{DAILY_LIMIT}). Saliendo.')
            return

        limite_disponible = DAILY_LIMIT - ya_enviados
        print(f'[outreach] Enviados hoy: {ya_enviados}/{DAILY_LIMIT} | Disponible: {limite_disponible}')

        # ── 2. Perplexity (solo si hay menos de 50 pendientes) ────────────────
        todos_pendientes = get_pending_leads(conn)
        empresas = []

        if len(todos_pendientes) >= PENDING_THRESHOLD:
            print(f'[outreach] {len(todos_pendientes)} leads pendientes — omitiendo búsqueda Perplexity')
        else:
            if not PERPLEXITY_API_KEY:
                print('[outreach] WARN: sin PERPLEXITY_API_KEY, saltando búsqueda')
            else:
                print('[outreach] Buscando con Perplexity...')
                empresas = run_search(conn)

        # ── 3. Guardar nuevos leads ────────────────────────────────────────────
        nuevas = 0
        for emp in empresas:
            if emp.get('email') and get_lead_by_email(conn, emp['email']):
                continue
            if save_lead(conn, emp):
                nuevas += 1
        if nuevas:
            print(f'[outreach] Leads nuevos guardados: {nuevas}')

        # ── 4. Traer pendientes para enviar ────────────────────────────────────
        # Traemos todos los pendientes para saltear los sin email y completar el límite
        pendientes = get_pending_leads(conn)
        print(f'[outreach] Leads pendientes disponibles: {len(pendientes)}')

        # ── 5. Enviar ──────────────────────────────────────────────────────────
        enviados  = []
        errores   = []

        for lead in pendientes:
            # Guardia: nunca re-enviar
            if lead.get('fecha_enviado'):
                print(f"[outreach] SKIP: {lead['nombre']} — ya enviado")
                continue

            # Re-verificar límite
            if count_sent_today(conn) >= DAILY_LIMIT:
                print('[outreach] Límite diario alcanzado en el loop. Deteniendo.')
                break

            # Solo canal email
            if not lead.get('email'):
                update_lead(conn, lead['id'], 'descartado', notas='sin email')
                print(f"[outreach] DESCARTADO: {lead['nombre']} (sin email)")
                continue

            asunto, cuerpo = get_email_content(lead)

            if DRY_RUN:
                print(f"[DRY-RUN] EMAIL → {lead['nombre']} <{lead['email']}>")
                print(f"  Asunto: {asunto}")
                enviados.append(lead)
            else:
                try:
                    send_email(lead['email'], asunto, cuerpo)
                    update_lead(conn, lead['id'], 'enviado',
                                canal_envio='email',
                                email_asunto=asunto,
                                mensaje_cuerpo=cuerpo)
                    enviados.append(lead)
                    print(f"[outreach] ✓ EMAIL → {lead['nombre']} <{lead['email']}>")
                    time.sleep(SEND_DELAY)
                except Exception as e:
                    update_lead(conn, lead['id'], 'rebotado', notas=str(e))
                    errores.append({'lead': lead, 'error': str(e)})
                    print(f"[outreach] ✗ ERROR ({lead['nombre']}): {e}")

        # ── 6. Reporte ─────────────────────────────────────────────────────────
        pendientes_restantes = get_pending_leads(conn)
        now_str  = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        today_str = date.today().strftime('%Y-%m-%d')

        report_dir = PROJECT_DIR / 'outreach' / 'reports'
        report_dir.mkdir(parents=True, exist_ok=True)
        report_path = report_dir / f'outreach_{today_str}.txt'

        lines = [
            f'SESIÓN OUTREACH — {now_str}',
            '==================================',
            f'Empresas encontradas por Perplexity: {len(empresas)}',
            f'Leads nuevos guardados: {nuevas}',
            f'Enviados hoy: {len(enviados)} / {DAILY_LIMIT}',
            f'  Por email: {len(enviados)}',
            f'Pendientes para mañana: {len(pendientes_restantes)}',
            f'Errores: {len(errores)}',
            '',
            'ENVIADOS:',
        ]
        for e in enviados:
            lines.append(f"{e['nombre']} | {e.get('email','-')} | email | {e.get('rubro','-')} | {e.get('zona','-')}")

        if errores:
            lines += ['', 'ERRORES:']
            for err_info in errores:
                lines.append(f"{err_info['lead']['nombre']} | {err_info['error']}")

        lines += ['', 'PENDIENTES PARA MAÑANA:']
        for p in pendientes_restantes[:60]:
            contacto = p.get('email') or p.get('whatsapp') or '-'
            lines.append(f"{p['nombre']} | {contacto} | - | {p.get('rubro','-')} | {p.get('zona','-')}")

        report_text = '\n'.join(lines) + '\n'
        report_path.write_text(report_text, encoding='utf-8')
        print(f'[outreach] Reporte guardado: {report_path}')
        print(f'[outreach] ✅ Sesión completada. Enviados: {len(enviados)} | Errores: {len(errores)} | Pendientes: {len(pendientes_restantes)}')

    finally:
        # Siempre copiar DB de vuelta al filesystem de Windows
        flush_db(conn, db_src, db_tmp)
        print('[outreach] DB sincronizada.')

if __name__ == '__main__':
    main()
