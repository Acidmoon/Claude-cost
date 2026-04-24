#!/usr/bin/env node
// Claude Code CLI 状态栏插件：实时显示 token 用量、RMB 费用、上下文百分比

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Config loading — reads models.json from project root
// ---------------------------------------------------------------------------

const CONFIG_PATH = path.join(__dirname, '..', 'models.json');

// Minimal built-in fallback (only used when models.json is missing)
const FALLBACK_CONFIG = {
  models: {
    "deepseek-v4-flash": {
      contextWindow: 1000000,
      currency: "RMB",
      defaultCacheHitRatio: 0.5,
      prices: { inputCacheHit: 0.2, inputCacheMiss: 1, output: 2 }
    }
  },
  defaultModel: "deepseek-v4-flash",
  usdToRmb: 7.25
};

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return FALLBACK_CONFIG;
  }
}

const OVERRIDE_FILE = path.join(os.homedir(), '.claude', 'cost-override.json');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadOverrides() {
  try {
    return JSON.parse(fs.readFileSync(OVERRIDE_FILE, 'utf8'));
  } catch {}
  return {};
}

function getModelConfig(modelId, config) {
  const overrides = loadOverrides();
  // 1. Built-in pricing table (exact match)
  let cfg = config.models[modelId];
  // 2. Fuzzy match
  if (!cfg) {
    const key = Object.keys(config.models).find(k => modelId.includes(k) || k.includes(modelId));
    cfg = key ? config.models[key] : null;
  }
  if (cfg) return cfg;
  // 3. Full model definition from overrides (for any model not in built-in table)
  if (overrides[modelId] && overrides[modelId].prices) {
    const o = overrides[modelId];
    return {
      contextWindow: o.contextWindow || 200000,
      currency: o.currency || 'RMB',
      usdToRmb: o.usdToRmb,
      defaultCacheHitRatio: o.cacheHitRatio != null ? o.cacheHitRatio : 0.5,
      prices: o.prices
    };
  }
  // 4. _default fallback in overrides
  if (overrides._default && overrides._default.prices) {
    const d = overrides._default;
    return {
      contextWindow: d.contextWindow || 200000,
      currency: d.currency || 'RMB',
      usdToRmb: d.usdToRmb,
      defaultCacheHitRatio: d.cacheHitRatio != null ? d.cacheHitRatio : 0.5,
      prices: d.prices
    };
  }
  return null;
}

function resolvePrices(modelId, baseCfg) {
  const overrides = loadOverrides();
  const override = overrides[modelId];
  if (override && override.prices) {
    return { ...baseCfg.prices, ...override.prices };
  }
  return baseCfg.prices;
}

function resolveCacheRatio(modelId, baseCfg) {
  const overrides = loadOverrides();
  const override = overrides[modelId];
  if (override && override.cacheHitRatio != null) {
    return override.cacheHitRatio;
  }
  return baseCfg.defaultCacheHitRatio || 0.5;
}

function formatToken(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'k';
  return String(n);
}

function progressBar(pct, width) {
  width = width || 15;
  const filled = Math.max(0, Math.min(width, Math.round(pct / 100 * width)));
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// Calculate cost using individual price components + cache hit ratio
// totalInput (from total_input_tokens) represents cache-miss ("new") tokens only.
//   cacheHits = totalInput * cacheHitRatio / (1 - cacheHitRatio)
function calcCost(totalInput, totalOutput, prices, cacheHitRatio) {
  if (prices.inputCacheHit != null && prices.inputCacheMiss != null) {
    const cacheMisses = totalInput;
    const r = Math.min(cacheHitRatio, 0.9999);
    const cacheHits = totalInput * r / (1 - r);
    const inputCost = (cacheHits * prices.inputCacheHit + cacheMisses * prices.inputCacheMiss) / 1_000_000;
    const outputCost = (totalOutput * prices.output) / 1_000_000;
    return inputCost + outputCost;
  } else if (prices.input != null) {
    const inputCost = (totalInput * prices.input) / 1_000_000;
    const outputCost = (totalOutput * prices.output) / 1_000_000;
    return inputCost + outputCost;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  try {
    const config = loadConfig();

    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) {
      console.log('⏎ 等待会话...');
      return;
    }

    const data = JSON.parse(raw);
    const cw = data.context_window || {};
    const modelId = (data.model && data.model.id) || process.env.ANTHROPIC_MODEL || config.defaultModel;
    const cfg = getModelConfig(modelId, config);

    // API working window vs model true capacity
    const apiWindowSize = cw.context_window_size || 200000;
    const modelWindowTotal = cfg && cfg.contextWindow ? cfg.contextWindow : apiWindowSize;

    // Current context tokens (relative to API's working window)
    const usedPct = cw.used_percentage || 0;
    const currentTokens = Math.round(usedPct / 100 * apiWindowSize);

    // Recalculate percentage against model's true capacity
    const realPct = modelWindowTotal > 0 ? (currentTokens / modelWindowTotal * 100) : 0;

    // Cumulative session tokens
    const totalInput = cw.total_input_tokens || 0;
    const totalOutput = cw.total_output_tokens || 0;
    const sessionTokens = totalInput + totalOutput;

    // Calculate cost
    let cost = null;
    if (cfg && cfg.prices) {
      const prices = resolvePrices(modelId, cfg);
      const cacheHitRatio = resolveCacheRatio(modelId, cfg);
      cost = calcCost(totalInput, totalOutput, prices, cacheHitRatio);
      if (cfg.currency === 'USD') {
        const rate = cfg.usdToRmb || config.usdToRmb;
        if (rate) cost *= rate;
      }
    }

    // Fallback: use default model pricing
    if (cost == null) {
      const def = config.models[config.defaultModel];
      if (def && def.prices) {
        const prices = resolvePrices(config.defaultModel, def);
        const cacheHitRatio = resolveCacheRatio(config.defaultModel, def);
        cost = calcCost(totalInput, totalOutput, prices, cacheHitRatio);
      }
    }

    // Build display
    const bar = progressBar(realPct);
    const pctInt = Math.round(realPct);
    let pctDisplay = pctInt + '%';
    if (pctInt >= 90) {
      pctDisplay = '\x1b[31m' + pctDisplay + '\x1b[0m';
    }

    const costStr = cost != null ? cost.toFixed(2) + '¥' : '?¥';
    const currentStr = formatToken(currentTokens) + '/' + formatToken(modelWindowTotal);

    console.log('📊 ' + modelId + ' ' + pctDisplay + ' ' + bar + ' ' + currentStr + '  ' +
      String(sessionTokens) + '（' + formatToken(sessionTokens) + '）token | ≈' + costStr);
  } catch (e) {
    console.log('📊 加载中...');
  }
}

main();
