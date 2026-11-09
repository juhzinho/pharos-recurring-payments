import { encodeAbiParameters, getAddress, isAddress, keccak256, zeroAddress } from "viem";
import { USDC } from "./contracts.js";

// A schedule: who pays whom, how much, how often, from when, how many times, and how long each payment may be
// late. Every period k gets its own nonce, derived from the schedule itself — the on-chain key of that payment.
//   { "payer": "0x…", "recipient": "0x…", "token": "USDC", "amount": "250", "every": "weekly" | "monthly",
//     "start": "2026-11-16T09:00:00Z", "count": 12, "graceHours": 72, "label": "Studio rent", "salt": "1" }

export const EVERY = ["weekly", "monthly"];
export const MAX_PERIODS = 60;
const DAY = 86_400;

export function parseAmount(text, decimals = USDC.decimals) {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(text ?? "").trim());
  if (!m) throw new Error(`amount “${text}” is not an amount (digits and an optional decimal point)`);
  if ((m[2] ?? "").length > decimals) throw new Error(`amount “${text}” has more than ${decimals} decimals`);
  const v = BigInt(m[1]) * 10n ** BigInt(decimals) + BigInt((m[2] ?? "").padEnd(decimals, "0") || "0");
  if (v <= 0n) throw new Error("amount must be positive");
  return v;
}

const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m is 0-based

/**
 * Due time (unix seconds, UTC) of period k (0-based).
 * weekly: start + 7 days × k. monthly: the start's day of month, clamped to the month's last day
 * (Jan 31 → Feb 28/29 → Mar 31), same time of day — never drifting to the 28th after one short month.
 */
export function dueAt(s, k) {
  if (s.every === "weekly") return s.start + 7 * DAY * k;
  const d = new Date(s.start * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + k;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  const day = Math.min(d.getUTCDate(), daysInMonth(yy, mm));
  return Date.UTC(yy, mm, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) / 1000;
}

export function validateSchedule(raw) {
  const s = raw ?? {};
  const addr = (k) => {
    if (!isAddress(String(s[k] ?? ""), { strict: false })) throw new Error(`${k}: an address (0x…) is required`);
    const a = getAddress(String(s[k]).toLowerCase());
    if (a === zeroAddress) throw new Error(`${k} is the zero address`);
    return a;
  };
  const payer = addr("payer");
  const recipient = addr("recipient");
  if (payer === recipient) throw new Error("recipient is the payer itself");
  const token = String(s.token ?? "USDC").toUpperCase();
  if (token !== "USDC") throw new Error(`token “${s.token}” is not supported: USDC (its EIP-3009 authorizations are what make each period payable once, and only in its window)`);
  const amount = parseAmount(s.amount);
  const every = s.every ?? "monthly";
  if (!EVERY.includes(every)) throw new Error(`every must be one of ${EVERY.join(", ")}`);
  const startMs = Date.parse(String(s.start ?? ""));
  if (!/Z$|[+-]\d\d:\d\d$/.test(String(s.start ?? "")) || !Number.isFinite(startMs)) throw new Error("start: an ISO date with a time zone, e.g. 2026-11-16T09:00:00Z");
  if (startMs % 1000) throw new Error("start: whole seconds only");
  const count = Number(s.count ?? 12);
  if (!Number.isInteger(count) || count < 1 || count > MAX_PERIODS) throw new Error(`count: 1 to ${MAX_PERIODS} payments`);
  const graceHours = Number(s.graceHours ?? 72);
  const maxGrace = every === "weekly" ? 6 * 24 : 27 * 24; // a payment's window closes before the next one opens
  if (!Number.isInteger(graceHours) || graceHours < 1 || graceHours > maxGrace) throw new Error(`graceHours: 1 to ${maxGrace} for a ${every} schedule (a window must close before the next payment is due)`);
  const salt = String(s.salt ?? "1");
  if (salt.length > 64) throw new Error("salt: at most 64 characters");
  const label = s.label ? String(s.label).slice(0, 80) : null;
  const out = { payer, recipient, token, tokenAddress: USDC.address, decimals: USDC.decimals, amount, every, start: startMs / 1000, count, graceHours, salt, label };
  out.id = scheduleId(out);
  return out;
}

/** The schedule's identity: every field that defines what is paid. Change any of them and every nonce changes. */
export function scheduleId(s) {
  return keccak256(encodeAbiParameters(
    [{ type: "string" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }, { type: "string" }, { type: "uint64" }, { type: "uint16" }, { type: "uint32" }, { type: "string" }],
    ["pharos-recurring-payments/v1", s.payer, s.recipient, s.tokenAddress, s.amount, s.every, BigInt(s.start), s.count, s.graceHours, s.salt],
  ));
}

/** Period k's nonce: unique per schedule and period, so USDC accepts that payment at most once. */
export const periodNonce = (id, k) => keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [id, BigInt(k)]));

/** All periods with their on-chain window: valid from the due second, until the grace ends. */
export function periods(s) {
  return Array.from({ length: s.count }, (_, k) => {
    const due = dueAt(s, k);
    // EIP-3009: valid iff validAfter < block.timestamp < validBefore
    return { k, number: k + 1, due, validAfter: due - 1, validBefore: due + s.graceHours * 3600, nonce: periodNonce(s.id, k) };
  });
}

export const iso = (t) => new Date(t * 1000).toISOString().replace(".000Z", "Z");
export const toJson = (x) => JSON.parse(JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
