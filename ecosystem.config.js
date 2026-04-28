module.exports = {
  apps: [
    {
      name: 'markmate',
      script: 'server/index.js',
      cwd: '/home/markmate/markmateio',
      instances: 1,
      exec_mode: 'fork',
      max_memory_restart: '2G',
      node_args: '--max-old-space-size=1800',
      env: {
        NODE_ENV: 'production',
      },
      // Restart policy
      restart_delay: 3000,
      max_restarts: 10,
      min_uptime: '10s',
      // Logging
      error_file: '/home/markmate/markmateio/logs/pm2-error.log',
      out_file: '/home/markmate/markmateio/logs/pm2-out.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
};
