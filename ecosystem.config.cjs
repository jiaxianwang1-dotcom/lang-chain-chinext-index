// PM2 配置：两个常驻进程
//   1) stock-web  : Express + LangGraph，对外提供 Web UI 与 /api/* 接口
//   2) stock-cron : node-cron 常驻，北京时间每个交易日 14:00 触发预测 + 短信
//
// 启动：pm2 start ecosystem.config.cjs
// 仅启动其一：pm2 start ecosystem.config.cjs --only stock-web
// 重启：pm2 restart stock-web / stock-cron
// 查看日志：pm2 logs stock-web
//
// 注意：项目使用 TypeScript + tsx 运行，没有 build 步骤。我们直接用本地
// node_modules/.bin/tsx 作为脚本入口，避免 `npm run` 包多一层 shell 进程导致
// PM2 信号传递不干净。

module.exports = {
  apps: [
    {
      name: "stock-web",
      script: "./node_modules/.bin/tsx",
      args: "web-agent.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      // dotenv 在代码里已经被 import("dotenv/config") 加载，PM2 不需要重复注入
      // .env，但需要保证启动目录里有 .env 文件。
      out_file: "./logs/stock-web.out.log",
      error_file: "./logs/stock-web.err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
    {
      name: "stock-cron",
      script: "./node_modules/.bin/tsx",
      args: "src/agent/stock/main.ts",
      cwd: __dirname,
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      max_memory_restart: "512M",
      env: {
        NODE_ENV: "production",
        TZ: "Asia/Shanghai",
      },
      out_file: "./logs/stock-cron.out.log",
      error_file: "./logs/stock-cron.err.log",
      log_date_format: "YYYY-MM-DD HH:mm:ss",
      merge_logs: true,
    },
  ],
};
