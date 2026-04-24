---
description: View or change pricing for the claude-cost status line
---

# claude-cost — Pricing Configuration

I'll help you configure the pricing for the claude-cost status line plugin.

## What I'll do

1. **Detect** the current model from the session context
2. **Read** the current pricing from `scripts/statusline.js`
3. **Check** `~/.claude/cost-override.json` for any existing overrides
4. **Show** you the current model and its prices
5. **Update** the override file if you provide new pricing

## How Cost Is Calculated

`total_input_tokens` from the session data only counts **cache-miss** (new) input tokens. The actual API input is much larger because cached context is reused across messages.

**Cache‑based pricing** (DeepSeek‑style, uses `inputCacheHit` / `inputCacheMiss`):
```
cacheHits = cacheMisses × cacheHitRatio ÷ (1 - cacheHitRatio)
cost = (cacheHits × hitPrice + cacheMisses × missPrice + output × outputPrice) / 1,000,000
```

**Flat pricing** (OpenAI / Claude‑style, uses `input` / `output` without cache distinction):
```
cost = (totalInput × inputPrice + output × outputPrice) / 1,000,000
```

The `cacheHitRatio` defaults to **0.925** (from your DeepSeek console: 35.1M hits / 37.97M total). Override it per‑model if your ratio differs.

## Built‑in Pricing Table

Per‑million‑token rates in `scripts/statusline.js`:

| Model | Input (cache hit) | Input (cache miss) | Output | Cache ratio | Context |
|-------|-------------------|-------------------|--------|------------|---------|
| deepseek-v4-pro | ¥1 | ¥12 | ¥24 | 0.925 | 1,000,000 |
| deepseek-v4-flash | ¥0.2 | ¥1 | ¥2 | 0.925 | 1,000,000 |
| deepseek-reasoner | ¥1 | ¥12 | ¥24 | 0.925 | 1,000,000 |
| claude-sonnet-4 | $3 | $3 | $15 | — | 200,000 |

## Adding Any Model

You can define **any model** in `~/.claude/cost-override.json`. The override file supports two price formats:

**Cache‑based** (DeepSeek, Gemini, etc.):
```json
{
  "my-custom-model": {
    "contextWindow": 128000,
    "currency": "RMB",
    "prices": {
      "inputCacheHit": 0.5,
      "inputCacheMiss": 2,
      "output": 8
    },
    "cacheHitRatio": 0.85
  }
}
```

**Flat** (OpenAI, Claude, no cache discount):
```json
{
  "gpt-4o": {
    "contextWindow": 128000,
    "currency": "USD",
    "prices": {
      "input": 2.5,
      "output": 10
    }
  }
}
```

**Catch‑all `_default`** — used for any model not in the built‑in table or overrides:
```json
{
  "_default": {
    "contextWindow": 200000,
    "currency": "RMB",
    "prices": {
      "input": 5,
      "output": 15
    },
    "cacheHitRatio": 0.5
  }
}
```

## How to change

Say:

> Set deepseek-v4-flash output price to 2.5

Override individual prices:

> Set deepseek-v4-flash: inputCacheHit=0.3, inputCacheMiss=1.2, output=2.5

Override cache hit ratio:

> Set deepseek-v4-flash cacheHitRatio to 0.88

Or reset to defaults:

> Reset deepseek-v4-flash to default

Changes take effect on the next status line refresh (within 10 seconds).
