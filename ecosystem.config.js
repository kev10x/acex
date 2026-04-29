module.exports = {
  apps: [
    {
      name: 'markmate',
      script: './server/index.js',
      instances: 1,
      exec_mode: 'fork',
      watch: false,
      autorestart: true,
      max_restarts: 20,
      restart_delay: 3000,
      max_memory_restart: '4G',
      node_args: '--max-old-space-size=4096',
      env: {
        NODE_ENV: 'production',
        PORT: 3001,
        BASE_PATH: '/tools',
      },
      env_production: {
        NODE_ENV: 'production',
        PORT: 3001,
        BASE_PATH: '/tools',
      },
    },
  ],
};

