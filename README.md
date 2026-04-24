# Claude Cost

实时监控 [Claude Code CLI](https://claude.ai/code) 会话的 token 用量、RMB 费用和上下文窗口使用率，直接显示在对话框底部的状态栏中。

![Status](https://img.shields.io/badge/status-运行中-brightgreen)

## 功能

- **Token 用量** — 当前上下文 token 数和会话累计总数
- **RMB 费用** — 根据模型定价精确估算
- **上下文窗口** — 使用百分比 + 可视化进度条（超 90% 变红）
- **支持任何模型** — 内置 DeepSeek/Claude 定价表，可通过配置文件添加任意 API 模型
- **自动刷新** — 每 10 秒自动更新
- **会话内配置** — 输入 `/claude-cost` 实时查看和调整费率
- **缓存计费** — 自动利用缓存命中率推算实际 API 用量（DeepSeek 风格）

## 要求

- 已安装 [Claude Code CLI](https://claude.ai/code)
- Node.js（Claude Code 状态栏系统需要）

## 安装

```bash
git clone https://github.com/YOUR_USERNAME/claude-cost.git
cd claude-cost
node install.js
```

重启 Claude Code CLI，状态栏即会出现在对话框底部。

### 手动安装

在 `~/.claude/settings.json` 中添加：

```json
{
  "statusLine": {
    "type": "command",
    "command": "node \"/path/to/claude-cost/scripts/statusline.js\"",
    "refreshInterval": 10
  }
}
```

并将 `claude-cost.md` 复制到 `~/.claude/commands/claude-cost.md` 以启用 `/claude-cost` 命令。

## 使用方法

### 状态栏格式

```
📊 deepseek-v4-flash 6% █░░░░░░░░░░░░░░ 64k/1.0M  3138308（3.1M）token | ≈10.26¥
```

| 部分 | 含义 |
|------|------|
| `deepseek-v4-flash` | 当前模型（自动检测） |
| `6%` | 上下文使用率（相对于模型容量） |
| `█░░░░░░░░░░░░░░` | 可视化进度条 |
| `64k/1.0M` | 当前上下文字符数 / 模型容量 |
| `3138308（3.1M）` | 精确 / 粗略的累计会话 token 数 |
| `≈10.26¥` | 预估费用（人民币） |

### 状态说明

| 状态 | 显示 |
|------|------|
| 空闲（无会话） | `⏎ 等待会话...` |
| 新会话 | `0% ░░░░░░░░░░░░░░░ 0/1.0M  0（0）token | ≈0.00¥` |
| 正常使用 | `8% █░░░░░░░░░░░░░░ 80k/1.0M  303k（303k）token | ≈0.30¥` |
| 高使用率 (>90%) | `93%` 变为**红色** |

### 会话内配置

在任意会话中输入 `/claude-cost`，可以：

1. 查看当前模型及其定价
2. 修改价格 — 例如 _"set deepseek-v4-flash output price to 2.5"_
3. 调整缓存命中率 — 例如 _"set deepseek-v4-flash cacheHitRatio to 0.88"_
4. 恢复默认 — 例如 _"reset deepseek-v4-pro to default"_

修改后 10 秒内生效（下一个状态栏刷新周期）。

## 定价策略

所有模型定价定义在项目根目录的 `models.json` 文件中，可直接编辑。通过 `/claude-cost` 或手动编辑 `~/.claude/cost-override.json` 可覆盖单个模型的部分或全部价格。

> **重要说明**：Claude Code CLI 的 `total_input_tokens` 字段**只统计未命中缓存的新输入 token**。实际 API 调用总量要大得多（因为缓存命中的上下文被重复使用）。我们使用 `cacheHitRatio` 来推算：
> ```
> cache命中量 = cache未命中量 × cacheHitRatio / (1 - cacheHitRatio)
> 费用 = (cache命中量 × 命中价 + cache未命中量 × 未命中价 + 输出量 × 输出价) / 1,000,000
> ```
> 默认 `cacheHitRatio` = 0.925（来自你的 DeepSeek 开发者控制台：35.1M 命中 / 37.97M 总量）。

### 内置模型定价表（每百万 token）

| 模型 | 上下文 | 输入（缓存命中） | 输入（缓存未命中） | 输出 | 缓存命中率 |
|------|--------|----------------|-----------------|------|----------|
| DeepSeek v4 Pro | 1M | ¥1 | ¥12 | ¥24 | 0.925 |
| DeepSeek v4 Flash | 1M | ¥0.2 | ¥1 | ¥2 | 0.925 |
| DeepSeek Reasoner | 1M | ¥1 | ¥12 | ¥24 | 0.925 |
| Claude Sonnet 4 | 200K | $3 | $3 | $15 | — |

### 添加任意模型

在 `~/.claude/cost-override.json` 中定义。支持两种价格格式：

**缓存折扣型**（DeepSeek、Gemini 等）：
```json
{
  "my-model": {
    "contextWindow": 128000,
    "currency": "RMB",
    "prices": { "inputCacheHit": 0.5, "inputCacheMiss": 2, "output": 8 },
    "cacheHitRatio": 0.85
  }
}
```

**统一价格型**（OpenAI、Claude，无缓存折扣）：
```json
{
  "gpt-4o": {
    "contextWindow": 128000,
    "currency": "USD",
    "prices": { "input": 2.5, "output": 10 }
  }
}
```

**兜底配置**（用于任何未识别模型）：
```json
{
  "_default": {
    "contextWindow": 200000,
    "currency": "RMB",
    "prices": { "input": 5, "output": 15 },
    "cacheHitRatio": 0.5
  }
}
```

## 项目结构

```
claude-cost/
├── scripts/
│   └── statusline.js         # 核心状态栏脚本（内嵌定价表）
├── .claude/
│   └── commands/
│       └── claude-cost.md    # /claude-cost 会话命令
├── .claude-plugin/
│   └── plugin.json           # 插件元数据
├── install.js                # 一键安装脚本
├── LICENSE                   # MIT 许可证
├── .gitignore
└── README.md
```

## 常见问题

**Q: Token 数显示为 0，为什么？**  
A: 状态栏读取当前会话的上下文窗口数据。刚启动时 0 是正常的，发送一条消息后就会更新。

**Q: 费用显示 ~1¥ 但我实际应该花更多，怎么回事？**  
A: `total_input_tokens` 只统计了**未命中缓存**的输入。新版已自动用 `cacheHitRatio`（默认 0.925）推算命中量。如果你的实际缓存命中率不同，用 `/claude-cost` 调整即可。

**Q: 如何添加一个不在内置表中的模型？**  
A: 在 `~/.claude/cost-override.json` 中添加它的价格和上下文窗口。缓存折扣型用 `inputCacheHit/inputCacheMiss/output`，统一价格型用 `input/output`。详见上面的"添加任意模型"。

**Q: 如何永久修改定价？**  
A: 在会话中输入 `/claude-cost` 修改价格或缓存命中率，修改会自动保存到 `~/.claude/cost-override.json`。

**Q: 可以直接改硬编码的定价吗？**  
A: 可以。编辑 `scripts/statusline.js` 顶部的 `PRICING` 对象然后重启即可。

**Q: 能在 Codex CLI 上用吗？**  
A: 不能。Codex CLI 使用不同的 TUI 架构（Rust/TUI，不是 Node.js）。本插件仅支持 Claude Code CLI。

## 许可证

MIT
