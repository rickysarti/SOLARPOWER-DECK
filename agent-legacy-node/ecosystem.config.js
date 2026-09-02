module.exports = {
  apps: [
    {
      name: 'solarpower-wp-bot',
      script: 'index.js',
      cwd: 'C:\\Users\\Ricky\\Desktop\\CLAUDIO\\CLAUDIO\\solarpower-agent',
      watch: false,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '10s',
      restart_delay: 5000,
      env: {
        NODE_ENV: 'production'
      },
      log_file: 'logs/pm2-combined.log',
      error_file: 'logs/pm2-error.log',
      out_file: 'logs/pm2-out.log',
      time: true
    },
    {
      name: 'solarpower-wp-tunnel',
      script: 'cloudflared',
      args: 'tunnel --url http://localhost:3000',
      cwd: 'C:\\Users\\Ricky\\Desktop\\CLAUDIO\\CLAUDIO\\solarpower-agent',
      interpreter: 'none',
      watch: false,
      autorestart: true,
      max_restarts: 50,
      min_uptime: '5s',
      restart_delay: 5000,
      // El tunnel imprime la URL nueva en su log de salida cada vez que arranca.
      // Después de relanzar, leer logs/tunnel-out.log para el link nuevo.
      log_file: 'logs/tunnel-combined.log',
      error_file: 'logs/tunnel-error.log',
      out_file: 'logs/tunnel-out.log',
      time: true
    }
  ]
};
