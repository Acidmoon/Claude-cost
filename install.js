#!/usr/bin/env node
// 安装脚本：配置 statusLine + 安装 /claude-cost 命令

const fs = require('fs');
const path = require('path');

const homedir = process.env.USERPROFILE || process.env.HOME;
const claudeDir = path.join(homedir, '.claude');

// 1. 配置 statusLine
const settingsPath = path.join(claudeDir, 'settings.json');
const scriptPath = path.join(__dirname, 'scripts', 'statusline.js');

const statusLineConfig = {
  type: 'command',
  command: 'node "' + scriptPath.replace(/\\/g, '/') + '"',
  refreshInterval: 10
};

try {
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  }
  settings.statusLine = statusLineConfig;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  console.log('✅ statusLine configured');
} catch (e) {
  console.error('❌ Failed to configure statusLine:', e.message);
  process.exit(1);
}

// 2. Install /claude-cost command
const cmdSrc = path.join(__dirname, '.claude', 'commands', 'claude-cost.md');
const cmdDst = path.join(claudeDir, 'commands', 'claude-cost.md');

try {
  if (!fs.existsSync(path.join(claudeDir, 'commands'))) {
    fs.mkdirSync(path.join(claudeDir, 'commands'), { recursive: true });
  }
  fs.copyFileSync(cmdSrc, cmdDst);
  console.log('✅ /claude-cost command installed');
} catch (e) {
  console.error('❌ Failed to install command:', e.message);
}

// 3. Ensure cost-override.json exists
const overridePath = path.join(claudeDir, 'cost-override.json');
if (!fs.existsSync(overridePath)) {
  fs.writeFileSync(overridePath, '{}', 'utf8');
  console.log('✅ cost-override.json created');
}

console.log('Restart Claude Code CLI for changes to take effect.');
