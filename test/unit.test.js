import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { dueAt, iso, parseAmount, periodNonce, periods, scheduleId, validateSchedule } from "../lib/schedule.js";
import { cancelTypedData, checkSignatures, payCall, periodTypedData, scheduleTypedData } from "../lib/authorize.js";
import { derive, fmt } from "../lib/agent.js";
import { openStore } from "../lib/ledger.js";
import { ABI, USDC } from "../lib/contracts.js";

const P = "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d";
const R = "0x1111111111111111111111111111111111111111";
const base = { payer: P, recipient: R, amount: "250", every: "weekly", start: "2026-11-16T09:00:00Z", count: 4, graceHours: 48 };
const days = (s) => s.map((t) => iso(t).slice(0, 10));

// ───────── schedule ─────────
test("monthly keeps its day: the 31st becomes Feb 28 (29 in a leap year) and is the 31st again in March", () => {
  const s = validateSchedule({ ...base, every: "monthly", start: "2026-12-31T12:00:00Z", count: 5, graceHours: 72 });
  assert.deepEqual(days(periods(s).map((p) => p.due)), ["2026-12-31", "2027-01-31", "2027-02-28", "2027-03-31", "2027-04-30"]);
  const leap = validateSchedule({ ...base, every: "monthly", start: "2028-01-31T00:00:00Z", count: 2, graceHours: 72 });
  assert.equal(iso(dueAt(leap, 1)), "2028-02-29T00:00:00Z");
  assert.equal(iso(periods(s)[0].due), "2026-12-31T12:00:00Z", "same time of day");
});

test("weekly: every 7 days at the same second; offsets in the start are honoured", () => {
  const s = validateSchedule({ ...base, start: "2026-11-16T06:00:00-03:00" });
  assert.deepEqual(periods(s).map((p) => iso(p.due)), ["2026-11-16T09:00:00Z", "2026-11-23T09:00:00Z", "2026-11-30T09:00:00Z", "2026-12-07T09:00:00Z"]);
});

test("each period's window: valid from its due second (validAfter = due − 1) to the end of the grace", () => {
  const [p] = periods(validateSchedule(base));
  assert.equal(p.validAfter, p.due - 1);
  assert.equal(p.validBefore, p.due + 48 * 3600);
});

test("validation says what is wrong", () => {
  const bad = (x, re) => assert.throws(() => validateSchedule({ ...base, ...x }), re);
  bad({ payer: "0x12" }, /payer: an address/);
  bad({ recipient: P }, /recipient is the payer itself/);
  bad({ token: "WPROS" }, /not supported: USDC/);
  bad({ amount: "1.0000001" }, /more than 6 decimals/);
  bad({ amount: "0" }, /positive/);
  bad({ every: "daily" }, /every must be one of weekly, monthly/);
  bad({ start: "2026-11-16" }, /ISO date with a time zone/);
  bad({ start: "2026-11-16T09:00:00.500Z" }, /whole seconds/);
  bad({ count: 0 }, /count: 1 to 60/);
  bad({ count: 2.5 }, /count/);
  bad({ graceHours: 7 * 24 }, /1 to 144 for a weekly/);
  bad({ every: "monthly", graceHours: 28 * 24 }, /1 to 648 for a monthly/);
  assert.equal(parseAmount("640.5"), 640_500_000n);
});

test("the schedule id covers every field that defines a payment; nonces differ per period and per schedule", () => {
  const a = validateSchedule(base);
  for (const change of [{ amount: "251" }, { recipient: "0x2222222222222222222222222222222222222222" }, { start: "2026-11-16T09:00:01Z" }, { count: 5 }, { graceHours: 47 }, { every: "monthly" }, { salt: "2" }]) {
    assert.notEqual(validateSchedule({ ...base, ...change }).id, a.id, JSON.stringify(change));
  }
  assert.equal(validateSchedule({ ...base, label: "another label" }).id, a.id, "the label is not part of what is paid");
  const ns = periods(a).map((p) => p.nonce);
  assert.equal(new Set(ns).size, ns.length);
  assert.equal(ns[2], periodNonce(scheduleId(a), 2));
});

// ───────── authorizations ─────────
test("the payer signs one authorization per period; each checks out only for its own period", async () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const s = validateSchedule({ ...base, payer: payer.address });
  const sigs = await Promise.all(scheduleTypedData(s).map((t) => payer.signTypedData(t)));
  assert.ok(await checkSignatures(s, sigs));
  await assert.rejects(checkSignatures(s, [sigs[1], sigs[0], sigs[2], sigs[3]]), /period 1 was made by .* not the payer/);
  await assert.rejects(checkSignatures(s, sigs.slice(0, 3)), /expected 4 signatures/);
  const other = privateKeyToAccount(generatePrivateKey());
  await assert.rejects(checkSignatures(s, await Promise.all(scheduleTypedData(s).map((t) => other.signTypedData(t)))), /not the payer/);
});

test("the payment call carries exactly the period's terms; the cancel names the period's nonce", async () => {
  const payer = privateKeyToAccount(generatePrivateKey());
  const s = validateSchedule({ ...base, payer: payer.address });
  const p = periods(s)[2];
  const call = payCall(s, p, await payer.signTypedData(periodTypedData(s, p)));
  assert.equal(call.to, USDC.address);
  const d = decodeFunctionData({ abi: ABI.usdc, data: call.data });
  assert.equal(d.functionName, "transferWithAuthorization");
  assert.deepEqual(d.args.slice(0, 6), [s.payer, s.recipient, 250_000_000n, BigInt(p.validAfter), BigInt(p.validBefore), p.nonce]);
  assert.deepEqual(cancelTypedData(s, p).message, { authorizer: s.payer, nonce: p.nonce });
});

// ───────── status from chain facts + ledger ─────────
test("statuses: scheduled, due, pending, failed (with retry deadline), paid, cancelled, missed", () => {
  const s = validateSchedule({ ...base, count: 7 });
  const ps = periods(s);
  const now = ps[4].due + 3600; // period 5 is open
  const events = [
    { period: 1, type: "settled", kind: "paid", hash: "0xa1", block: 10 },
    { period: 2, type: "failed", reason: "insufficient balance: …" }, { period: 2, type: "settled", kind: "paid", hash: "0xa2", block: 20 },
    { period: 3, type: "settled", kind: "cancelled", hash: "0xc3", block: 30 },
    { period: 5, type: "failed", reason: "insufficient balance: the payer has 1 USDC, the payment is 250 USDC" },
  ];
  const consumed = [true, true, true, false, false, false, false];
  const st = derive(s, { consumed, events, now });
  assert.deepEqual(st.map((x) => x.status), ["paid", "paid", "cancelled", "missed", "failed", "scheduled", "scheduled"]);
  assert.equal(st[1].failures.length, 1, "a paid period keeps its failed attempts in its history");
  assert.equal(st[4].retryUntil, ps[4].validBefore);
  const pending = derive(s, { consumed, events: [...events, { period: 5, type: "attempt" }, { period: 5, type: "submitted", hash: "0xb5" }], now });
  assert.equal(pending[4].status, "pending");
  assert.equal(pending[4].hash, "0xb5");
  const due = derive(s, { consumed, events: events.slice(0, 4), now });
  assert.equal(due[4].status, "due");
});

test("a consumed nonce without a found log is 'settled', never claimed as paid", () => {
  const s = validateSchedule(base);
  const st = derive(s, { consumed: [true, false, false, false], events: [{ period: 1, type: "settled", kind: "before", block: 1 }], now: periods(s)[0].due + 10 });
  assert.equal(st[0].status, "settled");
  assert.match(st[0].reason, /no payment or cancellation log/);
});

test("paid is only ever what the chain says: a confirmed event without the nonce consumed is not 'paid'", () => {
  const s = validateSchedule(base);
  const ps = periods(s);
  const st = derive(s, { consumed: [false, false, false, false], events: [{ period: 1, type: "confirmed", hash: "0x1" }], now: ps[0].due + 10 });
  assert.equal(st[0].status, "due");
});

test("the ledger is append-only and survives reopening", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-"));
  const a = openStore(dir);
  a.append({ period: 1, type: "attempt" });
  a.append({ period: 1, type: "submitted", hash: "0xabc", value: 5n });
  const b = openStore(dir);
  assert.deepEqual(b.events().map((e) => [e.type, e.hash ?? null, e.value ?? null]), [["attempt", null, null], ["submitted", "0xabc", "5"]]);
});

test("amounts are formatted exactly", () => {
  assert.equal(fmt(139_890_427_209n), "139,890.427209");
  assert.equal(fmt(250_000_000n), "250");
  assert.equal(fmt(1n), "0.000001");
});
