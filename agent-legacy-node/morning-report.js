#!/usr/bin/env node
'use strict';

/**
 * morning-report.js
 * Genera y envía por WhatsApp el resumen matutino de los sistemas SolarPower.
 *
 * Uso:
 *   node morning-report.js
 *
 * Incluye:
 *   • Producción total del día anterior (kWh por sistema y total)
 *   • Estado de cada sistema (online / offline / sin datos)
 *   • Alarmas activas
 *   • Estado del UVA
 *   • Estado general del backend de monitoreo
 */

// ─── Cargar .env del solarpower-agent ───────────────────────────────────────
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Credenciales de Supabase (están también en solarpower-agent/.env)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY;
const REPORT_RECIPIENTS = (process.env.MORNING_REPORT_PHONES || '5491144350180,5491144140267')
  .split(',').map(p => p.trim()).filter(Boolean);

const { createClient } = require('@supabase/supabase-js');
const sendpulse = require('./sendpulse');
const logger = require('./logger');

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers de fecha ────────────────────────────────────────────────────────

function argentinaDate(offsetDays = 0) {
  const d = new Date();
  d.setTime(d.getTime() + offsetDays * 86400000);
  // UTC-3
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000;
  const arMs  = utcMs - 3 * 3600000;
  const ar    = new Date(arMs);
  return ar.toISOString().split('T')[0]; // YYYY-MM-DD
}

function minutesAgo(isoString) {
  if (!isoString) return Infinity;
  return Math.round((Date.now() - new Date(isoString).getTime()) / 60000);
}

function formatKwh(n) {
  if (n == null || isNaN(n)) return '—';
  return n.toFixed(1) + ' kWh';
}

// ─── Consultas a Supabase ────────────────────────────────────────────────────

async function getSystems() {
  const { data, error } = await supabase
    .from('newapp_systems')
    .select('id, name, brand, api_brand, capacity_kw, is_active, polling_enabled')
    .eq('is_active', true)
    .order('name');
  if (error) throw new Error(`getSystems: ${error.message}`);
  return data || [];
}

async function getYesterdayProduction(systemIds) {
  const ayer = argentinaDate(-1);
  const { data, error } = await supabase
    .from('newapp_daily_energy')
    .select('system_id, total_kwh, peak_power_w, reading_count')
    .eq('date', ayer)
    .in('system_id', systemIds);
  if (error) throw new Error(`getYesterdayProduction: ${error.message}`);
  // Indexar por system_id
  const map = {};
  for (const row of (data || [])) map[row.system_id] = row;
  return map;
}

async function getLatestReadings(systemIds) {
  // Últimas lecturas en las últimas 2 horas (si el backend está vivo debe haber al menos 1)
  const twoHoursAgo = new Date(Date.now() - 2 * 3600000).toISOString();
  const { data, error } = await supabase
    .from('newapp_energy_readings')
    .select('system_id, read_at, power_w')
    .in('system_id', systemIds)
    .gte('read_at', twoHoursAgo)
    .order('read_at', { ascending: false });
  if (error) throw new Error(`getLatestReadings: ${error.message}`);

  // Quedarse con la más reciente por sistema
  const map = {};
  for (const row of (data || [])) {
    if (!map[row.system_id]) map[row.system_id] = row;
  }
  return map;
}

async function getActiveAlarms() {
  const { data, error } = await supabase
    .from('newapp_alarms')
    .select('system_id, alarm_type, severity, message, created_at')
    .eq('is_active', true)
    .order('created_at', { ascending: false });
  if (error) throw new Error(`getActiveAlarms: ${error.message}`);
  return data || [];
}

async function getLatestUva() {
  const { data, error } = await supabase
    .from('newapp_uva_values')
    .select('date, value')
    .order('date', { ascending: false })
    .limit(1)
    .single();
  if (error) return null;
  return data;
}

// ─── Formatear mensaje ───────────────────────────────────────────────────────

function buildMessage(systems, prodMap, latestMap, alarms, uva) {
  const hoy     = argentinaDate(0);
  const ayer    = argentinaDate(-1);
  const ahora   = new Date();
  const horaAR  = ((ahora.getUTCHours() - 3 + 24) % 24).toString().padStart(2, '0') + ':' +
                  ahora.getUTCMinutes().toString().padStart(2, '0');

  const lines = [];

  // ── Encabezado ──────────────────────────────────────────────────────────
  lines.push(`☀️ *SolarPower — Reporte matutino ${hoy}*`);
  lines.push(`_Generado a las ${horaAR} hs_`);
  lines.push('');

  // ── Producción ayer ─────────────────────────────────────────────────────
  let totalKwh = 0;
  let sistemasCon = 0;
  for (const s of systems) {
    const prod = prodMap[s.id];
    if (prod && prod.total_kwh) {
      totalKwh += prod.total_kwh;
      sistemasCon++;
    }
  }

  lines.push(`📊 *Producción ayer (${ayer})*`);
  lines.push(`Total: *${totalKwh.toFixed(1)} kWh* en ${sistemasCon}/${systems.length} sistemas`);
  lines.push('');

  // ── Detalle por sistema ──────────────────────────────────────────────────
  const offline = [];
  const sinDatosAyer = [];

  let detalle = '';
  for (const s of systems) {
    const prod    = prodMap[s.id];
    const latest  = latestMap[s.id];
    const kwh     = prod?.total_kwh != null ? formatKwh(prod.total_kwh) : 'sin datos';
    const mins    = minutesAgo(latest?.read_at);
    const estado  = mins <= 20 ? '🟢' : mins <= 60 ? '🟡' : '🔴';

    if (mins > 60) offline.push({ name: s.name, mins });
    if (!prod?.total_kwh) sinDatosAyer.push(s.name);

    detalle += `${estado} ${s.name}: ${kwh}`;
    if (mins <= 120) detalle += ` _(hace ${mins} min)_`;
    detalle += '\n';
  }

  lines.push('📋 *Sistemas:*');
  lines.push(detalle.trim());
  lines.push('');

  // ── Sistemas offline ─────────────────────────────────────────────────────
  if (offline.length > 0) {
    lines.push('🔴 *Sin lectura reciente (>60 min):*');
    for (const o of offline) {
      lines.push(`• ${o.name} (hace ${o.mins >= 120 ? Math.round(o.mins / 60) + 'h' : o.mins + ' min'})`);
    }
    lines.push('');
  }

  // ── Alarmas ──────────────────────────────────────────────────────────────
  if (alarms.length > 0) {
    const critCount = alarms.filter(a => a.severity === 'critical').length;
    const warnCount = alarms.filter(a => a.severity === 'warning').length;
    lines.push(`⚠️ *Alarmas activas: ${alarms.length}* (${critCount} críticas, ${warnCount} warnings)`);
    // Mostrar las primeras 5
    for (const a of alarms.slice(0, 5)) {
      const icon = a.severity === 'critical' ? '🚨' : '⚠️';
      lines.push(`${icon} ${a.alarm_type}: ${a.message}`);
    }
    if (alarms.length > 5) lines.push(`  ...y ${alarms.length - 5} más`);
  } else {
    lines.push('✅ Sin alarmas activas');
  }
  lines.push('');

  // ── UVA ──────────────────────────────────────────────────────────────────
  if (uva) {
    const uvaDate    = uva.date;
    const uvaStale   = uvaDate < ayer;
    const uvaIcon    = uvaStale ? '⚠️' : '✅';
    const uvaValFmt  = Number(uva.value).toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    lines.push(`${uvaIcon} *UVA:* $${uvaValFmt} (al ${uvaDate}${uvaStale ? ' — desactualizado' : ''})`);
  } else {
    lines.push('❓ UVA: sin datos');
  }

  // ── Estado del backend ───────────────────────────────────────────────────
  const allMins = Object.values(latestMap).map(r => minutesAgo(r?.read_at)).filter(m => isFinite(m));
  if (allMins.length > 0) {
    const minRecent = Math.min(...allMins);
    const backendOk = minRecent <= 20;
    lines.push(`${backendOk ? '🟢' : '🔴'} *Backend:* última lectura hace ${minRecent} min`);
  } else {
    lines.push('🔴 *Backend:* sin lecturas recientes (>2 horas)');
  }

  return lines.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  logger.info('[MorningReport] Generando reporte matutino...');

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    logger.error('[MorningReport] Faltan SUPABASE_URL / SUPABASE_SERVICE_KEY en .env');
    process.exit(1);
  }

  try {
    // 1. Datos de Supabase en paralelo
    const systems = await getSystems();
    if (!systems.length) {
      logger.warn('[MorningReport] No hay sistemas activos en Supabase');
      return;
    }

    const systemIds = systems.map(s => s.id);

    const [prodMap, latestMap, alarms, uva] = await Promise.all([
      getYesterdayProduction(systemIds),
      getLatestReadings(systemIds),
      getActiveAlarms(),
      getLatestUva(),
    ]);

    // 2. Construir mensaje
    const msg = buildMessage(systems, prodMap, latestMap, alarms, uva);
    logger.info('[MorningReport] Mensaje generado:\n' + msg);

    // 3. Enviar por WhatsApp
    await sendpulse.initialize();
    for (const phone of REPORT_RECIPIENTS) {
      await sendpulse.sendMessage(phone, msg);
      logger.info(`[MorningReport] ✅ Enviado a ${phone}`);
    }

  } catch (err) {
    logger.error(`[MorningReport] Error: ${err.message}`, { stack: err.stack });
    process.exit(1);
  }
}

main();
