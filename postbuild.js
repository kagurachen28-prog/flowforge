#!/usr/bin/env node

const { execSync } = require('child_process');

// 检测调用者：npm 或 pnpm
const userAgent = process.env.npm_config_user_agent || '';
const isPnpm = userAgent.includes('pnpm');

// 根据调用者选择包管理器
const packageManager = isPnpm ? 'pnpm' : 'npm';

// 执行 rebuild better-sqlite3
try {
  execSync(`${packageManager} rebuild better-sqlite3`, { stdio: 'inherit' });
} catch (error) {
  console.error(`Error running ${packageManager} rebuild better-sqlite3:`, error.message);
  process.exit(1);
}