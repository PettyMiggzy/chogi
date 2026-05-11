module.exports = {
  apps: [{
    name: 'chogi-buyback-burner',
    script: 'index.js',
    cwd: '/root/chogi-bots/buyback-burner',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '300M',
    env: {
      NODE_ENV: 'production',
    },
    out_file: '/var/log/chogi-buyback-burner.out.log',
    error_file: '/var/log/chogi-buyback-burner.err.log',
    merge_logs: true,
    time: true,
  }],
};
