module.exports = {
  apps: [
    {
      name: "lang-chain-graph",
      script: "web-agent.ts",
      interpreter: "npx",
      interpreter_args: "tsx",
      cwd: "/opt/lang-chain-chinext-index",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      instances: 1,
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      watch: false,
      max_memory_restart: "512M",
      error_file: "./logs/error.log",
      out_file: "./logs/out.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
    },
  ],
};
