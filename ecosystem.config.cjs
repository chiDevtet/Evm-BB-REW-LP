module.exports = {
  apps: [
    {
      name: 'utility-dashboard',
      script: 'keeper/server.mjs',
      instances: 1,
      exec_mode: 'fork',
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'utility-keeper',
      script: 'keeper/run.mjs',
      instances: 1,
      exec_mode: 'fork',
      autorestart: false,
      env: { NODE_ENV: 'production' },
    },
  ],
};
