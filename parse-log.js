/**
 * parse-log.js — TAlgo .log file parser (v2)
 * Handles ANSI escape codes, both old (F-prefix, single glyph) and
 * new (dual glyph) log formats across NatGas and NatGas Mini sessions.
 */

import { readFileSync } from "fs";

// Strip ANSI escape codes
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;]*m/g, "");
}

// ─── Regex patterns (applied after ANSI strip) ─────────────────────────────

// Banner: --- NatGas Mini  17/6/2026, 08:44:59 ---
const RE_BANNER  = /---\s+(.+?)\s+(\d{1,2}\/\d{1,2}\/\d{4}),\s+[\d:]+\s+---/;

// Entry (both formats):
//   F SHORT ENTRY @ 298.50  Tr:302.15  ST1:-1 ST2:-1
//   SHORT ENTRY @ 298.50  Tr:302.48
const RE_ENTRY   = /(?:F\s+)?(LONG|SHORT)\s+ENTRY\s+@\s+([\d.]+)\s+Tr:([\d.]+)/;

// Exit/Stop (both formats):
//   F SHORT STOP @ 297.90  /  SHORT STOP (SL) @ 297.90 trail:...  /  SHORT EXIT @ ...
const RE_EXIT    = /(?:F\s+)?(LONG|SHORT)\s+(EXIT|STOP)\s+(?:\([^)]+\)\s+)?@\s+([\d.]+)/;

// Exit detail lines
const RE_REASON  = /reason:\s+(\S+)\s+entry:\s+([\d.]+)/;
const RE_PNL     = /pnl:\s+([+-]?[\d.]+)\s+session:\s+([+-]?[\d.]+)/;

// Active candle — dual glyph new format:  09:30:10 ▼▼  298.00  AGR  F   +125  +125
// Active candle — dual glyph clean:       10:00:10 ▼▼  297.80     +175    +175
const RE_CANDLE_DUAL = /(\d{2}:\d{2}:\d{2})\s+(▲▲|▼▼|▲▼|▼▲)\s+([\d.]+)\s+(?:AGR|DIS)?\s*(?:F\s+)?([+-]?\d+)\s+([+-]?\d+)/;

// Active candle — single glyph old format:  10:00:10 ▼  298.00  AGR  F   +125  +125
const RE_CANDLE_SINGLE = /(\d{2}:\d{2}:\d{2})\s+(▲|▼)\s+([\d.]+)\s+(?:AGR|DIS)?\s*(?:\S+\s+)?([+-]?\d+)\s+([+-]?\d+)/;

// Blocked candle (new format):  13:15:10 ▲▼  298.20  LONG [DIS CHOP:59.6]
const RE_BLOCKED = /(\d{2}:\d{2}:\d{2})\s+(▲▲|▼▼|▲▼|▼▲|▲|▼)\s+([\d.]+)\s+(LONG|SHORT)\s+(?:blocked\s+)?\[([^\]]+)\]/;

// Session PnL — handles both "pnl :" and "fast :"
const RE_SESSION = /(?:pnl|fast)\s*:\s*([+-]?[\d.]+)/;

// ─── Glyph decoder ─────────────────────────────────────────────────────────

function decodeGlyphs(glyph) {
  if (glyph.length === 1) {
    // Single glyph old format — ST1 only
    return { st1: glyph === "▲" ? "UP" : "DOWN", st2: null, bothAgree: true };
  }
  return {
    st1: glyph[0] === "▲" ? "UP" : "DOWN",
    st2: glyph[1] === "▲" ? "UP" : "DOWN",  // note: ▲ is 3 bytes in UTF-8, but JS sees it as 1 char
    bothAgree: glyph[0] === glyph[1],
  };
}

// Safer: compare actual characters since ▲▼ are multi-byte
function decodeGlyphsSafe(glyph) {
  const chars = [...glyph]; // spread into codepoints
  if (chars.length === 1) {
    return { st1: chars[0] === "▲" ? "UP" : "DOWN", st2: null, bothAgree: true };
  }
  return {
    st1: chars[0] === "▲" ? "UP" : "DOWN",
    st2: chars[1] === "▲" ? "UP" : "DOWN",
    bothAgree: chars[0] === chars[1],
  };
}

// ─── Parser ────────────────────────────────────────────────────────────────

export function parseLog(filepath) {
  const raw   = readFileSync(filepath, "utf8");
  const lines = raw.split("\n").map(l => stripAnsi(l).trim());

  const sessions  = [];
  let   session   = null;
  let   trade     = null;
  let   pendingExit = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // ── Banner ──────────────────────────────────────────────────────────
    const banner = line.match(RE_BANNER);
    if (banner) {
      if (session) sessions.push(session);
      session = {
        instrument:     banner[1].trim(),
        date:           banner[2],
        trades:         [],
        sessionPnl:     null,
        blockedCandles: [],
      };
      trade       = null;
      pendingExit = null;
      continue;
    }

    if (!session) continue;

    // ── Entry ────────────────────────────────────────────────────────────
    const entry = line.match(RE_ENTRY);
    if (entry) {
      trade = {
        date:            session.date,
        instrument:      session.instrument,
        side:            entry[1],
        entry:           parseFloat(entry[2]),
        trailAtEntry:    parseFloat(entry[3]),
        exit:            null,
        exitType:        null,
        exitReason:      null,
        pnl:             null,
        sessionAtExit:   null,
        candles:         [],
        peakPnl:         0,
        troughPnl:       0,
        durationCandles: 0,
      };
      pendingExit = null;
      continue;
    }

    // ── Active candle ────────────────────────────────────────────────────
    if (trade && !trade.exit) {
      const cd = line.match(RE_CANDLE_DUAL) || line.match(RE_CANDLE_SINGLE);
      if (cd) {
        const glyphs   = decodeGlyphsSafe(cd[2]);
        const tradePnl = parseInt(cd[4]);
        trade.candles.push({
          time:      cd[1],
          glyph:     cd[2],
          ...glyphs,
          price:     parseFloat(cd[3]),
          tradePnl,
          sessionPnl: parseInt(cd[5]),
        });
        trade.durationCandles++;
        if (tradePnl > trade.peakPnl)   trade.peakPnl   = tradePnl;
        if (tradePnl < trade.troughPnl) trade.troughPnl = tradePnl;
        continue;
      }
    }

    // ── Blocked candle ───────────────────────────────────────────────────
    if (!trade || trade.exit) {
      const bl = line.match(RE_BLOCKED);
      if (bl) {
        const filterText = bl[5];
        const chopMatch  = filterText.match(/CHOP:([\d.]+)/);
        session.blockedCandles.push({
          time:       bl[1],
          glyph:      bl[2],
          signal:     bl[4],
          filterType: filterText.includes("DIS") ? "DISAGREE" : "CHOP",
          chop:       chopMatch ? parseFloat(chopMatch[1]) : null,
        });
        continue;
      }
    }

    // ── Exit line ────────────────────────────────────────────────────────
    const exitLine = line.match(RE_EXIT);
    if (exitLine && trade && !trade.exit) {
      trade.exit     = parseFloat(exitLine[3]);
      trade.exitType = exitLine[2];
      pendingExit    = trade;
      continue;
    }

    // ── Exit reason + PnL ────────────────────────────────────────────────
    if (pendingExit) {
      const reason = line.match(RE_REASON);
      if (reason) { pendingExit.exitReason = reason[1]; continue; }

      const pnl = line.match(RE_PNL);
      if (pnl) {
        pendingExit.pnl          = parseFloat(pnl[1]);
        pendingExit.sessionAtExit = parseFloat(pnl[2]);
        session.trades.push(pendingExit);
        trade       = null;
        pendingExit = null;
        continue;
      }
    }

    // ── Session PnL ──────────────────────────────────────────────────────
    const spnl = line.match(RE_SESSION);
    if (spnl && line.match(/(?:pnl|fast)\s*:/)) {
      session.sessionPnl = parseFloat(spnl[1]);
    }
  }

  if (session) sessions.push(session);

  // Merge sessions with same date (engine restarts mid-day create duplicate banners)
  const merged = [];
  for (const s of sessions) {
    const existing = merged.find(m => m.date === s.date && m.instrument === s.instrument);
    if (existing) {
      existing.trades.push(...s.trades);
      existing.blockedCandles.push(...s.blockedCandles);
      if (s.sessionPnl !== null) existing.sessionPnl = s.sessionPnl;
    } else {
      merged.push(s);
    }
  }

  return merged;
}

// ─── Gemini payload builder ────────────────────────────────────────────────

export function tradeToGeminiPayload(trade) {
  const first = trade.candles[0];
  const last  = trade.candles[trade.candles.length - 1];

  return {
    instrument:       trade.instrument,
    date:             trade.date,
    side:             trade.side,
    entry:            trade.entry,
    exit:             trade.exit,
    exit_type:        trade.exitType,
    exit_reason:      trade.exitReason,
    pnl_inr:          trade.pnl,
    session_pnl:      trade.sessionAtExit,
    duration_candles: trade.durationCandles,
    trail_at_entry:   trade.trailAtEntry,
    peak_pnl:         trade.peakPnl,
    trough_pnl:       trade.troughPnl,
    st_at_entry:      first ? { glyph: first.glyph, st1: first.st1, st2: first.st2, bothAgree: first.bothAgree } : null,
    st_at_exit:       last  ? { glyph: last.glyph,  st1: last.st1,  st2: last.st2,  bothAgree: last.bothAgree  } : null,
    had_disagreement: trade.candles.some(c => !c.bothAgree),
  };
}
