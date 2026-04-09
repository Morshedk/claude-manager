module.exports = {
  apps: [
    {
      name: 'claude-v2-prod',
      script: 'server-with-crash-log.mjs',
      cwd: '/home/claude-runner/apps/claude-web-app-v2',
      env: {
        PORT: 3001,
        DATA_DIR: '/home/claude-runner/apps/claude-web-app-v2/data',
        CRASH_LOG: '/home/claude-runner/apps/claude-web-app-v2/crash.log',
        NODE_ENV: 'production',
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
    {
      name: 'claude-v2-beta',
      script: 'server-with-crash-log.mjs',
      cwd: '/home/claude-runner/apps/claude-web-app-v2',
      env: {
        PORT: 3002,
        DATA_DIR: '/home/claude-runner/apps/claude-web-app-v2/data-beta',
        CRASH_LOG: '/home/claude-runner/apps/claude-web-app-v2/crash-beta.log',
        NODE_ENV: 'development',
      },
      watch: false,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
