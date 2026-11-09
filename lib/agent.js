import { checkSignatures } from "./authorize.js";
import { CHAIN_ID } from "./contracts.js";
import { findSettlement, payerState, simulatePay, used } from "./onchain.js";
import { iso, periods, validateSchedule } from "./schedule.js";

// One tick of the agent. Safe to run any number of times, from any number of places, after any crash:
//   1. read every period's nonce on chain (paid or cancelled = consumed, for good)
//   2. a consumed period the ledger does not know yet → find its block and transaction on chain, record it
//   3. the one period whose window is open (due ≤ chain time < due + grace) and not consumed:
//        a transaction already in flight → wait for it (never a second one while the first can still land)
//        not enough USDC / blacklisted / the call would revert → FAILED with the reason, nothing sent, retried next tick
//        otherwise → prepare the payment (or, as a relayer, send it: intent on disk first, then the hash)
//   4. a window that closed unpaid → MISSED: the authorization has expired, it can never be paid late by mistake
// Time is the chain's (latest block timestamp), the same clock USDC uses to judge the window.

export const STATUSES = ["scheduled", "due", "pending", "paid", "failed", "missed", "cancelled", "settled"];
const IN_FLIGHT_SECONDS = 180; // a sent transaction not seen after this long is treated as dropped (re-sending is safe)

/**
 * Starts a schedule's folder: the input as written, its id, and (once the payer has signed) the signatures — each
 * checked against its period before it is stored — plus the block they were stored at (where history searches start).
 */
export async function saveNew(store, input, { signatures = null, signedAtBlock = null } = {}) {
  const s = validateSchedule(input);
  if (signatures) await checkSignatures(s, signatures);
  store.saveSchedule({ input, id: s.id, signatures, signedAtBlock });
  return s;
}

/** schedule.json → { s, signatures, since }. The file keeps the input as written plus the id it produced. */
export function loadSchedule(saved) {
  const s = validateSchedule(saved.input);
  if (s.id !== saved.id) throw new Error("the schedule file was edited: its fields no longer give its id (and the payer's signatures would not match)");
  return { s, signatures: saved.signatures ?? null, since: BigInt(saved.signedAtBlock ?? 1) };
}

/** Derives each period's status from chain facts + the ledger. Pure: the same inputs always give the same answer. */
export function derive(s, { consumed, events, now }) {
  const byPeriod = (k) => events.filter((e) => e.period === k + 1);
  return periods(s).map((p) => {
    const ev = byPeriod(p.k);
    const base = { number: p.number, due: p.due, dueIso: iso(p.due), windowEnds: p.validBefore, windowEndsIso: iso(p.validBefore), nonce: p.nonce };
    const failures = ev.filter((e) => e.type === "failed").map((e) => ({ at: e.chainTime, reason: e.reason, hash: e.hash ?? null }));
    if (consumed[p.k]) {
      const st = ev.findLast((e) => e.type === "settled");
      // "paid" / "cancelled" only with the log that proves it; consumed without one found → "settled", said as such
      const status = st?.kind === "paid" ? "paid" : st?.kind === "cancelled" ? "cancelled" : "settled";
      return { ...base, status, hash: st?.hash ?? null, block: st?.block ?? null, paidAt: st?.time ?? null, failures, ...(status === "settled" ? { reason: "the nonce is consumed on chain, but no payment or cancellation log was found in the searched range" } : {}) };
    }
    if (now < p.due) return { ...base, status: "scheduled", failures };
    if (now >= p.validBefore) return { ...base, status: "missed", failures, reason: failures.at(-1)?.reason ?? "no payment was made inside the window" };
    const last = ev.filter((e) => ["prepared", "submitted", "confirmed", "failed", "dropped"].includes(e.type)).at(-1);
    if (last?.type === "submitted") return { ...base, status: "pending", hash: last.hash, failures };
    if (last?.type === "failed") return { ...base, status: "failed", reason: last.reason, retryUntil: p.validBefore, failures };
    return { ...base, status: "due", failures };
  });
}

export async function tick(store, { client, mode = "observe", relayer, log = () => {} } = {}) {
  const saved = store.loadSchedule();
  const { s, signatures, since } = loadSchedule(saved);
  const head = await client.getBlock();
  const now = Number(head.timestamp);
  const ps = periods(s);
  const consumed = await Promise.all(ps.map((p) => used(client, s, p, head.number)));
  let events = store.events();

  // 2. consumed on chain but not in the ledger (a crash after sending, another agent, a cancel by the payer)
  for (const p of ps) {
    if (!consumed[p.k]) continue;
    const known = events.findLast((e) => e.period === p.number && e.type === "settled");
    if (known) continue;
    const st = await findSettlement(client, s, p, { since, head: head.number });
    const mine = events.filter((e) => e.period === p.number);
    const from =
      st?.kind === "cancelled" ? "cancelled by the payer on chain"
      : mine.some((e) => e.type === "submitted" && e.hash === st?.hash) ? "this agent's transaction"
      : mine.some((e) => e.type === "attempt") ? "this agent's interrupted send: the intent was on disk, the hash was not — recovered from the chain, nothing re-sent"
      : "paid with this period's authorization by another sender — found on chain";
    store.append({ period: p.number, type: "settled", kind: st?.kind, hash: st?.hash, block: st?.block, time: st?.time, chainTime: now, source: from });
    log(`period ${p.number}: ${st?.kind} at block ${st?.block} (${from})`);
  }
  events = store.events();

  // 4. windows that closed unpaid
  for (const p of ps) if (!consumed[p.k] && now >= p.validBefore && !events.some((e) => e.period === p.number && e.type === "missed")) {
    store.append({ period: p.number, type: "missed", chainTime: now, reason: "the window closed unpaid: the authorization expired and can never be used" });
  }

  // 3. the open window (windows never overlap: grace < interval)
  const open = ps.find((p) => !consumed[p.k] && p.due <= now && now < p.validBefore);
  let action = null;
  if (open && mode !== "observe") action = await handleOpen(store, { client, s, p: open, signatures, head, now, mode, relayer, log });

  events = store.events();
  // after an action, read the chain again rather than assume what happened
  const after = action?.paid ? await Promise.all(ps.map((p) => used(client, s, p))) : consumed;
  const status = derive(s, { consumed: after, events, now });
  const next = status.find((x) => x.status === "scheduled" || x.status === "due" || x.status === "failed" || x.status === "pending");
  return { schedule: s, block: { number: Number(head.number), timestamp: now, iso: iso(now) }, periods: status, next: next ?? null, action, history: events };
}

async function handleOpen(store, { client, s, p, signatures, head, now, mode, relayer, log }) {
  const ev = store.events().filter((e) => e.period === p.number);
  if (!signatures) return { period: p.number, kind: "unsigned", note: "the payer has not signed this schedule yet" };
  const sig = signatures[p.k];

  // a transaction already sent for this period: its fate first — never a second one while it can still land
  const lastSent = ev.filter((e) => ["submitted", "confirmed", "failed", "dropped"].includes(e.type)).at(-1);
  if (lastSent?.type === "submitted") {
    const rc = await client.getTransactionReceipt({ hash: lastSent.hash }).catch(() => null);
    if (rc?.status === "success") {
      store.append({ period: p.number, type: "confirmed", hash: rc.transactionHash, block: Number(rc.blockNumber), chainTime: now });
      return { period: p.number, kind: "confirmed", hash: rc.transactionHash, paid: p.number };
    }
    if (rc?.status === "reverted") {
      const why = await revertedWhy(client, s, p, sig, rc);
      store.append({ period: p.number, type: "failed", hash: rc.transactionHash, block: Number(rc.blockNumber), reason: `transaction reverted: ${why}`, chainTime: now });
      log(`period ${p.number}: transaction ${rc.transactionHash} reverted — ${why}`);
    } else if (now - (lastSent.chainTime ?? 0) < IN_FLIGHT_SECONDS) {
      return { period: p.number, kind: "pending", hash: lastSent.hash };
    } else {
      store.append({ period: p.number, type: "dropped", hash: lastSent.hash, chainTime: now, note: `not mined after ${IN_FLIGHT_SECONDS} s; re-sending is safe — USDC accepts this period's nonce once` });
    }
  }

  // pre-checks with reasons a person understands; nothing is sent when they fail
  const w = await payerState(client, s, head.number);
  let reason = null;
  if (w.payerBlacklisted) reason = "the payer is blacklisted by USDC";
  else if (w.recipientBlacklisted) reason = "the recipient is blacklisted by USDC";
  else if (w.balance < s.amount) reason = `insufficient balance: the payer has ${fmt(w.balance)} USDC, the payment is ${fmt(s.amount)} USDC`;
  const sim = reason ? null : await simulatePay(client, s, p, sig, { from: relayer?.account?.address, blockNumber: head.number });
  if (!reason && !sim.ok) reason = sim.reason;
  if (reason) {
    const prev = ev.filter((e) => e.type === "failed").at(-1);
    // one entry per distinct reason per block (re-running a tick in the same block must not inflate the history)
    if (!(prev && prev.reason === reason && prev.block === Number(head.number))) store.append({ period: p.number, type: "failed", reason, block: Number(head.number), chainTime: now, retryUntil: p.validBefore, sent: false });
    return { period: p.number, kind: "failed", reason, retryUntil: iso(p.validBefore), sent: false };
  }

  const gas = await client.estimateGas({ account: relayer?.account?.address ?? s.recipient, to: sim.call.to, data: sim.call.data, blockNumber: head.number }).catch(() => 120_000n);
  const tx = { chainId: CHAIN_ID, to: sim.call.to, data: sim.call.data, value: "0x0", gas: `0x${((gas * 12n) / 10n).toString(16)}`, maxFeePerGas: `0x${((head.baseFeePerGas ?? 0n) * 2n).toString(16)}`, maxPriorityFeePerGas: "0x0", type: "0x2" };
  if (mode === "prepare") {
    if (!ev.some((e) => e.type === "prepared" && e.block === Number(head.number))) store.append({ period: p.number, type: "prepared", block: Number(head.number), chainTime: now });
    return { period: p.number, kind: "prepared", tx, note: "unsigned; any account can send it — the authorization only pays this period, to this recipient, inside its window, once" };
  }

  // relay: intent on disk BEFORE the transaction leaves, hash right after
  store.append({ period: p.number, type: "attempt", block: Number(head.number), chainTime: now });
  const hash = await relayer.sendTransaction({ to: tx.to, data: tx.data, gas: BigInt(tx.gas), maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: 0n, chain: relayer.chain });
  store.append({ period: p.number, type: "submitted", hash, chainTime: now });
  log(`period ${p.number}: sent ${hash}`);
  const rc = await client.waitForTransactionReceipt({ hash, timeout: 120_000 }).catch(() => null);
  if (!rc) return { period: p.number, kind: "pending", hash };
  if (rc.status === "success") {
    store.append({ period: p.number, type: "confirmed", hash, block: Number(rc.blockNumber), gasUsed: rc.gasUsed.toString(), chainTime: now });
    store.append({ period: p.number, type: "settled", kind: "paid", hash, block: Number(rc.blockNumber), time: Number((await client.getBlock({ blockNumber: rc.blockNumber })).timestamp), chainTime: now, source: "this agent's transaction" });
    return { period: p.number, kind: "confirmed", hash, paid: p.number, gasUsed: rc.gasUsed.toString() };
  }
  const why = await revertedWhy(client, s, p, sig, rc);
  store.append({ period: p.number, type: "failed", hash, block: Number(rc.blockNumber), reason: `transaction reverted: ${why}`, chainTime: now, retryUntil: p.validBefore, sent: true });
  return { period: p.number, kind: "failed", hash, reason: `transaction reverted: ${why}`, sent: true };
}

/**
 * Why a sent payment reverted: the same call replayed on the state at the END of its block — what it met once the
 * transactions before it in that block had run (e.g. the payer moved the USDC out first). A reverted transaction
 * changes nothing, so the nonce is still unused there.
 */
async function revertedWhy(client, s, p, sig, rc) {
  const r = await simulatePay(client, s, p, sig, { blockNumber: rc.blockNumber });
  return r.ok ? "reverted in its block; the same call passes on the state after it (out of gas?)" : r.reason;
}

export function fmt(raw) {
  const v = BigInt(raw);
  const i = v / 1_000_000n;
  const f = (v % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return i.toLocaleString("en-US") + (f ? `.${f}` : "");
}
