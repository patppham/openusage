(function () {
  const PROVIDER_ID = "opencode-go";
  const AUTH_PROVIDER_IDS = ["opencode-go", "opencode"];
  const AUTH_PATH = "~/.local/share/opencode/auth.json";
  const DB_PATH = "~/.local/share/opencode/opencode.db";
  const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
  const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
  const LIMITS = {
    session: 12,
    weekly: 30,
    monthly: 60,
  };
  // Prices are [input, output, cache read, cache write] per 1M tokens.
  const MODEL_PRICES = {
    "glm-5.1": [1.4, 4.4, 0.26, 0], "glm-5": [1, 3.2, 0.2, 0], "kimi-k2.6": [0.95, 4, 0.16, 0],
    "kimi-k2.5": [0.6, 3, 0.1, 0], "mimo-v2.5": [0.14, 0.28, 0.0028, 0], "mimo-v2.5-pro": [1.74, 3.48, 0.0145, 0],
    "minimax-m3": [0.3, 1.2, 0.06, 0], "minimax-m2.7": [0.3, 1.2, 0.06, 0.375], "minimax-m2.5": [0.3, 1.2, 0.06, 0.375],
    "qwen3.7-max": [2.5, 7.5, 0.5, 3.125], "qwen3.7-plus": [0.4, 1.6, 0.04, 0.5], "qwen3.7-plus-large": [1.2, 4.8, 0.12, 1.5],
    "qwen3.6-plus": [0.5, 3, 0.05, 0.625], "qwen3.6-plus-large": [2, 6, 0.2, 2.5], "deepseek-v4-pro": [1.74, 3.48, 0.0145, 0],
    "deepseek-v4-flash": [0.14, 0.28, 0.0028, 0],
  };

  const SESSION_TOKEN_EXPR = `
    COALESCE(tokens_input, 0)
    + COALESCE(tokens_output, 0)
    + COALESCE(tokens_reasoning, 0)
    + COALESCE(tokens_cache_read, 0)
    + COALESCE(tokens_cache_write, 0)
  `;

  const SESSION_EXISTS_SQL = `
    SELECT 1 AS present
    FROM session
    WHERE (${SESSION_TOKEN_EXPR}) > 0
    LIMIT 1
  `;

  const SESSION_ROWS_SQL = `
    SELECT
      CAST(time_created AS INTEGER) AS createdMs,
      CASE WHEN json_valid(model) THEN json_extract(model, '$.id') ELSE model END AS modelId,
      CASE WHEN json_valid(model) THEN json_extract(model, '$.providerID') ELSE NULL END AS providerId,
      CAST(COALESCE(tokens_input, 0) AS INTEGER) AS inputTokens,
      CAST(COALESCE(tokens_output, 0) AS INTEGER) AS outputTokens,
      CAST(COALESCE(tokens_reasoning, 0) AS INTEGER) AS reasoningTokens,
      CAST(COALESCE(tokens_cache_read, 0) AS INTEGER) AS cacheReadTokens,
      CAST(COALESCE(tokens_cache_write, 0) AS INTEGER) AS cacheWriteTokens,
      CAST(COALESCE(cost, 0) AS REAL) AS cost
    FROM session
    WHERE (${SESSION_TOKEN_EXPR}) > 0
  `;

  const HISTORY_EXISTS_SQL = `
    SELECT 1 AS present
    FROM message
    WHERE json_valid(data)
      AND json_extract(data, '$.providerID') = 'opencode-go'
      AND json_extract(data, '$.role') = 'assistant'
      AND json_type(data, '$.cost') IN ('integer', 'real')
    LIMIT 1
  `;

  const HISTORY_ROWS_SQL = `
    SELECT
      CAST(COALESCE(json_extract(data, '$.time.created'), time_created) AS INTEGER) AS createdMs,
      CAST(json_extract(data, '$.cost') AS REAL) AS cost
    FROM message
    WHERE json_valid(data)
      AND json_extract(data, '$.providerID') = 'opencode-go'
      AND json_extract(data, '$.role') = 'assistant'
      AND json_type(data, '$.cost') IN ('integer', 'real')
  `;

  function readNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }

  function readString(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  function toIso(ms) {
    if (!Number.isFinite(ms)) return null;
    return new Date(ms).toISOString();
  }

  function startOfUtcWeek(nowMs) {
    const date = new Date(nowMs);
    const offset = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - offset);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }

  function startOfUtcMonth(nowMs) {
    const date = new Date(nowMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1, 0, 0, 0, 0);
  }

  function startOfNextUtcMonth(nowMs) {
    const date = new Date(nowMs);
    return Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      1,
      0,
      0,
      0,
      0,
    );
  }

  function shiftMonth(year, month, delta) {
    const total = year * 12 + month + delta;
    return [Math.floor(total / 12), ((total % 12) + 12) % 12];
  }

  function anchorMonth(year, month, anchorDate) {
    const maxDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return Date.UTC(
      year,
      month,
      Math.min(anchorDate.getUTCDate(), maxDay),
      anchorDate.getUTCHours(),
      anchorDate.getUTCMinutes(),
      anchorDate.getUTCSeconds(),
      anchorDate.getUTCMilliseconds(),
    );
  }

  function anchoredMonthBounds(nowMs, anchorMs) {
    if (!Number.isFinite(anchorMs)) {
      const startMs = startOfUtcMonth(nowMs);
      return { startMs, endMs: startOfNextUtcMonth(nowMs) };
    }

    const nowDate = new Date(nowMs);
    const anchorDate = new Date(anchorMs);
    let year = nowDate.getUTCFullYear();
    let month = nowDate.getUTCMonth();
    let startMs = anchorMonth(year, month, anchorDate);

    if (startMs > nowMs) {
      const previous = shiftMonth(year, month, -1);
      year = previous[0];
      month = previous[1];
      startMs = anchorMonth(year, month, anchorDate);
    }

    const next = shiftMonth(year, month, 1);
    return {
      startMs,
      endMs: anchorMonth(next[0], next[1], anchorDate),
    };
  }

  function sumRange(rows, startMs, endMs) {
    let total = 0;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.createdMs < startMs || row.createdMs >= endMs) continue;
      total += row.cost;
    }
    return Math.round(total * 10000) / 10000;
  }

  function nextRollingReset(rows, nowMs) {
    const startMs = nowMs - FIVE_HOURS_MS;
    let oldest = null;
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.createdMs < startMs || row.createdMs >= nowMs) continue;
      if (oldest === null || row.createdMs < oldest) oldest = row.createdMs;
    }
    return toIso((oldest === null ? nowMs : oldest) + FIVE_HOURS_MS);
  }

  function queryRows(ctx, sql) {
    try {
      const raw = ctx.host.sqlite.query(DB_PATH, sql);
      if (typeof raw === "string" && raw.trim() === "") {
        return { ok: true, rows: [] };
      }
      const rows = Array.isArray(raw) ? raw : ctx.util.tryParseJson(raw);
      if (!Array.isArray(rows)) {
        ctx.host.log.warn("sqlite query returned non-array result");
        return { ok: false, rows: [] };
      }
      return { ok: true, rows };
    } catch (e) {
      ctx.host.log.warn("sqlite query failed: " + String(e));
      return { ok: false, rows: [] };
    }
  }

  function loadAuthKey(ctx) {
    if (!ctx.host.fs.exists(AUTH_PATH)) return null;

    try {
      const text = ctx.host.fs.readText(AUTH_PATH);
      const parsed = ctx.util.tryParseJson(text);
      if (!parsed || typeof parsed !== "object") {
        ctx.host.log.warn("opencode auth file is not valid json");
        return null;
      }
      for (let i = 0; i < AUTH_PROVIDER_IDS.length; i += 1) {
        const entry = parsed[AUTH_PROVIDER_IDS[i]];
        if (!entry || typeof entry !== "object") continue;
        const key = typeof entry.key === "string" ? entry.key.trim() : "";
        if (key) return key;
      }
      return null;
    } catch (e) {
      ctx.host.log.warn("opencode auth read failed: " + String(e));
      return null;
    }
  }

  function hasHistory(ctx) {
    const sessionResult = queryRows(ctx, SESSION_EXISTS_SQL);
    if (sessionResult.ok && sessionResult.rows.length > 0) return { ok: true, present: true };

    const legacyResult = queryRows(ctx, HISTORY_EXISTS_SQL);
    if (legacyResult.ok) return { ok: true, present: legacyResult.rows.length > 0 };
    if (sessionResult.ok) return { ok: true, present: false };
    return { ok: false, present: false };
  }

  function normalizeModelId(value) {
    const raw = readString(value);
    if (!raw) return null;
    let modelId = raw.toLowerCase();
    const slash = modelId.lastIndexOf("/");
    if (slash >= 0) modelId = modelId.slice(slash + 1);
    return modelId.replace(/:cloud$/, "");
  }

  function priceKeyForModel(modelId, totalContextTokens) {
    if ((modelId === "qwen3.7-plus" || modelId === "qwen3.6-plus") && totalContextTokens > 256000) {
      return modelId + "-large";
    }
    return modelId;
  }

  function estimateSessionCost(row) {
    const providerId = readString(row.providerId);
    if (providerId !== "opencode") return null;

    const modelId = normalizeModelId(row.modelId);
    if (!modelId) return null;
    if (modelId.indexOf("-free") !== -1) return 0;

    const input = readNumber(row.inputTokens) || 0;
    const output = readNumber(row.outputTokens) || 0;
    const reasoning = readNumber(row.reasoningTokens) || 0;
    const cacheRead = readNumber(row.cacheReadTokens) || 0;
    const cacheWrite = readNumber(row.cacheWriteTokens) || 0;
    const totalContext = input + output + reasoning + cacheRead + cacheWrite;
    const price = MODEL_PRICES[priceKeyForModel(modelId, totalContext)];
    if (!price) return null;

    return (
      (input / 1000000) * price[0] +
      ((output + reasoning) / 1000000) * price[1] +
      (cacheRead / 1000000) * price[2] +
      (cacheWrite / 1000000) * price[3]
    );
  }

  function loadSessionHistory(ctx) {
    const result = queryRows(ctx, SESSION_ROWS_SQL);
    if (!result.ok) return result;

    const rows = [];
    for (let i = 0; i < result.rows.length; i += 1) {
      const row = result.rows[i];
      if (!row || typeof row !== "object") continue;
      const createdMs = readNumber(row.createdMs);
      const storedCost = readNumber(row.cost);
      if (createdMs === null || createdMs <= 0) continue;
      const cost = storedCost && storedCost > 0 ? storedCost : estimateSessionCost(row);
      if (cost === null || cost < 0) continue;
      rows.push({ createdMs, cost });
    }

    return { ok: true, rows };
  }

  function loadLegacyHistory(ctx) {
    const result = queryRows(ctx, HISTORY_ROWS_SQL);
    if (!result.ok) return result;

    const rows = [];
    for (let i = 0; i < result.rows.length; i += 1) {
      const row = result.rows[i];
      if (!row || typeof row !== "object") continue;
      const createdMs = readNumber(row.createdMs);
      const cost = readNumber(row.cost);
      if (createdMs === null || createdMs <= 0) continue;
      if (cost === null || cost < 0) continue;
      rows.push({ createdMs, cost });
    }

    return { ok: true, rows };
  }

  function loadHistory(ctx) {
    const sessionResult = loadSessionHistory(ctx);
    if (sessionResult.ok && sessionResult.rows.length > 0) return sessionResult;

    const legacyResult = loadLegacyHistory(ctx);
    if (legacyResult.ok) return legacyResult;
    return sessionResult;
  }

  function buildProgressLines(ctx, rows, nowMs) {
    const sessionStartMs = nowMs - FIVE_HOURS_MS;
    const weeklyStartMs = startOfUtcWeek(nowMs);
    const weeklyEndMs = weeklyStartMs + WEEK_MS;
    let earliestMs = null;
    for (let i = 0; i < rows.length; i += 1) {
      const createdMs = rows[i].createdMs;
      if (!Number.isFinite(createdMs)) continue;
      if (earliestMs === null || createdMs < earliestMs) earliestMs = createdMs;
    }
    const monthBounds = anchoredMonthBounds(nowMs, earliestMs);
    const monthlyStartMs = monthBounds.startMs;
    const monthlyEndMs = monthBounds.endMs;

    const sessionCost = sumRange(rows, sessionStartMs, nowMs);
    const weeklyCost = sumRange(rows, weeklyStartMs, weeklyEndMs);
    const monthlyCost = sumRange(rows, monthlyStartMs, monthlyEndMs);

    return [
      ctx.line.progress({
        label: "Session",
        used: sessionCost,
        limit: LIMITS.session,
        format: { kind: "dollars" },
        resetsAt: nextRollingReset(rows, nowMs),
        periodDurationMs: FIVE_HOURS_MS,
      }),
      ctx.line.progress({
        label: "Weekly",
        used: weeklyCost,
        limit: LIMITS.weekly,
        format: { kind: "dollars" },
        resetsAt: toIso(weeklyEndMs),
        periodDurationMs: WEEK_MS,
      }),
      ctx.line.progress({
        label: "Monthly",
        used: monthlyCost,
        limit: LIMITS.monthly,
        format: { kind: "dollars" },
        resetsAt: toIso(monthlyEndMs),
        periodDurationMs: monthlyEndMs - monthlyStartMs,
      }),
    ];
  }

  function buildSoftEmptyLines(ctx) {
    return [
      ctx.line.badge({
        label: "Status",
        text: "No usage data",
        color: "#a3a3a3",
      }),
    ];
  }

  function probe(ctx) {
    const authKey = loadAuthKey(ctx);
    const history = hasHistory(ctx);
    const detected = !!authKey || (history.ok && history.present);

    if (!detected) {
      throw "OpenCode Go not detected. Log in with OpenCode Go or use it locally first.";
    }

    if (!history.ok) {
      return { plan: "Go", lines: buildSoftEmptyLines(ctx) };
    }

    const rowsResult = loadHistory(ctx);
    if (!rowsResult.ok) {
      return { plan: "Go", lines: buildSoftEmptyLines(ctx) };
    }

    return {
      plan: "Go",
      lines: buildProgressLines(ctx, rowsResult.rows, Date.now()),
    };
  }

  globalThis.__openusage_plugin = { id: PROVIDER_ID, probe };
})();
