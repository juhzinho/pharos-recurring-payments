// End-to-end, live on Pharos Pacific Mainnet (read-only: nothing is sent; test keys only sign typed data).
//   node test/e2e.js           mainnet checks (~1–2 min)
//   node test/e2e.js --fork    + the full life of a schedule on an Anvil fork (scripts/fork-proof.js)
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { makeClient } from "../lib/chain.js";
import { forecast } from "../lib/forecast.js";
import { findSettlement } from "../lib/onchain.js";
import { iso, periods, scheduleId, validateSchedule } from "../lib/schedule.js";
import { cancelTypedData, scheduleTypedData } from "../lib/authorize.js";
import { USDC } from "../lib/contracts.js";
import handler from "../api/plan.js";

const root = new URL("..", import.meta.url);
const rent = JSON.parse(readFileSync(new URL("schedules/rent.json", root), "utf8"));
const client = makeClient();
let failed = 0;
async function check(name, fn) {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)} s)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}\n   ${e.message}`);
  }
}
const cli = (...args) => spawnSync(process.execPath, ["tasks/recurring/recurring.js", ...args], { encoding: "utf8", cwd: root, env: { ...process.env, PAYER_PRIVATE_KEY: "", RELAYER_PRIVATE_KEY: "" } });

await check("plan, live: 12 monthly payments that keep their day, nonces unused on chain, coverage and gas measured", async () => {
  const f = await forecast(rent, { client });
  assert.equal(f.periods.length, 12);
  assert.deepEqual(f.periods.slice(0, 4).map((p) => p.dueIso.slice(0, 10)), ["2026-11-30", "2026-12-30", "2027-01-30", "2027-02-28"]);
  assert.ok(f.periods.every((p) => p.onChain === "unused"));
  assert.equal(f.payer.covers, Number(BigInt(f.payer.balance) / 1_850_000_000n));
  const g = Number(f.gas.perPayment.gas);
  assert.ok(g > 60_000 && g < 200_000, `gas ${g}`);
  assert.equal(f.gas.baseFeeGwei > 0, true);
});

await check("plan warns when today's balance does not cover the schedule", async () => {
  const f = await forecast({ ...rent, payer: privateKeyToAccount(generatePrivateKey()).address }, { client });
  assert.equal(f.payer.covers, 0);
  assert.match(f.warnings[0], /^today's balance covers 0 of the 12 remaining payments — the payment due 2026-11-30T09:00:00Z would fail unless the payer tops up$/);
});

await check("history from chain alone: a real Pacific authorization is found again — same block, same transaction", async () => {
  const rec = JSON.parse(readFileSync(new URL("public/runs/recovery.json", root), "utf8"));
  const st = await findSettlement(client, { payer: rec.event.authorizer, tokenAddress: USDC.address }, { nonce: rec.event.nonce }, { since: BigInt(rec.event.block - 50_000) });
  assert.equal(st.kind, "paid");
  assert.equal(st.block, rec.event.block);
  assert.equal(st.hash, rec.event.hash);
  const none = await findSettlement(client, { payer: rec.event.authorizer, tokenAddress: USDC.address }, { nonce: `0x${"ab".repeat(32)}` });
  assert.equal(none, null, "an unused nonce has no settlement");
});

await check("CLI, a whole schedule on mainnet with a test payer: new → attach → tick (due now, no USDC) → failed, nothing sent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-e2e-"));
  const payer = privateKeyToAccount(generatePrivateKey());
  const head = await client.getBlock();
  const start = iso(Number(head.timestamp) - 120); // the first payment was due two minutes ago
  const input = { label: "e2e", payer: payer.address, recipient: "0x1111111111111111111111111111111111111111", amount: "12.5", every: "weekly", start, count: 3, graceHours: 24 };
  const file = join(dir, "s.json");
  writeFileSync(file, JSON.stringify(input));
  const store = join(dir, "store");
  const n = cli("new", file, "--dir", store);
  assert.equal(n.status, 0, n.stderr);
  const toSign = JSON.parse(readFileSync(join(store, "to-sign.json"), "utf8"));
  assert.equal(toSign.length, 3);
  const s = validateSchedule(input);
  const sigs = await Promise.all(scheduleTypedData(s).map((t) => payer.signTypedData(t)));
  writeFileSync(join(dir, "sigs.json"), JSON.stringify(sigs));
  const a = cli("attach", store, "--sigs", join(dir, "sigs.json"));
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stdout, /3 signatures checked/);
  const t = cli("tick", store);
  assert.equal(t.status, 3, t.stderr);
  assert.match(t.stdout, /#1 .* FAILED +insufficient balance: the payer has 0 USDC, the payment is 12\.5 USDC — retrying until/);
  assert.match(t.stdout, /nothing was sent/);
  assert.ok(!t.stdout.includes("unsignedTransaction"));
  const st = cli("status", store, "--json");
  const r = JSON.parse(st.stdout);
  assert.deepEqual(r.periods.map((p) => p.status), ["failed", "scheduled", "scheduled"]);
  assert.equal(r.next.number, 1);
  assert.equal(r.history.filter((e) => e.type === "failed").length, 1);
  // a second tick in another block adds one more failed attempt, still nothing sent
  await new Promise((res) => setTimeout(res, 2500));
  cli("tick", store);
  const again = JSON.parse(cli("status", store, "--json").stdout);
  assert.ok(again.history.filter((e) => e.type === "failed").length <= 2);
  assert.ok(again.history.every((e) => e.type !== "submitted"));
  // cancel: what the payer signs, then the unsigned cancel transaction
  const c = cli("cancel", store, "--period", "2");
  assert.equal(c.status, 0, c.stderr);
  assert.equal(JSON.parse(c.stdout).toSign.message.nonce, r.periods[1].nonce);
  const sig = await payer.signTypedData(cancelTypedData(s, periods(s)[1]));
  assert.match(cli("cancel", store, "--period", "2", "--sig", sig).stdout, /"unsignedTransaction"/);
  const wrong = cli("cancel", store, "--period", "3", "--sig", sig); // period 2's cancellation offered for period 3
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /not the payer's cancellation of period 3/);
  assert.match(cli("cancel", store, "--period", "2", "--sig", `0x${"11".repeat(65)}`).stderr, /is not a valid signature/);
  assert.equal(scheduleId(s), r.schedule.id);
});

await check("CLI mistakes exit 2 with a plain message (and no stack trace)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-bad-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...rent, every: "daily" }));
  const empty = join(dir, "e");
  for (const [args, re] of [[["launch"], /unknown command/], [["plan", "nope.json"], /not found/], [["plan", bad], /every must be one of/], [["tick", empty], /no schedule folder/], [["plan", "schedules/rent.json", "--bogus"], /unknown flag/], [["new", "schedules/rent.json", "--dir"], /--dir needs a value/]]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(" ")} → ${r.status} ${r.stderr}`);
    assert.match(r.stderr, re);
    assert.ok(!/at .*\.js:\d+/.test(r.stderr), "no stack trace");
  }
  const store = join(dir, "s");
  cli("new", "schedules/rent.json", "--dir", store);
  assert.match(cli("sign", store).stderr, /PAYER_PRIVATE_KEY is not set/);
  writeFileSync(join(dir, "sigs.json"), JSON.stringify(Array(12).fill(`0x${"22".repeat(65)}`)));
  assert.equal(cli("attach", store, "--sigs", join(dir, "sigs.json")).status, 2);
  assert.match(cli("cancel", store, "--period", "13").stderr, /--period: 1 to 12/);
  assert.match(cli("tick", store, "--relay").stderr, /RELAYER_PRIVATE_KEY is not set/);
});

async function api(method, path, body) {
  const req = Object.assign(async function* () {}(), { method, url: path, body });
  return new Promise((resolve) => handler(req, { writeHead: (status) => ({ end: (s) => resolve({ status, json: JSON.parse(s) }) }) }));
}
await check("API: plans a shipped schedule and a posted one live; bad input is a 400", async () => {
  const a = await api("GET", "/api/plan?example=weekly");
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.periods.length, 8);
  const b = await api("POST", "/api/plan", { ...rent, count: 3, every: "weekly", graceHours: 24 });
  assert.equal(b.status, 200, JSON.stringify(b.json));
  assert.equal(b.json.periods.length, 3);
  for (const [m, p, body] of [["GET", "/api/plan?example=nope"], ["POST", "/api/plan", { ...rent, amount: "-1" }], ["POST", "/api/plan", [1]], ["DELETE", "/api/plan"]]) {
    const r = await api(m, p, body);
    assert.ok([400, 405].includes(r.status), `${m} ${p} → ${r.status}`);
    assert.equal(r.json.ok, false);
  }
});

if (process.argv.includes("--fork")) {
  await check("fork: six weeks of a schedule — on time, crash, no funds, reverted, cancelled, missed — and the history rebuilt from chain", async () => {
    const r = spawnSync(process.execPath, ["scripts/fork-proof.js"], { encoding: "utf8", cwd: root, timeout: 600_000 });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout, /authorization is used or canceled/);
    assert.match(r.stdout, /1:paid 2:paid 3:paid 4:paid 5:cancelled 6:missed · agrees with the ledger: true/);
    assert.match(r.stdout, /the recipient got 1,000 USDC in 4 transfers for 4 paid periods/);
  });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
