import { readFile } from "node:fs/promises";
import { makeClient } from "../lib/chain.js";
import { forecast } from "../lib/forecast.js";
import { validateSchedule } from "../lib/schedule.js";

// GET  /api/plan?example=rent|weekly          a shipped schedule, live on Pharos Pacific
// POST /api/plan  { payer, recipient, amount, every, start, count, graceHours, label }
// Read-only: the calendar, each period's nonce on chain, coverage by the payer's USDC today, gas per payment.
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));
const EXAMPLES = { rent: "rent.json", weekly: "payroll-weekly.json" };

async function body(req) {
  if (req.body != null) return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 8192) throw new Error("the schedule is too large");
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export default async function handler(req, res) {
  const send = (status, b) => res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(json(b));
  let input;
  try {
    if (req.method === "GET") {
      const name = new URL(req.url, "http://x").searchParams.get("example") ?? "rent";
      if (!EXAMPLES[name]) throw new Error("example must be rent or weekly");
      input = JSON.parse(await readFile(new URL(`../schedules/${EXAMPLES[name]}`, import.meta.url), "utf8"));
    } else if (req.method === "POST") {
      try {
        input = await body(req);
      } catch (e) {
        throw new Error(/too large/.test(e.message) ? e.message : "the request body is not valid JSON");
      }
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("send a JSON object: { payer, recipient, amount, every, start, count }");
    } else return send(405, { ok: false, error: "GET or POST" });
    validateSchedule(input);
  } catch (e) {
    return send(400, { ok: false, error: e.message });
  }
  try {
    return send(200, { ok: true, network: "Pharos Pacific Mainnet", recordedAt: new Date().toISOString(), ...(await forecast(input, { client: makeClient() })) });
  } catch (e) {
    const busy = /timeout|ECONN|fetch failed|unreachable|429|rate/i.test(e.message);
    return send(busy ? 503 : 500, { ok: false, error: busy ? "The Pharos Pacific RPC is not answering right now. Try again in a minute." : e.message.split("\n")[0] });
  }
}
