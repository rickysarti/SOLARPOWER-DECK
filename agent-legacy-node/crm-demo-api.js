/**
 * crm-demo-api.js — Demo server con datos de muestra
 * Para testing en local antes de conectar con el SQLite real
 */
const express = require('express');
const cors    = require('cors');
const app     = express();
app.use(cors());
app.use(express.json());

const now = () => new Date().toISOString();
const ago = (days) => new Date(Date.now() - days * 86400000).toISOString();

// ── Mock data ──────────────────────────────────────────────────────────────────
let contacts = [
  { phone:'5491134583958', name:'María González',    label:'Interesado',                       stage:'en_contacto', human_mode:0, locality:'Palermo',        roof_type:'losa',   connection_type:'monofasica', product_interest:'plan_alquiler',    bill_received:1, first_contact:ago(15), last_contact:ago(0.5), notes:'Interesada en paneles para su casa de 3 amb.', notified_ricardo:1, msg_count:12, pending_count:1 },
  { phone:'5491145678901', name:'Juan Pérez',         label:'Pendiente enviar presupuesto',      stage:'en_contacto', human_mode:0, locality:'Caballito',      roof_type:'chapa',  connection_type:'monofasica', product_interest:'compra_directa',   bill_received:1, first_contact:ago(8),  last_contact:ago(1),   notes:'Espera presupuesto urgente', notified_ricardo:1, msg_count:8,  pending_count:2 },
  { phone:'5491156789012', name:'Laura Martínez',    label:'Presupuesto enviado',               stage:'propuesta',   human_mode:0, locality:'Belgrano',       roof_type:'tejas',  connection_type:'trifasica',  product_interest:'plan_bateria',     bill_received:1, first_contact:ago(20), last_contact:ago(2),   notes:'Recibió presupuesto de 12kW', notified_ricardo:1, msg_count:25, pending_count:0 },
  { phone:'5491167890123', name:'Roberto Silva',     label:'Visita programada',                 stage:'propuesta',   human_mode:1, locality:'Núñez',          roof_type:'losa',   connection_type:'trifasica',  product_interest:'plan_alquiler',    bill_received:1, first_contact:ago(10), last_contact:ago(3),   notes:'Visita el martes 8/4. Bot pausado.', notified_ricardo:1, msg_count:18, pending_count:0 },
  { phone:'5491178901234', name:'Ana Rodríguez',     label:'Pendiente enviar presupuesto final', stage:'propuesta',   human_mode:0, locality:'San Telmo',      roof_type:'membrana', connection_type:'monofasica', product_interest:'compra_directa',  bill_received:1, first_contact:ago(25), last_contact:ago(0.1), notes:'Espera versión final del presupuesto', notified_ricardo:1, msg_count:30, pending_count:1 },
  { phone:'5491189012345', name:'Carlos López',      label:'Venta cerrada',                     stage:'cerrado',     human_mode:1, locality:'Vicente López',  roof_type:'losa',   connection_type:'trifasica',  product_interest:'plan_bateria',     bill_received:1, first_contact:ago(45), last_contact:ago(5),   notes:'Venta cerrada, espera instalación', notified_ricardo:1, msg_count:42, pending_count:0 },
  { phone:'5491190123456', name:'Sofía Méndez',      label:'Cliente Solarpower',                stage:'cerrado',     human_mode:1, locality:'Recoleta',       roof_type:'losa',   connection_type:'monofasica', product_interest:'plan_alquiler',    bill_received:1, first_contact:ago(90), last_contact:ago(7),   notes:'Sistema 6kW instalado, funcionando OK', notified_ricardo:1, msg_count:55, pending_count:0 },
  { phone:'5491121345678', name:'Diego Fernández',   label:'Interesado',                        stage:'nuevo',       human_mode:0, locality:'Flores',         roof_type:null,     connection_type:null,          product_interest:'plan_alquiler',    bill_received:0, first_contact:ago(2),  last_contact:ago(0.2), notes:'', notified_ricardo:0, msg_count:4,  pending_count:0 },
  { phone:'5491132456789', name:'Valeria Torres',    label:'Interesado',                        stage:'nuevo',       human_mode:0, locality:'Devoto',         roof_type:'chapa',  connection_type:'monofasica', product_interest:null,               bill_received:0, first_contact:ago(1),  last_contact:ago(0.3), notes:'', notified_ricardo:0, msg_count:6,  pending_count:0 },
];

const messages = {
  '5491134583958': [
    { id:1, contact_phone:'5491134583958', role:'user',      content:'Hola, me interesa instalar paneles solares en mi casa', timestamp:ago(1) },
    { id:2, contact_phone:'5491134583958', role:'assistant', content:'¡Hola María! Soy el asistente de SolarPower 🌞 Me alegra que te interese la energía solar. Para darte un presupuesto preciso, necesito algunos datos. ¿Cuántos ambientes tiene tu casa aproximadamente?', timestamp:ago(1) },
    { id:3, contact_phone:'5491134583958', role:'user',      content:'Tenemos 3 ambientes, en Palermo CABA', timestamp:ago(0.9) },
    { id:4, contact_phone:'5491134583958', role:'assistant', content:'¡Perfecto! Palermo es excelente para paneles. Para calcular el sistema ideal, ¿podrías enviarme una foto de tu última factura de luz? Así veo tu consumo real y te armo un presupuesto a medida 📄', timestamp:ago(0.9) },
    { id:5, contact_phone:'5491134583958', role:'user',      content:'Te mando la foto ahora', timestamp:ago(0.5) },
    { id:6, contact_phone:'5491134583958', role:'assistant', content:'¡Gracias María! Recibí la factura. Tu consumo mensual es de aproximadamente 280 kWh. Te recomendaríamos un sistema de 3kW que cubriría el 80% de tu consumo. Ricardo te va a contactar pronto con el presupuesto detallado 💪', timestamp:ago(0.5) },
  ],
  '5491145678901': [
    { id:7, contact_phone:'5491145678901', role:'user', content:'Buen día, quiero un presupuesto para mi local comercial', timestamp:ago(5) },
    { id:8, contact_phone:'5491145678901', role:'assistant', content:'¡Buen día Juan! Claro, con gusto. Para un local comercial, ¿cuántos kW tiene contratados actualmente?', timestamp:ago(5) },
    { id:9, contact_phone:'5491145678901', role:'user', content:'Tengo trifásica, consumo como 800kWh por mes', timestamp:ago(4) },
    { id:10, contact_phone:'5491145678901', role:'assistant', content:'Perfecto, con ese consumo necesitarías un sistema de entre 8 y 10 kW. ¿Podés enviarme una foto de tu última factura para confirmar el cálculo?', timestamp:ago(4) },
  ],
};

let pendingActions = [
  { id:1, contact_phone:'5491134583958', contact_name:'María González', contact_label:'Interesado', action_type:'send_budget', description:'Enviar presupuesto para sistema 3kW en Palermo', created_at:ago(0.5), resolved:0 },
  { id:2, contact_phone:'5491145678901', contact_name:'Juan Pérez',     contact_label:'Pendiente enviar presupuesto', action_type:'send_budget', description:'Presupuesto urgente sistema 10kW comercial en Caballito', created_at:ago(1), resolved:0 },
  { id:3, contact_phone:'5491178901234', contact_name:'Ana Rodríguez',  contact_label:'Pendiente enviar presupuesto final', action_type:'send_budget', description:'Enviar versión final del presupuesto con descuento acordado', created_at:ago(0.1), resolved:0 },
  { id:4, contact_phone:'5491145678901', contact_name:'Juan Pérez',     contact_label:'Pendiente enviar presupuesto', action_type:'call', description:'Llamar para confirmar visita técnica', created_at:ago(2), resolved:0 },
];

let agendaEvents = [
  { id:1, title:'Visita técnica — Roberto Silva', description:'Revisar instalación en Núñez', date_time:new Date(Date.now() + 2*86400000).toISOString(), duration_minutes:90, location:'Av. del Libertador 3200, Núñez', event_type:'visita', contact_name:'Roberto Silva', contact_phone:'5491167890123', status:'pendiente', reminder_sent:0, google_event_id:'gcal_abc123', created_at:ago(3) },
  { id:2, title:'Instalación — Carlos López',     description:'Sistema 12kW con baterías', date_time:new Date(Date.now() + 5*86400000).toISOString(), duration_minutes:480, location:'Vicente López, San Isidro', event_type:'instalacion', contact_name:'Carlos López', contact_phone:'5491189012345', status:'pendiente', reminder_sent:0, google_event_id:'gcal_def456', created_at:ago(5) },
  { id:3, title:'Reunión con proveedor DEYE',     description:'Revisar nuevos modelos 2025', date_time:new Date(Date.now() + 7*86400000).toISOString(), duration_minutes:60, location:'Zoom', event_type:'reunion', contact_name:null, contact_phone:null, status:'pendiente', reminder_sent:0, google_event_id:null, created_at:ago(2) },
  { id:4, title:'Visita — Valeria Torres',        description:'Evaluar techo chapa en Devoto', date_time:new Date(Date.now() - 1*86400000).toISOString(), duration_minutes:90, location:'Devoto, CABA', event_type:'visita', contact_name:'Valeria Torres', contact_phone:'5491132456789', status:'completado', reminder_sent:1, google_event_id:'gcal_ghi789', created_at:ago(4) },
];

let botPaused = false;
let nextId = 100;

// ── Endpoints ──────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status:'ok', db:'demo-mode', supabase:true, calendar:true }));
app.get('/api/stages', (req, res) => res.json([
  { id:'Interesado', color:'#3B82F6' }, { id:'Pendiente enviar presupuesto', color:'#F59E0B' },
  { id:'Presupuesto enviado', color:'#8B5CF6' }, { id:'Visita programada', color:'#10B981' },
  { id:'Pendiente enviar presupuesto final', color:'#EF4444' }, { id:'Venta cerrada', color:'#059669' },
  { id:'Cliente Solarpower', color:'#F97316' },
]));

app.get('/api/stats', (req, res) => {
  const byLabel = {};
  contacts.forEach(c => { byLabel[c.label] = (byLabel[c.label]||0)+1; });
  res.json({
    total:    contacts.length,
    today:    contacts.filter(c => new Date(c.last_contact) > new Date(Date.now()-86400000)).length,
    paused:   contacts.filter(c => c.human_mode).length,
    pending:  pendingActions.filter(a => !a.resolved).length,
    byLabel:  Object.entries(byLabel).map(([label,n]) => ({label,n})),
    msgToday: 7,
    upcoming: agendaEvents.filter(e => e.status==='pendiente' && new Date(e.date_time) > new Date()).length,
  });
});

app.get('/api/contacts', (req, res) => {
  const { search, label } = req.query;
  let result = [...contacts];
  if (search) { const q=search.toLowerCase(); result=result.filter(c=>(c.name||'').toLowerCase().includes(q)||c.phone.includes(q)); }
  if (label) result=result.filter(c=>c.label===label);
  // Add last_message
  result = result.map(c => ({
    ...c,
    last_message: (messages[c.phone]||[]).slice(-1)[0]?.content || null
  }));
  res.json(result);
});

app.get('/api/contacts/:phone', (req, res) => {
  const c = contacts.find(x=>x.phone===req.params.phone);
  if (!c) return res.status(404).json({error:'Not found'});
  res.json({
    ...c,
    pending_actions: pendingActions.filter(a=>a.contact_phone===req.params.phone),
    agenda_events:   agendaEvents.filter(a=>a.contact_phone===req.params.phone),
  });
});

app.patch('/api/contacts/:phone', (req, res) => {
  const i = contacts.findIndex(x=>x.phone===req.params.phone);
  if (i<0) return res.status(404).json({error:'Not found'});
  contacts[i] = { ...contacts[i], ...req.body, last_contact: now() };
  res.json(contacts[i]);
});

app.get('/api/contacts/:phone/messages', (req, res) => {
  res.json(messages[req.params.phone] || []);
});

app.get('/api/pending-actions', (req, res) => {
  res.json(pendingActions.filter(a=>!a.resolved));
});

app.patch('/api/pending-actions/:id', (req, res) => {
  const a = pendingActions.find(x=>x.id===parseInt(req.params.id));
  if (a) a.resolved = 1;
  res.json({success:true});
});

app.get('/api/agenda', (req, res) => res.json(agendaEvents));

app.post('/api/agenda', (req, res) => {
  const ev = { id:nextId++, status:'pendiente', reminder_sent:0, created_at:now(), google_event_id: req.body.add_to_gcal ? 'gcal_'+Math.random().toString(36).slice(2) : null, ...req.body };
  agendaEvents.push(ev);
  res.json(ev);
});

app.delete('/api/agenda/:id', (req, res) => {
  const ev = agendaEvents.find(x=>x.id===parseInt(req.params.id));
  if (ev) ev.status='cancelado';
  res.json({success:true});
});

app.get('/api/bot/status', (req, res) => res.json({paused:botPaused}));
app.post('/api/bot/pause', (req, res) => { botPaused=!!req.body.paused; res.json({success:true,paused:botPaused}); });
app.get('/api/energy/status', (req, res) => res.json({online:false}));

app.listen(3001, () => console.log('🌞 CRM Demo API running on http://localhost:3001'));
