module.exports = {
  apps: [{
    name: 'wedding',
    script: 'server.js',
    env: { NODE_ENV: 'production', TZ: 'Asia/Jerusalem' },
    watch: false,
    max_memory_restart: '200M'
  }]
};
