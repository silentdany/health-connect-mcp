import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { z } from "zod";

const root = dirname(fileURLToPath(import.meta.url));
const dataFile = process.env.DATA_FILE || join(root, "data", "snapshot.json");
const token = process.env.INGEST_TOKEN || "";
const port = Number(process.env.PORT || 8787);

const workoutSchema = z.object({
  name: z.string().max(80),
  minutes: z.number().nonnegative(),
  kcal: z.number().nonnegative().optional(),
  avgHr: z.number().nonnegative().optional(),
});

const daySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  steps: z.number().nonnegative().optional(),
  sleepMin: z.number().nonnegative().optional(),
  rhr: z.number().nonnegative().optional(),
  workouts: z.array(workoutSchema).max(20).optional(),
});

const snapshotSchema = z.object({
  days: z.array(daySchema).min(1).max(60),
});

function load() {
  try {
    return snapshotSchema.parse(JSON.parse(readFileSync(dataFile, "utf8")));
  } catch {
    return { days: [] };
  }
}

function save(snapshot) {
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(snapshot, null, 2));
}

function sleepLabel(min) {
  if (min == null) return null;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

function dayView(day) {
  return {
    date: day.date,
    steps: day.steps ?? null,
    sleep: sleepLabel(day.sleepMin),
    resting_hr: day.rhr ?? null,
    workouts: (day.workouts ?? []).map((w) => ({
      name: w.name,
      minutes: w.minutes,
      kcal: w.kcal ?? null,
      avg_hr: w.avgHr ?? null,
    })),
  };
}

function text(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    structuredContent: payload,
  };
}

function buildServer() {
  const mcp = new McpServer({ name: "health-connect", version: "0.1.0" });

  mcp.registerTool(
    "health_status",
    {
      description: "Whether a Health Connect snapshot has been pushed, and the date range. Not medical advice.",
      inputSchema: z.object({}),
    },
    async () => {
      const snap = load();
      const dates = snap.days.map((d) => d.date).sort();
      return text({
        ready: snap.days.length > 0,
        days: snap.days.length,
        from: dates[0] ?? null,
        to: dates.at(-1) ?? null,
      });
    },
  );

  mcp.registerTool(
    "health_daily_summary",
    {
      description: "Aggregated steps, sleep, resting heart rate and workouts for one day. Latest day if date is omitted.",
      inputSchema: z.object({ date: z.string().optional() }),
    },
    async ({ date }) => {
      const snap = load();
      const day = date
        ? snap.days.find((d) => d.date === date)
        : [...snap.days].sort((a, b) => a.date.localeCompare(b.date)).at(-1);
      if (!day) return text({ error: "no_data", date: date ?? null });
      return text({ tool: "health_daily_summary", ...dayView(day), note: "Aggregate only. Not medical advice." });
    },
  );

  mcp.registerTool(
    "health_weekly_summary",
    {
      description: "Averages over the stored days (max 60). No raw samples, no GPS.",
      inputSchema: z.object({}),
    },
    async () => {
      const days = load().days;
      if (!days.length) return text({ error: "no_data" });
      const n = days.length;
      const steps = days.reduce((s, d) => s + (d.steps ?? 0), 0);
      const sleep = days.filter((d) => d.sleepMin != null);
      const workouts = days.reduce((s, d) => s + (d.workouts?.length ?? 0), 0);
      return text({
        tool: "health_weekly_summary",
        days: n,
        steps_avg: Math.round(steps / n),
        sleep_avg: sleep.length
          ? sleepLabel(Math.round(sleep.reduce((s, d) => s + d.sleepMin, 0) / sleep.length))
          : null,
        workouts,
      });
    },
  );

  return mcp;
}

const app = express();
app.use(express.json({ limit: "256kb" }));

app.get("/health", (_req, res) => {
  const snap = load();
  res.json({ ok: true, days: snap.days.length });
});

app.post("/ingest", (req, res) => {
  if (!token || req.get("authorization") !== `Bearer ${token}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const parsed = snapshotSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "invalid_snapshot" });
    return;
  }
  save(parsed.data);
  res.json({ ok: true, days: parsed.data.days.length });
});

const sessions = new Map();

app.post("/mcp", async (req, res) => {
  const sid = req.get("mcp-session-id");
  const existing = sid ? sessions.get(sid) : undefined;
  if (existing) {
    await existing.transport.handleRequest(req, res, req.body);
    return;
  }
  const mcp = buildServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, mcp });
    },
  });
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "mcp_failed" });
  }
});

app.listen(port, "0.0.0.0", () => {
  console.log(`health-connect-mcp listening on ${port}`);
});
