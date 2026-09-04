import { db, runtimeSecret, setting } from "./db.ts";
import { errorMessage } from "./errors.ts";
import { htmlEscape, sanitizePlainText } from "./output.ts";

const TIME_ZONE = "America/Argentina/Buenos_Aires";

function safeCell(value: unknown): string {
  return htmlEscape(sanitizePlainText(String(value ?? "")));
}

function argentinaParts(now: Date): Record<string, string> {
  return Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now).map((part) => [part.type, part.value]),
  );
}

function dateBefore(date: string): string {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

export function utcWindow(reportDate: string): { start: string; end: string } {
  const start = new Date(`${reportDate}T03:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

export function previousArgentinaCalendarDate(now: Date): string {
  const parts = argentinaParts(now);
  return dateBefore(`${parts.year}-${parts.month}-${parts.day}`);
}

function table(headers: string[], rows: string[][]): string {
  if (!rows.length) return "<p>Sin registros.</p>";
  return `<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>${
    headers.map((header) =>
      `<th style="text-align:left;border-bottom:1px solid #ddd;padding:7px">${htmlEscape(header)}</th>`
    ).join("")
  }</tr></thead><tbody>${
    rows.map((row) =>
      `<tr>${
        row.map((cell) =>
          `<td style="vertical-align:top;border-bottom:1px solid #eee;padding:7px">${cell}</td>`
        ).join("")
      }</tr>`
    ).join("")
  }</tbody></table>`;
}

async function reportData(reportDate: string) {
  const { start, end } = utcWindow(reportDate);
  const [contacts, messages, receipts, inbound, jobs, outbound, energy, tasks, files] = await Promise.all([
    db().from("chatbot_wa_contacts")
      .select(
        "phone,name,tipo,tipo_cliente,label,stage,human_mode,locality,province,bill_received,roof_type,connection_type,product_interest,consumo_mensual,consumo_anual,agent_state,last_activity_at",
      )
      .gte("last_activity_at", start).lt("last_activity_at", end).order("last_activity_at").limit(1000),
    db().from("agent_messages").select("contact_phone,role,content,created_at")
      .gte("created_at", start).lt("created_at", end).order("created_at").limit(3000),
    db().from("agent_webhook_receipts").select("outcome,reason,phone,received_at")
      .gte("received_at", start).lt("received_at", end).limit(3000),
    db().from("agent_inbound_events").select("phone,disposition,processing_error,received_at")
      .gte("received_at", start).lt("received_at", end).limit(3000),
    db().from("agent_jobs").select("status,last_error,payload,updated_at")
      .gte("updated_at", start).lt("updated_at", end).limit(1000),
    db().from("agent_outbound_messages").select("phone,status,error,kind,updated_at")
      .gte("updated_at", start).lt("updated_at", end).limit(3000),
    db().from("energy_analysis_jobs").select("phone,status,last_error,triage,result,updated_at")
      .gte("updated_at", start).lt("updated_at", end).limit(1000),
    db().from("crm_tasks").select("titulo,descripcion,estado,prioridad,lead_phone,created_at")
      .gte("created_at", start).lt("created_at", end).limit(1000),
    db().from("crm_lead_files").select("contact_phone,file_name,kind,mime_type,metadata,created_at")
      .gte("created_at", start).lt("created_at", end).limit(1000),
  ]);
  for (const result of [contacts, messages, receipts, inbound, jobs, outbound, energy, tasks, files]) {
    if (result.error) throw result.error;
  }
  return {
    contacts: contacts.data ?? [],
    messages: messages.data ?? [],
    receipts: receipts.data ?? [],
    inbound: inbound.data ?? [],
    jobs: jobs.data ?? [],
    outbound: outbound.data ?? [],
    energy: energy.data ?? [],
    tasks: tasks.data ?? [],
    files: files.data ?? [],
  };
}

async function buildReport(reportDate: string): Promise<{ html: string; summary: Record<string, unknown> }> {
  const data = await reportData(reportDate);
  const latest = new Map<string, { role: string; content: string; created_at: string }>();
  for (const message of data.messages as any[]) latest.set(message.contact_phone, message);
  const crmBase = (await setting("crm_base_url")) ?? "https://solarpower.com.ar/admin/crm/leads";
  const leadRows = (data.contacts as any[]).map((contact) => {
    const last = latest.get(contact.phone);
    const state = contact.agent_state && typeof contact.agent_state === "object" ? contact.agent_state : {};
    const missing = Array.isArray(state.missing_fields) ? state.missing_fields.join(", ") : "";
    const detail = [
      contact.product_interest && `Interés: ${contact.product_interest}`,
      contact.locality && `Localidad: ${contact.locality}${contact.province ? `, ${contact.province}` : ""}`,
      contact.bill_received && "Factura recibida",
      contact.consumo_mensual && `Consumo mensual: ${contact.consumo_mensual} kWh`,
      contact.roof_type && `Superficie: ${contact.roof_type}`,
      contact.connection_type && `Conexión: ${contact.connection_type}`,
      missing && `Falta: ${missing}`,
    ].filter(Boolean).map(safeCell).join("<br>");
    const leadUrl = `${crmBase.replace(/\/$/, "")}/${encodeURIComponent(contact.phone)}`;
    return [
      `<a href="${htmlEscape(leadUrl)}">${safeCell(contact.name || contact.phone)}</a><br>${
        safeCell(contact.phone)
      }`,
      `${safeCell(contact.tipo || contact.tipo_cliente || "sin clasificar")}<br>${
        safeCell(contact.stage || "sin etapa")
      }<br>${contact.human_mode ? "Modo humano" : "Bot activo"}`,
      detail || "Sin datos técnicos nuevos",
      last
        ? `${safeCell(last.role === "user" ? "Cliente" : "Tomás")}: ${
          safeCell(String(last.content).slice(0, 280))
        }`
        : "Sin mensajes guardados",
    ];
  });
  const taskRows = (data.tasks as any[]).map((task) => [
    safeCell(task.titulo),
    safeCell(task.lead_phone || "sin teléfono"),
    safeCell(`${task.estado} / ${task.prioridad}`),
    safeCell(task.descripcion || ""),
  ]);
  const energyRows = (data.energy as any[]).map((job) => [
    safeCell(job.phone),
    safeCell(job.status),
    safeCell(
      job.result?.consumption?.promedioMensual
        ? `${job.result.consumption.promedioMensual} kWh/mes`
        : job.triage?.decision || "",
    ),
    safeCell(job.last_error || ""),
  ]);
  const fileRows = (data.files as any[]).map((file) => [
    safeCell(file.contact_phone || "sin teléfono"),
    safeCell(file.file_name || "archivo"),
    safeCell(file.kind || "sin clasificar"),
    safeCell(
      file.metadata?.energy_analysis_status || (file.metadata?.needs_review ? "needs_review" : "registrado"),
    ),
  ]);
  const incidentRows = [
    ...(data.inbound as any[]).filter((row) => row.disposition && row.disposition !== "responded").map((
      row,
    ) => [
      row.phone,
      "Evento entrante",
      row.disposition,
      row.processing_error || "Sin respuesta automática por la disposición indicada",
    ]),
    ...(data.jobs as any[]).filter((row) => row.status === "failed" || row.last_error).map((row) => [
      row.payload?.phone || "",
      "Trabajo",
      row.status,
      row.last_error || "Reintento programado",
    ]),
    ...(data.outbound as any[]).filter((row) => row.status === "failed").map((row) => [
      row.phone,
      `Salida ${row.kind || ""}`,
      row.status,
      row.error || "Entrega fallida",
    ]),
    ...(data.energy as any[]).filter((row) => ["failed", "needs_review"].includes(row.status)).map((row) => [
      row.phone,
      "Análisis energético",
      row.status,
      row.last_error || "Requiere revisión",
    ]),
  ].slice(0, 1000).map((row) => row.map(safeCell));
  const errors = [
    ...(data.inbound as any[]).filter((row) =>
      row.processing_error || ["failed", "dead_letter"].includes(row.disposition)
    ),
    ...(data.jobs as any[]).filter((row) => row.status === "failed"),
    ...(data.outbound as any[]).filter((row) => row.status === "failed"),
  ];
  const receiptCounts = Object.fromEntries(
    ["accepted", "duplicate", "ignored", "rejected", "error"].map((outcome) => [
      outcome,
      (data.receipts as any[]).filter((row) => row.outcome === outcome).length,
    ]),
  );
  const summary = {
    report_date: reportDate,
    contacts: leadRows.length,
    messages: data.messages.length,
    tasks: taskRows.length,
    energy_jobs: energyRows.length,
    files: fileRows.length,
    incidents: incidentRows.length,
    errors: errors.length,
    webhook_receipts: receiptCounts,
  };
  const html =
    `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;max-width:1100px;margin:0 auto;padding:24px">
<h1 style="font-size:22px">Resumen operativo SolarPower</h1>
<p>Día informado: ${
      htmlEscape(reportDate)
    }. Leads: ${leadRows.length}. Mensajes: ${data.messages.length}. Tareas: ${taskRows.length}. Errores: ${errors.length}.</p>
<h2 style="font-size:18px">Leads y conversaciones</h2>
${table(["Lead", "Clasificación y estado", "Datos", "Último intercambio"], leadRows)}
<h2 style="font-size:18px">Tareas y derivaciones</h2>
${table(["Tarea", "Lead", "Estado", "Detalle"], taskRows)}
<h2 style="font-size:18px">Análisis energéticos</h2>
${table(["Teléfono", "Estado", "Resultado", "Observación"], energyRows)}
<h2 style="font-size:18px">Archivos recibidos</h2>
${table(["Lead", "Archivo", "Clasificación", "Procesamiento"], fileRows)}
<h2 style="font-size:18px">Mensajes sin respuesta e incidentes</h2>
${table(["Lead", "Tipo", "Estado", "Detalle"], incidentRows)}
<h2 style="font-size:18px">Salud operativa</h2>
<p>Webhooks aceptados: ${receiptCounts.accepted}. Duplicados: ${receiptCounts.duplicate}. Ignorados: ${receiptCounts.ignored}. Rechazados: ${receiptCounts.rejected}. Errores de webhook: ${receiptCounts.error}. Fallos operativos: ${errors.length}.</p>
</body></html>`;
  return { html, summary };
}

async function sendReport(report: any): Promise<void> {
  const apiKey = await runtimeSecret("RESEND_API_KEY");
  if (!apiKey) throw new Error("RESEND_API_KEY is not configured for the agent");
  const { html, summary } = await buildReport(report.report_date);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "Idempotency-Key": `solarpower-agent-digest-${report.report_date}`,
    },
    body: JSON.stringify({
      from: "SolarPower <no-reply@solarpower.com.ar>",
      to: [report.recipient],
      subject: sanitizePlainText(report.subject),
      html,
    }),
  });
  const raw = await response.text();
  let result: Record<string, unknown> = {};
  try {
    result = raw ? JSON.parse(raw) : {};
  } catch {
    result = { response: raw.slice(0, 300) };
  }
  if (!response.ok) throw new Error(`Resend ${response.status}: ${raw.slice(0, 400)}`);
  const updated = await db().from("agent_daily_reports").update({
    status: "sent",
    provider_message_id: result.id ?? null,
    summary,
    sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    last_error: null,
  }).eq("id", report.id);
  if (updated.error) throw updated.error;
}

export async function maybeSendDailyReport(
  now = new Date(),
): Promise<{ sent: number; failed: number; skipped: number }> {
  if ((await setting("daily_report_enabled")) !== "true") return { sent: 0, failed: 0, skipped: 1 };
  const parts = argentinaParts(now);
  const hour = Number(parts.hour);
  const configuredHour = Number(await setting("daily_report_hour_ar") ?? "8");
  if (hour < configuredHour) return { sent: 0, failed: 0, skipped: 1 };
  const reportDate = previousArgentinaCalendarDate(now);
  const recipient = (await setting("daily_report_email")) ?? "riki@sarti.com.ar";
  const existing = await db().from("agent_daily_reports").select("*").eq("report_date", reportDate)
    .maybeSingle();
  if (existing.error) throw existing.error;
  let report = existing.data;
  if (!report) {
    const inserted = await db().from("agent_daily_reports").insert({
      report_date: reportDate,
      recipient,
      subject: `Resumen operativo SolarPower - ${reportDate}`,
    }).select("*").single();
    if (inserted.error) throw inserted.error;
    report = inserted.data;
  }
  if (
    report.status === "sent" || new Date(report.available_at).getTime() > now.getTime() ||
    report.attempts >= 5
  ) {
    return { sent: 0, failed: 0, skipped: 1 };
  }
  const locked = await db().from("agent_daily_reports").update({
    status: "processing",
    updated_at: now.toISOString(),
    attempts: Number(report.attempts ?? 0) + 1,
  }).eq("id", report.id).in("status", ["pending", "failed"]).select("*").maybeSingle();
  if (locked.error) throw locked.error;
  if (!locked.data) return { sent: 0, failed: 0, skipped: 1 };
  try {
    await sendReport(locked.data);
    return { sent: 1, failed: 0, skipped: 0 };
  } catch (error) {
    const attempts = Number(locked.data.attempts ?? 1);
    await db().from("agent_daily_reports").update({
      status: "failed",
      last_error: errorMessage(error),
      available_at: new Date(now.getTime() + Math.min(60, 5 * 2 ** attempts) * 60_000).toISOString(),
      updated_at: new Date().toISOString(),
    }).eq("id", report.id);
    console.error("daily report failed", errorMessage(error));
    return { sent: 0, failed: 1, skipped: 0 };
  }
}
