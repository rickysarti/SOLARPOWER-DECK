/**
 * logger.js
 * Configuración centralizada de Winston para logs a consola y archivo.
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Crear directorio de logs si no existe
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// FAILSAFE / ESPEJO EN VIVO: copia simultánea en D:\CLAUDIO. Si D: no está
// disponible, seguimos solo con C: en vez de crashear.
const MIRROR_DIR = 'D:\\CLAUDIO\\Espejo\\solarpower-agent\\logs';
let mirrorAvailable = true;
try {
  fs.mkdirSync(MIRROR_DIR, { recursive: true });
} catch (e) {
  mirrorAvailable = false;
}

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, stack }) => {
    return stack
      ? `[${timestamp}] ${level.toUpperCase()}: ${message}\n${stack}`
      : `[${timestamp}] ${level.toUpperCase()}: ${message}`;
  })
);

const transports = [
  // Consola con colores
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) => {
        return `[${timestamp}] ${level}: ${message}`;
      })
    )
  }),
  // Archivo general
  new winston.transports.File({
    filename: path.join(logsDir, 'app.log'),
    maxsize: 5 * 1024 * 1024, // 5MB
    maxFiles: 5,
    tailable: true
  }),
  // Archivo solo de errores
  new winston.transports.File({
    filename: path.join(logsDir, 'error.log'),
    level: 'error',
    maxsize: 5 * 1024 * 1024,
    maxFiles: 3
  })
];

if (mirrorAvailable) {
  transports.push(
    new winston.transports.File({
      filename: path.join(MIRROR_DIR, 'app.log'),
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
      tailable: true,
    }),
    new winston.transports.File({
      filename: path.join(MIRROR_DIR, 'error.log'),
      level: 'error',
      format: fileFormat,
      maxsize: 5 * 1024 * 1024,
      maxFiles: 3,
    })
  );
}

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: fileFormat,
  exitOnError: false,
  transports,
});

// Sin este listener, un error de escritura (ej. ENOSPC) en cualquier
// transport tumba todo el proceso — esto fue lo que pasó el 2026-06-30.
logger.on('error', (err) => {
  try {
    process.stderr.write(`[logger] transport error (ignorado): ${err && err.message}\n`);
  } catch (_) {}
});

module.exports = logger;
