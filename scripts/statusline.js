#!/usr/bin/env node
// Claude Code 状态栏：上下文窗口（stdin） + CCS 网关精确用量（SQLite）
//
// 数据源
//   stdin JSON          ← Claude Code CLI 注入，实时上下文窗口 / 模型 / session_id
//   ~/.cc-switch/*.db   ← CC-Switch 本地代理记录的精确 token 与真实 USD 费用
//                         （通过 Node 24 内置 node:sqlite 直读）
//
// 降级：当 CCS db 不可访问时，回到基于 stdin total_*_tokens 的估算显示。

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { DatabaseSync } = require('node:sqlite');

// 抑制 node:sqlite 的 ExperimentalWarning（Node 24 仍标记 experimental）
const _stderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...rest) => {
  const s = (chunk && chunk.toString) ? chunk.toString() : '';
  if (s.includes('ExperimentalWarning') && s.includes('SQLite')) return true;
  return _stderrWrite(chunk, ...rest);
};

// ---------------------------------------------------------------------------
// 路径 & 兜底配置
// ---------------------------------------------------------------------------

const CONFIG_PATH   = path.join(__dirname, '..', 'models.json');
const OVERRIDE_FILE = path.join(os.homedir(), '.claude', 'cost-override.json');
const CCS_DB_PATH   = path.join(os.homedir(), '.cc-switch', 'cc-switch.db');

const FALLBACK_CONFIG = {
  models: { 'deepseek-v4-flash': { contextWindow: 1000000, currency: 'RMB',
    prices: { inputCacheHit: 0.2, inputCacheMiss: 1, output: 2 } } },
  defaultModel: 'deepseek-v4-flash',
  usdToRmb: 7.25,
};

const loadConfig    = () => { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return FALLBACK_CONFIG; } };
const loadOverrides = () => { try { return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8')); } catch { return {}; } };

// ---------------------------------------------------------------------------
// CCS 数据库访问（精确数据源）
// ---------------------------------------------------------------------------

// 惰性打开 + 三态缓存：null=未尝试 / DatabaseSync=已开 / false=已失败（不再重试）
let _db = null;
function getDb() {
  if (_db !== null) return _db || null;
  if (!fs.existsSync(CCS_DB_PATH)) { _db = false; return null; }
  try {
    _db = new DatabaseSync(CCS_DB_PATH, { readOnly: true });
    return _db;
  } catch { _db = false; return null; }
}

const TOKENS_AGG = `
  COUNT(*) AS req,
  COALESCE(SUM(input_tokens), 0)          AS in_tok,
  COALESCE(SUM(output_tokens), 0)         AS out_tok,
  COALESCE(SUM(cache_read_tokens), 0)     AS cr_tok,
  COALESCE(SUM(cache_creation_tokens), 0) AS cc_tok,
  COALESCE(SUM(CAST(total_cost_usd AS REAL)), 0) AS cost_usd
`;

// 当前会话精确累计（按 session_id）
function querySession(sid, app = 'claude') {
  const db = getDb();
  if (!db || !sid) return null;
  try {
    const row = db.prepare(
      `SELECT ${TOKENS_AGG} FROM proxy_request_logs WHERE session_id=? AND app_type=?`
    ).get(String(sid), app);
    return row && row.req > 0 ? row : { req: 0, in_tok: 0, out_tok: 0, cr_tok: 0, cc_tok: 0, cost_usd: 0 };
  } catch { return null; }
}

// 当日累计：从原始日志实时聚合（CCS 的 usage_daily_rollups 不一定当日已 rollup）
function queryToday(app = 'claude') {
  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare(`
      SELECT ${TOKENS_AGG}
      FROM proxy_request_logs
      WHERE app_type=? AND date(created_at,'unixepoch')=date('now')
    `).get(app);
    return row && row.req > 0 ? row : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Token Plan 额度查询（5h / 1w）
// 原理：cc-switch 的 token_plan 模板在后端（src-tauri/src/services/coding_plan.rs）
// 按 codingPlanProvider 路由到不同 API，前端只缓存结果。我们这里直接复用同套
// 路由：仅当 currentProviderClaude 的 meta.usage_script.templateType === "token_plan"
// 才发起查询，结果按 TTL 内存缓存，避免 statusline 每秒刷新打 API。
// ---------------------------------------------------------------------------

const TOKEN_PLAN_TTL_MS = 90 * 1000;   // 缓存 90s
const TOKEN_PLAN_TIMEOUT_MS = 8 * 1000;
let _quotaCache = { ts: 0, key: '', data: null, err: null };

// codingPlanProvider → API 配置（与 Rust 端 CODING_PLAN_PROVIDERS 保持同效）
// 仅实现 minimax；kimi/zhipu 等可后续按需补
const TOKEN_PLAN_ROUTES = {
  minimax: {
    buildUrl: () => 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains',
    headers: (key) => ({ Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }),
    parse: parseMinimaxQuota,
  },
};

function parseMinimaxQuota(body) {
  // 期望：{ model_remains: [{ model_name, current_interval_remaining_percent,
  //                          end_time, current_weekly_status,
  //                          current_weekly_remaining_percent, weekly_end_time }],
  //          base_resp: { status_code } }
  const arr = body && body.model_remains;
  if (!Array.isArray(arr)) return null;
  const item = arr.find(x => x && x.model_name === 'general');
  if (!item) return null;
  const out = {};
  const fiveRemain = Number(item.current_interval_remaining_percent);
  if (Number.isFinite(fiveRemain)) {
    out.five_hour = {
      utilization: Math.max(0, Math.min(100, 100 - fiveRemain)),
      resets_at: Number(item.end_time) || null,
    };
  }
  // 周桶：仅 status===1 激活
  if (Number(item.current_weekly_status) === 1) {
    const wRemain = Number(item.current_weekly_remaining_percent);
    if (Number.isFinite(wRemain)) {
      out.weekly_limit = {
        utilization: Math.max(0, Math.min(100, 100 - wRemain)),
        resets_at: Number(item.weekly_end_time) || null,
      };
    }
  }
  return out;
}

function getCurrentClaudeProvider() {
  // currentProviderClaude 在 ~/.cc-switch/settings.json（JSON 文件），不在 SQLite
  const SETTINGS_JSON = path.join(os.homedir(), '.cc-switch', 'settings.json');
  let providerId = null;
  try {
    const cfg = JSON.parse(fs.readFileSync(SETTINGS_JSON, 'utf8'));
    providerId = cfg.currentProviderClaude;
  } catch { return null; }
  if (!providerId) return null;

  const db = getDb();
  if (!db) return null;
  try {
    const row = db.prepare(
      'SELECT id, name, meta, settings_config FROM providers WHERE id=? AND app_type=?'
    ).get(String(providerId), 'claude');
    if (!row) return null;
    const meta = (() => { try { return JSON.parse(row.meta); } catch { return {}; } })();
    const cfg  = (() => { try { return JSON.parse(row.settings_config); } catch { return {}; } })();
    return { id: row.id, name: row.name, meta, env: (cfg && cfg.env) || {} };
  } catch { return null; }
}

function httpsJsonGetSync(urlStr, headers) {
  // 同步 GET：statusline 进程秒级超时，整体必须能在 <1s 内返回
  // 冷启动 + 缓存未命中时本次调用会真打 API（200-500ms），后续命中缓存
  const u = new URL(urlStr);
  const opts = {
    hostname: u.hostname, port: 443, path: u.pathname + u.search,
    method: 'GET', headers, timeout: TOKEN_PLAN_TIMEOUT_MS,
  };
  try {
    const res = https.request(opts);
    res.setTimeout(TOKEN_PLAN_TIMEOUT_MS, () => res.destroy(new Error('timeout')));
    res.end();
    // 用同步 wait：https 没有同步 API；用 child_process 风险更高，
    // 这里直接走异步+setImmediate 让事件循环转一次。仍然不阻塞
    // 进程退出（process.exit 由 main 同步路径走完触发）。
  } catch (e) { return { _err: e.message }; }
  // 同步读取不可行，改：调用方传入回调收集
  return null;
}

// 真正用同步风格的实现：使用 undici-like 同步请求不实际，
// 我们采用 "node 18+ 同步 fetch via Atomics.wait" 不可靠 → 改用：
// node 内置的 http.request + 同步等待需要 worker_threads。
// 退而求其次：用 child_process.execSync 调 curl（系统自带）来打 HTTPS。
// 这样保证 statusline 主流程在缓存未命中时阻塞 < 1s 取到数据，缓存命中立即返回。

function fetchQuotaSync(url, headers) {
  const { execFileSync } = require('child_process');
  // 把每个 header 拆成独立 argv 项：Windows 下 execFileSync 不经 shell 解析，
  // 把 "-H "Authorization: ..."  整串当一个参数会让 curl 把它当 URL
  const args = ['-sS', '--max-time', String(Math.floor(TOKEN_PLAN_TIMEOUT_MS / 1000)),
                '-w', '\n__HTTP_STATUS__:%{http_code}'];
  for (const [k, v] of Object.entries(headers)) {
    args.push('-H', `${k}: ${v}`);
  }
  args.push(url);
  try {
    const out = execFileSync('curl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/\n__HTTP_STATUS__:(\d+)\s*$/);
    const status = m ? parseInt(m[1], 10) : 0;
    const body = m ? out.slice(0, m.index) : out;
    if (status < 200 || status >= 300) return { _err: `HTTP ${status}: ${body.slice(0,120)}` };
    return JSON.parse(body);
  } catch (e) {
    return { _err: e.message || String(e) };
  }
}

function queryTokenPlan() {
  const prov = getCurrentClaudeProvider();
  if (!prov) {
    // 拿不到 provider（settings.json 解析失败 / DB 不可用）→ 清掉 stale 缓存
    _quotaCache = { ts: 0, key: '', data: null, err: null };
    return null;
  }
  const us = prov.meta && prov.meta.usage_script;
  if (!us || !us.enabled || us.templateType !== 'token_plan') {
    // 当前 provider 不是 token_plan：清掉旧 provider 残留的缓存
    _quotaCache = { ts: 0, key: '', data: null, err: null };
    return null;
  }
  const routeKey = us.codingPlanProvider;
  const route = TOKEN_PLAN_ROUTES[routeKey];
  if (!route) return { unsupported: true, provider: routeKey };

  const apiKey = prov.env.ANTHROPIC_AUTH_TOKEN || '';
  if (!apiKey) return { error: 'no api key' };

  const cacheKey = `${prov.id}|${routeKey}`;
  const now = Date.now();
  // provider 换了 → 缓存 key 不匹配 → 直接重新查（不需清，下面新赋值会覆盖）
  if (_quotaCache.key === cacheKey && now - _quotaCache.ts < TOKEN_PLAN_TTL_MS) {
    return _quotaCache.data || { error: _quotaCache.err };
  }

  const body = fetchQuotaSync(route.buildUrl(prov.env), route.headers(apiKey));
  if (body && body._err) {
    _quotaCache = { ts: now, key: cacheKey, data: null, err: body._err };
    return { error: body._err };
  }
  const tiers = route.parse(body);
  _quotaCache = { ts: now, key: cacheKey, data: { ok: true, tiers, provider: routeKey }, err: null };
  return _quotaCache.data;
}

function fmtCountdown(ms) {
  if (!ms || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  if (h < 24) return rm ? `${h}h${rm}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d${rh}h` : `${d}d`;
}

function paintQuota(pct) {
  if (pct >= 80) return RED(pct + '%');
  if (pct >= 50) return YEL(pct + '%');
  return pct + '%';
}

function renderQuota(q) {
  if (!q) return null;
  if (q.unsupported) return DIM(`[token_plan: ${q.provider} 未实现]`);
  if (q.error)        return DIM(`[token_plan: ${q.error}]`);
  if (!q.ok || !q.tiers) return null;
  const now = Date.now();
  const parts = [];
  for (const [label, tier, key] of [
    ['5h',  q.tiers.five_hour,   '5h'],
    ['1w',  q.tiers.weekly_limit,'1w'],
  ]) {
    if (!tier) continue;
    const pct = Math.round(tier.utilization);
    const cd  = tier.resets_at ? fmtCountdown(tier.resets_at - now) : '';
    const cdTxt = cd ? DIM(`↻${cd}`) : '';
    parts.push(`${label} ${paintQuota(pct)} ${bar(pct, 8)} ${cdTxt}`);
  }
  return parts.length ? parts.join(' ') : null;
}

// ---------------------------------------------------------------------------
// 显示工具
// ---------------------------------------------------------------------------

function fmt(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function bar(pct, w = 12) {
  const f = Math.max(0, Math.min(w, Math.round((pct || 0) / 100 * w)));
  return '█'.repeat(f) + '░'.repeat(w - f);
}
const RED = s => `\x1b[31m${s}\x1b[0m`;
const CYN = s => `\x1b[36m${s}\x1b[0m`;
const YEL = s => `\x1b[33m${s}\x1b[0m`;
const DIM = s => `\x1b[2m${s}\x1b[0m`;
const BLD = s => `\x1b[1m${s}\x1b[0m`;
function paintCost(cny) {
  const s = '¥' + cny.toFixed(2);
  return cny >= 10 ? RED(s) : (cny >= 5 ? YEL(s) : s);
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function main() {
  let raw;
  try { raw = fs.readFileSync(0, 'utf8').trim(); } catch { raw = ''; }
  if (!raw) { console.log('⏎ 等待会话...'); return; }

  let data;
  try { data = JSON.parse(raw); } catch { console.log('📊 加载中...'); return; }

  const cw = data.context_window || {};
  const config = loadConfig();
  const usdToRmb = config.usdToRmb || 7.25;
  const modelId = (data.model && data.model.id) || process.env.ANTHROPIC_MODEL || config.defaultModel;

  // 上下文窗口（stdin 实时）
  const apiWin = cw.context_window_size || 200000;
  const usedPct = cw.used_percentage || 0;
  const ctxNow = Math.round(usedPct / 100 * apiWin);

  const pctTxt = usedPct >= 90 ? RED(Math.round(usedPct) + '%') : (Math.round(usedPct) + '%');
  const head = `📊 ${modelId} ${pctTxt} ${bar(usedPct)} ${fmt(ctxNow)}/${fmt(apiWin)}`;

  // CCS 数据段
  const sess  = querySession(data.session_id, 'claude');
  const today = queryToday('claude');
  const segs = [];

  if (sess && sess.req > 0) {
    // 精确模式：input (dim) / output (bold) / cache_read (cyan) 由颜色区分
    // 位置语义：r in↓ out↑ cache（无文字标签）
    const cny = sess.cost_usd * usdToRmb;
    const cr = sess.cr_tok > 0 ? ` ${CYN(fmt(sess.cr_tok))}` : '';
    segs.push(
      `会话[${DIM(sess.req + 'r')} ${DIM(fmt(sess.in_tok) + '↓')} ${BLD(fmt(sess.out_tok) + '↑')}${cr}] ${paintCost(cny)}`
    );
  } else if ((cw.total_input_tokens | 0) || (cw.total_output_tokens | 0)) {
    // 降级：CCS 不可用，stdin 累计（不含 cache_read）
    const total = (cw.total_input_tokens || 0) + (cw.total_output_tokens || 0);
    segs.push(DIM(`会话[stdin ${fmt(total)}]`));
  }

  if (today && today.req > 0) {
    const total = today.in_tok + today.out_tok + today.cr_tok + today.cc_tok;
    const cny = today.cost_usd * usdToRmb;
    segs.push(`今日[${DIM(today.req + 'r')} ${DIM(fmt(total))}] ${paintCost(cny)}`);
  }

  // Token Plan 额度（5h / 1w）—— 仅当 currentProviderClaude 是 token_plan 时出现
  // 同步阻塞：getCurrentClaudeProvider 只读 SQLite，queryTokenPlan 内置 90s
  // 缓存。命中缓存立即返回（毫秒级），未命中时用 curl --max-time 8 同步打
  // 远端（~300ms），整体仍 < 1s，不会让 Claude Code 刷出空行。
  try {
    const q = queryTokenPlan();
    const txt = renderQuota(q);
    if (txt) segs.push(txt);
  } catch { /* 静默：额度段失败不影响主显示 */ }

  console.log(segs.length ? `${head} | ${segs.join(' | ')}` : head);
}

try { main(); } catch { console.log('📊 加载中...'); }