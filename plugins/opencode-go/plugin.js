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
  const MODEL_PRICES = {
    "glm-5.1": { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
    "glm-5": { input: 1, output: 3.2, cacheRead: 0.2, cacheWrite: 0 },
    "kimi-k2.6": { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
    "kimi-k2.5": { input: 0.6, output: 3, cacheRead: 0.1, cacheWrite: 0 },
    "mimo-v2.5": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    "mimo-v2.5-pro": { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
    "minimax-m3": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
    "minimax-m2.7": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    "minimax-m2.5": { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0.375 },
    "qwen3.7-max": { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
    "qwen3.7-plus": { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
    "qwen3.7-plus-large": { input: 1.2, output: 4.8, cacheRead: 0.12, cacheWrite: 1.5 },
    "qwen3.6-plus": { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
    "qwen3.6-plus-large": { input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2.5 },
    "deepseek-v4-pro": { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
    "deepseek-v4-flash": { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
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
      CASE
        WHEN json_valid(model) THEN json_extract(model, '$.id')
        ELSE model
      END AS modelId,
      CASE
        WHEN json_valid(model) THEN json_extract(model, '$.providerID')
        ELSE NULL
      END AS providerId,
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

  const DAILY_SQL = `
    SELECT
      DATE(time_created / 1000, 'unixepoch', 'localtime') AS day,
      CASE
        WHEN json_valid(model) THEN json_extract(model, '$.id')
        ELSE model
      END AS modelId,
      CASE
        WHEN json_valid(model) THEN json_extract(model, '$.providerID')
        ELSE NULL
      END AS providerId,
      SUM(COALESCE(tokens_input, 0)) AS inputTokens,
      SUM(COALESCE(tokens_output, 0)) AS outputTokens,
      SUM(COALESCE(tokens_reasoning, 0)) AS reasoningTokens,
      SUM(COALESCE(tokens_cache_read, 0)) AS cacheReadTokens,
      SUM(COALESCE(tokens_cache_write, 0)) AS cacheWriteTokens,
      SUM(COALESCE(cost, 0)) AS cost
    FROM session
    WHERE (${SESSION_TOKEN_EXPR}) > 0
    GROUP BY day, modelId, providerId
    ORDER BY day ASC
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

  function readNowMs() {
    return Date.now();
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
      total += row.value;
    }
    return Math.round(total * 10000) / 10000;
  }

  function normalizeModelId(value) {
    const raw = readString(value);
    if (!raw) return null;
    let modelId = raw.toLowerCase();
    const slash = modelId.lastIndexOf("/");
    if (slash >= 0) modelId = modelId.slice(slash + 1);
    return modelId.replace(/:cloud$/, "");
  }

  function selectPriceKey(modelId, totalContextTokens) {
    if (
      (modelId === "qwen3.7-plus" || modelId === "qwen3.6-plus") &&
      totalContextTokens > 256000
    ) {
      return modelId + "-large";
    }
    return modelId;
  }

  function estimateCost(row) {
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
    const priceKey = selectPriceKey(modelId, totalContext);
    const price = MODEL_PRICES[priceKey];
    if (!price) return null;

    return (
      (input / 1000000) * price.input +
      ((output + reasoning) / 1000000) * price.output +
      (cacheRead / 1000000) * price.cacheRead +
      (cacheWrite / 1000000) * price.cacheWrite
    );
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
      if (typeof raw === "string" && raw.trim() === "") return { ok: true, rows: [] };
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
    const result = queryRows(ctx, SESSION_EXISTS_SQL);
    if (result.ok && result.rows.length > 0) return { ok: true, present: true };
    if (!result.ok) return { ok: false, present: false };

    const fallback = queryRows(ctx, HISTORY_EXISTS_SQL);
    if (!fallback.ok) return { ok: false, present: false };
    return { ok: true, present: fallback.rows.length > 0 };
  }

  function loadSessionUsage(ctx) {
    const result = queryRows(ctx, SESSION_ROWS_SQL);
    if (!result.ok) return { ok: false, present: false };

    const rows = [];
    for (let i = 0; i < result.rows.length; i += 1) {
      const row = result.rows[i];
      if (!row || typeof row !== "object") continue;
      const createdMs = readNumber(row.createdMs);
      const storedCost = readNumber(row.cost);
      if (createdMs === null || createdMs <= 0) continue;
      const cost = storedCost && storedCost > 0 ? storedCost : estimateCost(row);
      if (cost === null || cost < 0) continue;
      rows.push({ createdMs, value: cost });
    }

    return { ok: true, rows, mode: "cost" };
  }

  function loadLegacyCostHistory(ctx) {
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
      rows.push({ createdMs, value: cost });
    }

    return { ok: true, rows, mode: "cost" };
  }

  function loadHistory(ctx) {
    const sessionUsage = loadSessionUsage(ctx);
    if (!sessionUsage.ok) return sessionUsage;
    if (sessionUsage.rows.length > 0) return sessionUsage;
    return loadLegacyCostHistory(ctx);
  }

  function loadDailyData(ctx) {
    const result = queryRows(ctx, DAILY_SQL);
    if (!result.ok) return [];

    const dayMap = {};
    for (let i = 0; i < result.rows.length; i += 1) {
      try {
        const row = result.rows[i];
        if (!row || typeof row !== "object") continue;
        const day = readString(row.day);
        if (!day) continue;

        const providerId = readString(row.providerId);
        if (providerId !== "opencode-go" && providerId !== "opencode") continue;

        let entry = dayMap[day];
        if (!entry) {
          entry = { day: day, totalTokens: 0, totalCost: 0, models: {} };
          dayMap[day] = entry;
        }

        const input = readNumber(row.inputTokens) || 0;
        const output = readNumber(row.outputTokens) || 0;
        const reasoning = readNumber(row.reasoningTokens) || 0;
        const cacheRead = readNumber(row.cacheReadTokens) || 0;
        const cacheWrite = readNumber(row.cacheWriteTokens) || 0;
        const storedCost = readNumber(row.cost) || 0;
        const total = input + output + reasoning + cacheRead + cacheWrite;

        var cost;
        if (providerId === "opencode-go" && storedCost > 0) {
          cost = storedCost;
        } else if (providerId === "opencode") {
          var estimated = estimateCost(row);
          cost = estimated !== null && estimated >= 0 ? estimated : storedCost;
        } else {
          cost = storedCost;
        }

        entry.totalTokens += total;
        entry.totalCost += cost;

        const modelId = row.modelId || "unknown";
        if (!entry.models[modelId]) {
          entry.models[modelId] = 0;
        }
        entry.models[modelId] += total;
      } catch (e) {
        ctx.host.log.warn("loadDailyData row error: " + String(e));
      }
    }

    const daily = Object.keys(dayMap).sort().map(function (day) {
      return dayMap[day];
    });

    return daily;
  }

  function dayKeyFromDate(date) {
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    return year + "-" + (month < 10 ? "0" : "") + month + "-" + (day < 10 ? "0" : "") + day;
  }

  function fmtTokens(n) {
    const abs = Math.abs(n);
    const sign = n < 0 ? "-" : "";
    const units = [
      { threshold: 1e9, divisor: 1e9, suffix: "B" },
      { threshold: 1e6, divisor: 1e6, suffix: "M" },
      { threshold: 1e3, divisor: 1e3, suffix: "K" },
    ];
    for (let i = 0; i < units.length; i += 1) {
      const unit = units[i];
      if (abs >= unit.threshold) {
        const scaled = abs / unit.divisor;
        const formatted = scaled >= 10
          ? Math.round(scaled).toString()
          : scaled.toFixed(1).replace(/\.0$/, "");
        return sign + formatted + unit.suffix;
      }
    }
    return sign + Math.round(abs).toString();
  }

  function costAndTokensLabel(cost, tokens) {
    const parts = [];
    if (cost != null && cost >= 0) parts.push("$" + cost.toFixed(2));
    if (tokens > 0) parts.push(fmtTokens(tokens) + " tokens");
    return parts.join(" · ");
  }

  function usageDayLabel(day) {
    const m = Number(day.slice(5, 7));
    const d = Number(day.slice(8, 10));
    return m + "/" + d;
  }

  function buildDailySummaryLines(lines, ctx, daily, nowMs) {
    const now = new Date(nowMs);
    const todayKey = dayKeyFromDate(now);
    const yesterday = new Date(nowMs);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayKey = dayKeyFromDate(yesterday);

    let todayEntry = null;
    let yesterdayEntry = null;
    for (let i = 0; i < daily.length; i += 1) {
      const d = daily[i];
      if (d.day === todayKey) todayEntry = d;
      if (d.day === yesterdayKey) yesterdayEntry = d;
    }

    if (todayEntry) {
      lines.push(ctx.line.text({
        label: "Today",
        value: costAndTokensLabel(todayEntry.totalCost, todayEntry.totalTokens),
      }));
    } else {
      lines.push(ctx.line.text({
        label: "Today",
        value: "$0.00 · 0 tokens",
      }));
    }

    if (yesterdayEntry) {
      lines.push(ctx.line.text({
        label: "Yesterday",
        value: costAndTokensLabel(yesterdayEntry.totalCost, yesterdayEntry.totalTokens),
      }));
    } else {
      lines.push(ctx.line.text({
        label: "Yesterday",
        value: "$0.00 · 0 tokens",
      }));
    }

    let totalCost = 0;
    let totalTokens = 0;
    for (let i = 0; i < daily.length; i += 1) {
      totalCost += daily[i].totalCost;
      totalTokens += daily[i].totalTokens;
    }
    if (totalTokens > 0) {
      lines.push(ctx.line.text({
        label: "Last 30 Days",
        value: costAndTokensLabel(totalCost, totalTokens),
      }));
    }
  }

  function buildUsageChartLine(lines, ctx, daily) {
    const points = [];
    for (let i = 0; i < daily.length; i += 1) {
      const d = daily[i];
      const tokens = d.totalTokens;
      if (tokens <= 0) continue;
      points.push({
        key: d.day,
        label: usageDayLabel(d.day),
        value: tokens,
        valueLabel: fmtTokens(tokens) + " tokens",
      });
    }

    if (points.length === 0) return;

    points.sort(function (a, b) { return a.key.localeCompare(b.key); });

    const recent = points.slice(-31);

    var chartPoints = [];
    for (let i = 0; i < recent.length; i += 1) {
      chartPoints.push({
        label: recent[i].label,
        value: recent[i].value,
        valueLabel: recent[i].valueLabel,
      });
    }

    lines.push(ctx.line.barChart({
      label: "Usage Trend",
      points: chartPoints,
      note: "Estimated from local OpenCode logs.",
      color: "#6C5CE7",
    }));
  }

  function buildModelUsageLines(lines, ctx, daily) {
    const totals = {};
    let totalTokens = 0;

    for (let i = 0; i < daily.length; i += 1) {
      const d = daily[i];
      const models = d.models;
      if (!models) continue;
      const names = Object.keys(models);
      for (let j = 0; j < names.length; j += 1) {
        const name = names[j];
        const tokens = models[name];
        if (tokens <= 0) continue;
        totals[name] = (totals[name] || 0) + tokens;
        totalTokens += tokens;
      }
    }

    if (totalTokens <= 0) return;

    const modelList = Object.keys(totals).map(function (name) {
      return { name: name, tokens: totals[name], percent: (totals[name] / totalTokens) * 100 };
    });

    modelList.sort(function (a, b) {
      if (a.tokens !== b.tokens) return b.tokens - a.tokens;
      return a.name.localeCompare(b.name);
    });

    for (let i = 0; i < modelList.length; i += 1) {
      const model = modelList[i];
      const pct = model.percent;
      var label;
      if (pct > 0 && pct < 0.1) {
        label = "<0.1%";
      } else {
        var rounded = Math.round(pct * 10) / 10;
        label = (rounded % 1 === 0 ? String(Math.round(rounded)) : String(rounded)) + "%";
      }
      lines.push(ctx.line.text({
        label: model.name,
        value: label,
      }));
    }
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

    const nowMs = readNowMs();
    const lines = buildProgressLines(ctx, rowsResult.rows, nowMs);

    if (rowsResult.rows.length > 0) {
      const daily = loadDailyData(ctx);
      if (daily.length > 0) {
        buildDailySummaryLines(lines, ctx, daily, nowMs);
        buildUsageChartLine(lines, ctx, daily);
        buildModelUsageLines(lines, ctx, daily);
      }
    }

    return {
      plan: "Go",
      lines: lines,
    };
  }

  globalThis.__openusage_plugin = { id: PROVIDER_ID, probe };
})();
