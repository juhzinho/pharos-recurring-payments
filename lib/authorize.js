import { encodeFunctionData, parseSignature, recoverTypedDataAddress } from "viem";
import { ABI, TYPES, USDC_DOMAIN } from "./contracts.js";
import { periods } from "./schedule.js";

// What the payer signs, once, for the whole schedule: one USDC TransferWithAuthorization per period. Each names the
// recipient, the exact amount, the period's window and its nonce — so whoever holds it (this agent, a relayer,
// anyone) can only make that one payment, only inside its window, only once.

export function periodTypedData(s, p) {
  return { domain: USDC_DOMAIN, types: { TransferWithAuthorization: TYPES.TransferWithAuthorization }, primaryType: "TransferWithAuthorization", message: { from: s.payer, to: s.recipient, value: s.amount, validAfter: BigInt(p.validAfter), validBefore: BigInt(p.validBefore), nonce: p.nonce } };
}

export const scheduleTypedData = (s) => periods(s).map((p) => periodTypedData(s, p));

/** The payer withdraws one future period: after this, that period can never be paid. */
export function cancelTypedData(s, p) {
  return { domain: USDC_DOMAIN, types: { CancelAuthorization: TYPES.CancelAuthorization }, primaryType: "CancelAuthorization", message: { authorizer: s.payer, nonce: p.nonce } };
}

const vrs = (signature) => {
  const { r, s, v, yParity } = parseSignature(signature);
  return [Number(v ?? 27n + BigInt(yParity)), r, s];
};

export function payCall(s, p, signature) {
  return { to: s.tokenAddress, data: encodeFunctionData({ abi: ABI.usdc, functionName: "transferWithAuthorization", args: [s.payer, s.recipient, s.amount, BigInt(p.validAfter), BigInt(p.validBefore), p.nonce, ...vrs(signature)] }) };
}

export function cancelCall(s, p, signature) {
  return { to: s.tokenAddress, data: encodeFunctionData({ abi: ABI.usdc, functionName: "cancelAuthorization", args: [s.payer, p.nonce, ...vrs(signature)] }) };
}

/**
 * Checks signatures before they are stored: each must recover to the payer for exactly its period's typed data.
 * (A wallet with an EIP-7702 delegation or a contract wallet signs through EIP-1271 — refused here, see status.)
 */
export async function checkSignatures(s, signatures) {
  const ps = periods(s);
  if (!Array.isArray(signatures) || signatures.length !== ps.length) throw new Error(`expected ${ps.length} signatures, one per period (got ${Array.isArray(signatures) ? signatures.length : 0})`);
  for (const [i, sig] of signatures.entries()) {
    if (!/^0x[0-9a-fA-F]{130}$/.test(String(sig))) throw new Error(`signature for period ${i + 1} is not 0x + 130 hex characters`);
    const who = await recoverTypedDataAddress({ ...periodTypedData(s, ps[i]), signature: sig });
    if (who !== s.payer) throw new Error(`signature for period ${i + 1} was made by ${who}, not the payer ${s.payer} (or for different data)`);
  }
  return true;
}
