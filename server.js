/**
 * TAlgo AI Dashboard — server.js
 * ================================
 * Express server that:
 *  - Parses your engine .log file
 *  - Exposes REST endpoints for the React frontend
 *  - Calls Gemini API for per-trade analysis
 *
 * Usage:
 *   cp .env.example .env      # fill in keys + log path
 *   node server.js
 *   open http://localhost:3000
 *
 * On AWS:  open port 3000 in security group, access via http://<ip>:3000
 */

import express    from "express";
import https      from "https";
import path       from "path";
import { fileURLToPath } from "url";
import { loadEnv }       from "./env.js";
import { parseLog, tradeToGeminiPayload } from "./parse-log.js";

loadEnv();

const __dirname      = path.dirname(fileURLToPath(import.meta.url));
const PORT           = process.env.PORT           || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const LOG_FILE       = process.env.LOG_FILE       || "./natgas-out.log";
const GEMINI_MODEL   = "gemini-flash-lite-latest";
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// ─── Gemini ────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are TAlgo AI — an expert analyst for the TAlgo algorithmic trading engine running on MCX commodity futures (NatGas Mini, Zinc).

The engine uses a dual-SuperTrend system:
- ST1 (10,1) and ST2 (10,2) must both agree (bothAgree=true) for entry.
- Glyphs: ▲▲ both UP, ▼▼ both DOWN, ▲▼ or ▼▲ = disagreement.
- Choppiness Index gates entries: high chop (>56) blocks entry.
- Exit reasons: HM_EXIT (profit protection), ST_FLIP (SuperTrend flip), SL_ST (stop loss), EOD_FORCE (end-of-day).
- exit_type STOP = stop-loss band hit. EXIT = signal-based exit.
- peak_pnl = best unrealised PnL during trade (₹). trough_pnl = worst drawdown (₹).

Respond in EXACTLY this JSON format, no other text:
{
  "entry_rationale": "2 sentences",
  "indicator_state": "2 sentences",
  "trade_behaviour": "2 sentences",
  "exit_quality": "2 sentences",
  "grade": "A",
  "takeaway": "one line"
}
Grade A = clean setup + good execution. B = decent setup or decent execution. C = poor setup or poor execution.`;

function callGemini(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ parts: [{ text: `Analyse this trade:\n${JSON.stringify(payload, null, 2)}` }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
    });

    const req = https.request(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", c => data += c);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json.error) return reject(new Error(json.error.message));
          let text = json.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || "{}";
          // Strip markdown fences if Gemini wraps in ```json
          text = text.replace(/^```json\s*/i, "").replace(/```$/, "").trim();
          resolve(JSON.parse(text));
        } catch (e) {
          reject(new Error("Failed to parse Gemini response: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Express ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// GET /api/sessions — all sessions + trades (no AI, fast)
app.get("/api/sessions", (req, res) => {
  try {
    const sessions = parseLog(LOG_FILE);
    // Strip candles array to keep payload small
    const slim = sessions.map(s => ({
      ...s,
      trades: s.trades.map(t => ({ ...t, candles: undefined })),
    }));
    res.json({ ok: true, sessions: slim });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/analyse — { date, tradeIndex } → Gemini analysis
app.post("/api/analyse", async (req, res) => {
  const { date, tradeIndex } = req.body;
  if (!GEMINI_API_KEY) return res.status(500).json({ ok: false, error: "GEMINI_API_KEY not set in .env" });

  try {
    const sessions = parseLog(LOG_FILE);
    const session  = sessions.find(s => s.date === date);
    if (!session) return res.status(404).json({ ok: false, error: `No session for date ${date}` });

    const trade = session.trades[tradeIndex];
    if (!trade)  return res.status(404).json({ ok: false, error: `No trade at index ${tradeIndex}` });

    const payload  = tradeToGeminiPayload(trade);
    const analysis = await callGemini(payload);
    res.json({ ok: true, analysis });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/analyse-session — analyse all trades in a session
app.post("/api/analyse-session", async (req, res) => {
  const { date } = req.body;
  if (!GEMINI_API_KEY) return res.status(500).json({ ok: false, error: "GEMINI_API_KEY not set in .env" });

  try {
    const sessions = parseLog(LOG_FILE);
    const session  = sessions.find(s => s.date === date);
    if (!session) return res.status(404).json({ ok: false, error: `No session for date ${date}` });

    const results = [];
    for (let i = 0; i < session.trades.length; i++) {
      const trade = session.trades[i];
      try {
        const payload  = tradeToGeminiPayload(trade);
        const analysis = await callGemini(payload);
        console.log(`Trade ${i+1} ok: grade ${analysis.grade}`);
        results.push(analysis);
      } catch (e) {
        console.error(`Trade ${i+1} failed: ${e.message}`);
        results.push({ entry_rationale: "Parse error", indicator_state: "", trade_behaviour: "", exit_quality: "", grade: "C", takeaway: e.message });
      }
      await new Promise(r => setTimeout(r, 1200));
    }
    console.log("Sending", results.length, "analyses to client");
    res.json({ ok: true, analyses: results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  TAlgo AI Dashboard`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  Log file: ${LOG_FILE}`);
  console.log(`  Gemini: ${GEMINI_API_KEY ? "✓ key loaded" : "✗ GEMINI_API_KEY missing"}\n`);
});
