import { decodeErrorResult, parseAbi } from "viem";
import { ABI } from "./contracts.js";
import { payCall } from "./authorize.js";

// The chain is the ledger of record. USDC's authorizationState(payer, nonce) turns true exactly once — when that
// period is paid or cancelled — and never back. Everything the agent claims about a period is read from here.

export const used = (client, s, p, blockNumber) =>
  client.readContract({ address: s.tokenAddress, abi: ABI.usdc, functionName: "authorizationState", args: [s.payer, p.nonce], ...(blockNumber != null ? { blockNumber } : {}) });

/**
 * Finds the block where a period's nonce was consumed, and how (paid or cancelled), from chain state alone — so
 * the history survives a lost ledger or a crash between sending and recording. A binary search over
 * authorizationState at past blocks (~25 reads), then that one block's AuthorizationUsed / AuthorizationCanceled log.
 */
export async function findSettlement(client, s, p, { since = 1n, head } = {}) {
  let hi = head ?? (await client.getBlockNumber());
  if (!(await used(client, s, p, hi))) return null;
  let lo = BigInt(since);
  const at = async (n) => used(client, s, p, n).catch(() => false); // before USDC existed: not used
  if (await at(lo)) return { kind: "before", block: Number(lo) }; // consumed before the search range
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (await at(mid)) hi = mid;
    else lo = mid;
  }
  const topics = (event) => ({ address: s.tokenAddress, event: ABI.usdc.find((x) => x.name === event), args: { authorizer: s.payer, nonce: p.nonce }, fromBlock: hi, toBlock: hi });
  const [paid, cancelled] = await Promise.all([client.getLogs(topics("AuthorizationUsed")), client.getLogs(topics("AuthorizationCanceled"))]);
  const log = paid[0] ?? cancelled[0];
  const block = await client.getBlock({ blockNumber: hi });
  return { kind: paid[0] ? "paid" : cancelled[0] ? "cancelled" : "unknown", block: Number(hi), time: Number(block.timestamp), hash: log?.transactionHash ?? null };
}

const REVERTS = parseAbi(["error Error(string)", "error Panic(uint256)"]);
export function revertReason(e) {
  const data = e?.walk?.((x) => typeof x?.data === "string" && x.data.startsWith("0x"))?.data;
  if (data && data !== "0x") {
    try {
      const d = decodeErrorResult({ abi: REVERTS, data });
      return d.errorName === "Error" ? String(d.args[0]) : `panic 0x${Number(d.args[0]).toString(16)}`;
    } catch {}
  }
  let c = e;
  while (c?.cause && c.cause !== c) c = c.cause;
  return String(c?.details || c?.shortMessage || c?.message || e).replace(/^execution reverted:?\s*/i, "").split("\n")[0].slice(0, 160);
}
export const isRevert = (e) => {
  const test = (x) => /revert/i.test(`${x?.name ?? ""} ${x?.details ?? ""} ${x?.shortMessage ?? ""} ${x?.message ?? ""}`);
  return typeof e?.walk === "function" ? !!e.walk(test) : test(e);
};

/**
 * Would the payment go through at this block? Runs the exact call (any sender: an EIP-3009 authorization does not
 * care who submits it). A revert gives USDC's own reason; an RPC failure is thrown, never reported as a reason.
 */
export async function simulatePay(client, s, p, signature, { from, blockNumber } = {}) {
  const call = payCall(s, p, signature);
  try {
    await client.call({ account: from, to: call.to, data: call.data, ...(blockNumber != null ? { blockNumber } : {}) });
    return { ok: true, call };
  } catch (e) {
    if (!isRevert(e)) throw e;
    return { ok: false, reason: revertReason(e), call };
  }
}

export async function payerState(client, s, blockNumber) {
  const at = blockNumber != null ? { blockNumber } : {};
  const [balance, payerBlacklisted, recipientBlacklisted, code] = await Promise.all([
    client.readContract({ address: s.tokenAddress, abi: ABI.usdc, functionName: "balanceOf", args: [s.payer], ...at }),
    client.readContract({ address: s.tokenAddress, abi: ABI.usdc, functionName: "isBlacklisted", args: [s.payer], ...at }),
    client.readContract({ address: s.tokenAddress, abi: ABI.usdc, functionName: "isBlacklisted", args: [s.recipient], ...at }),
    client.getCode({ address: s.payer, ...at }),
  ]);
  return { balance, payerBlacklisted, recipientBlacklisted, hasCode: !!code && code !== "0x", eip7702: !!code && code.startsWith("0xef0100") };
}

