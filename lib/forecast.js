import { pad, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ABI, PROS_USD, balanceSlot } from "./contracts.js";
import { payCall, periodTypedData } from "./authorize.js";
import { payerState, used } from "./onchain.js";
import { iso, periods, validateSchedule } from "./schedule.js";
import { fmt } from "./agent.js";

/**
 * A schedule against Pacific mainnet, read-only: the calendar, each period's nonce on chain (already paid or
 * cancelled?), how many of the coming payments the payer's USDC covers today, and what one payment costs in gas —
 * measured, not assumed: an equivalent test signer (fresh key, its USDC applied by state override) signs a payment of
 * the same amount to the same recipient and the call is estimated at the head block.
 */
export async function forecast(input, { client }) {
  const s = validateSchedule(input);
  const ps = periods(s);
  const head = await client.getBlock();
  const now = Number(head.timestamp);
  const [w, consumed, gas, [, prosUsd]] = await Promise.all([
    payerState(client, s, head.number),
    Promise.all(ps.map((p) => used(client, s, p, head.number))),
    paymentGas(client, s, head),
    client.readContract({ address: PROS_USD, abi: ABI.feed, functionName: "latestRoundData", blockNumber: head.number }),
  ]);
  const open = ps.filter((p, i) => !consumed[i] && p.validBefore > now);
  const covered = Number(w.balance / s.amount);
  const fee = (g) => ({ gas: g.toString(), pros: Number(g * (head.baseFeePerGas ?? 0n)) / 1e18, usd: (Number(g * (head.baseFeePerGas ?? 0n)) / 1e18) * (Number(prosUsd) / 1e18) });
  const warnings = [];
  if (w.hasCode) warnings.push(w.eip7702 ? "the payer has an EIP-7702 delegation: USDC then checks signatures through the delegated contract (EIP-1271), so a plain signature from the key may be refused" : "the payer is a contract: USDC checks its signatures through EIP-1271");
  if (w.payerBlacklisted) warnings.push("the payer is blacklisted by USDC: no payment can go through");
  if (w.recipientBlacklisted) warnings.push("the recipient is blacklisted by USDC: no payment can go through");
  if (open.length && covered < open.length) warnings.push(`today's balance covers ${covered} of the ${open.length} remaining payments — the payment due ${iso(open[Math.min(covered, open.length - 1)].due)} would fail unless the payer tops up`);
  return {
    block: { number: Number(head.number), timestamp: now, iso: iso(now) },
    schedule: s,
    payer: { balance: w.balance.toString(), balanceText: fmt(w.balance), covers: covered, hasCode: w.hasCode, eip7702: w.eip7702 },
    periods: ps.map((p, i) => ({ number: p.number, due: p.due, dueIso: iso(p.due), windowEndsIso: iso(p.validBefore), nonce: p.nonce, onChain: consumed[i] ? "consumed (paid or cancelled)" : "unused", status: consumed[i] ? "settled" : now < p.due ? "scheduled" : now < p.validBefore ? "due" : "missed", coveredToday: !consumed[i] && open.indexOf(p) > -1 && open.indexOf(p) < covered })),
    next: open.find((p) => p.due > now) ? { number: open.find((p) => p.due > now).number, dueIso: iso(open.find((p) => p.due > now).due), inSeconds: open.find((p) => p.due > now).due - now } : null,
    total: { payments: s.count, amount: fmt(s.amount * BigInt(s.count)) },
    gas: { perPayment: fee(gas), baseFeeGwei: Number(head.baseFeePerGas ?? 0n) / 1e9, prosUsd: Number(prosUsd) / 1e18, paidBy: "whoever submits each payment (a relayer, the recipient, the payer) — the authorization does not depend on the sender", measuredWith: "an equivalent test signer: same amount, same recipient, USDC applied by state override" },
    sign: { messages: ps.length, what: "one EIP-712 USDC TransferWithAuthorization per period (eth_signTypedData_v4) — no gas, signed once" },
    warnings,
  };
}

async function paymentGas(client, s, head) {
  const twin = privateKeyToAccount(generatePrivateKey());
  const t = { ...s, payer: twin.address };
  const p = { k: 0, validAfter: 0, validBefore: Number(head.timestamp) + 3600, nonce: toHex(globalThis.crypto.getRandomValues(new Uint8Array(32))) };
  const sig = await twin.signTypedData(periodTypedData(t, p));
  const call = payCall(t, p, sig);
  const stateOverride = [{ address: s.tokenAddress, stateDiff: [{ slot: balanceSlot(twin.address), value: pad(toHex(s.amount * 2n)) }] }];
  return client.estimateGas({ account: s.recipient, to: call.to, data: call.data, blockNumber: head.number, stateOverride });
}
