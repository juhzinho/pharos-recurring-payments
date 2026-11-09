// The whole life of a weekly schedule, on an Anvil fork of Pharos Pacific, with real receipts and real time travel.
// Fresh test keys (generated per run, funded on the fork only) play the payer, the recipient and a relayer.
// The payer signs the 6 authorizations once; from then on only the agent's ticks act.
//   P1  before the due time the chain refuses ("not yet valid"); at the due time it is paid
//   P2  the agent crashes after sending, before recording the hash → the next tick finds the payment on chain and
//       sends nothing; a deliberate replay of the same authorization is refused by USDC
//   P3  not enough USDC → FAILED, nothing sent, retried; the payer tops up → paid once
//   P4  the payer moves USDC out in the same block → the sent transaction reverts → FAILED (sent); top-up → paid once
//   P5  the payer cancels this period on chain → CANCELLED, found by the agent
//   P6  no USDC during the whole window → MISSED; afterwards the expired authorization can never be used
// Then the ledger is thrown away and the history is rebuilt from the chain alone.
// Writes .recurring-proof/fork-proof.json; with --record, public/runs/fork-proof.json.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createPublicClient, createWalletClient, encodeFunctionData, http, pad, toHex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { startFork } from "../lib/fork.js";
import { ABI, CHAIN_ID, USDC, balanceSlot } from "../lib/contracts.js";

const fork = await startFork({ port: Number(process.env.FORK_PORT ?? 8551) });
process.env.PHAROS_RPC_URL = fork.url;
const { makeClient } = await import("../lib/chain.js");
const { openStore } = await import("../lib/ledger.js");
const { saveNew, tick, fmt } = await import("../lib/agent.js");
const { periods, validateSchedule, iso } = await import("../lib/schedule.js");
const { scheduleTypedData, cancelTypedData, cancelCall, payCall } = await import("../lib/authorize.js");
const { simulatePay } = await import("../lib/onchain.js");

const chain = { id: CHAIN_ID, name: "Pacific fork", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [fork.url] } } };
const pub = createPublicClient({ chain, transport: http(fork.url, { timeout: 120_000 }) });
const rpc = (method, params = []) => pub.request({ method, params });
const client = makeClient();
const log = (m) => console.log(m);
const U = (n) => BigInt(Math.round(n * 1e6));

const wallet = async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  await rpc("anvil_setBalance", [account.address, "0x56BC75E2D63100000"]); // 100 PROS for gas, fork only
  return { account, w: createWalletClient({ account, chain, transport: http(fork.url) }) };
};
const setUsdc = (addr, v) => rpc("anvil_setStorageAt", [USDC.address, balanceSlot(addr), pad(toHex(v))]);
const balance = (addr) => pub.readContract({ address: USDC.address, abi: ABI.usdc, functionName: "balanceOf", args: [addr] });
const transfer = async (from, to, v, extra = {}) => from.w.sendTransaction({ to: USDC.address, data: encodeFunctionData({ abi: ABI.usdc, functionName: "transfer", args: [to, v] }), ...extra });
/** Jump the chain clock to `t` (unix seconds) and mine one block there. */
const warp = async (t) => {
  await rpc("evm_setNextBlockTimestamp", [toHex(t)]);
  await rpc("evm_mine");
};
const snapshot = async (label, report, extra = {}) => ({ label, block: report.block, periods: report.periods.map((p) => ({ number: p.number, status: p.status, hash: p.hash ?? null, reason: p.reason ?? null })), action: report.action, ...extra });

const DIR = ".recurring-proof";
await rm(DIR, { recursive: true, force: true });
const out = { recordedAt: new Date().toISOString(), network: "Anvil fork of Pharos Pacific", note: "test wallets: fresh keys funded on the fork only; the chain clock is moved forward with evm_setNextBlockTimestamp", steps: [] };

try {
  const payer = await wallet();
  const relayer = await wallet();
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  const spendTo = privateKeyToAccount(generatePrivateKey()).address;
  const head = await pub.getBlock();
  out.forkBlock = Number(head.number);
  const start = (Math.floor(Number(head.timestamp) / 3600) + 25) * 3600; // the next full hour, a day from now
  const input = { payer: payer.account.address, recipient, token: "USDC", amount: "250", every: "weekly", start: iso(start), count: 6, graceHours: 48, label: "Studio rent (weekly, fork demo)" };
  const s = validateSchedule(input);
  const ps = periods(s);
  await setUsdc(payer.account.address, U(1000));

  // the payer signs the whole schedule once — 6 authorizations, no gas
  const typed = scheduleTypedData(s);
  const signatures = await Promise.all(typed.map((t) => payer.account.signTypedData(t)));
  const store = openStore(`${DIR}/ledger`);
  await saveNew(store, input, { signatures, signedAtBlock: Number(head.number) });
  out.schedule = { ...input, id: s.id, periods: ps.map((p) => ({ number: p.number, due: iso(p.due), windowEnds: iso(p.validBefore), nonce: p.nonce })) };
  log(`schedule ${s.id.slice(0, 10)}…: 6 × 250 USDC weekly from ${iso(start)}, grace 48 h; payer funded 1,000 USDC`);
  const step = async (label, report, extra) => {
    out.steps.push(await snapshot(label, report, extra));
    const p = report.periods.map((x) => `${x.number}:${x.status}`).join(" ");
    log(`  ${label}\n     ${p}${report.action ? ` · action ${report.action.kind}${report.action.reason ? ` — ${report.action.reason}` : ""}` : ""}`);
  };
  const run = (mode = "relay") => tick(store, { client, mode, relayer: relayer.w });

  // ── P1 ──
  await warp(ps[0].due - 3600);
  const early = await simulatePay(client, s, ps[0], signatures[0]);
  await step("P1 · one hour before the due time: nothing to do; the chain itself refuses an early payment", await run(), { early: early.reason });
  await warp(ps[0].due + 30);
  await step("P1 · due: the agent pays", await run());

  // ── P2: crash between sending and recording ──
  await warp(ps[1].due + 30);
  store.append({ period: 2, type: "attempt", chainTime: ps[1].due + 30 });
  const lostHash = await relayer.w.sendTransaction({ ...payCall(s, ps[1], signatures[1]), gas: 150_000n });
  await pub.waitForTransactionReceipt({ hash: lostHash });
  log(`  P2 · sent ${lostHash.slice(0, 12)}… and "crashed" before writing it down`);
  await warp(ps[1].due + 300);
  const recovered = await run();
  await step("P2 · after the crash: the next tick finds the payment on chain — and sends nothing", recovered, { lostHash });
  const replay = await relayer.w.sendTransaction({ ...payCall(s, ps[1], signatures[1]), gas: 150_000n });
  const replayRc = await pub.waitForTransactionReceipt({ hash: replay });
  const replayWhy = (await simulatePay(client, s, ps[1], signatures[1])).reason;
  out.steps.at(-1).replay = { hash: replay, status: replayRc.status, reason: replayWhy };
  log(`  P2 · deliberate replay of the same authorization: ${replayRc.status} — ${replayWhy}`);

  // ── P3: not enough USDC, then a top-up ──
  await transfer(payer, spendTo, U(400)); // 500 → 100
  await warp(ps[2].due + 30);
  await step("P3 · due with 100 USDC: failed, nothing sent", await run());
  await warp(ps[2].due + 6 * 3600);
  await step("P3 · six hours later, still short: failed again, still nothing sent", await run());
  await setUsdc(payer.account.address, (await balance(payer.account.address)) + U(400)); // the payer tops up
  await warp(ps[2].due + 7 * 3600);
  await step("P3 · after the top-up: paid — once", await run());

  // ── P4: a real failed transaction (state changes between the check and inclusion) ──
  await warp(ps[3].due + 30);
  await rpc("evm_setAutomine", [false]);
  const drain = await transfer(payer, spendTo, U(200), { maxPriorityFeePerGas: 2_000_000_000n, maxFeePerGas: 40_000_000_000n, gas: 80_000n }); // 250 → 50, first in the block
  const pending = run();
  for (let i = 0; i < 100; i++) {
    const n = await rpc("eth_getBlockByNumber", ["pending", false]).then((b) => b?.transactions?.length ?? 0).catch(() => 0);
    if (n >= 2) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await rpc("evm_mine");
  await rpc("evm_setAutomine", [true]);
  const raced = await pending;
  await step("P4 · the payer moved USDC out in the same block: the sent payment reverted", raced, { drain });
  await setUsdc(payer.account.address, (await balance(payer.account.address)) + U(300));
  await warp(ps[3].due + 3600);
  await step("P4 · after the top-up: paid — once", await run());

  // ── P5: the payer cancels this period on chain ──
  const csig = await payer.account.signTypedData(cancelTypedData(s, ps[4]));
  const cancelHash = await relayer.w.sendTransaction(cancelCall(s, ps[4], csig));
  await pub.waitForTransactionReceipt({ hash: cancelHash });
  await warp(ps[4].due + 30);
  await step("P5 · cancelled by the payer before its due time: the agent finds it and pays nothing", await run(), { cancelHash });

  // ── P6: no money for the whole window ──
  await setUsdc(payer.account.address, 0n);
  await warp(ps[5].due + 30);
  await step("P6 · due with 0 USDC: failed, nothing sent", await run());
  await warp(ps[5].validBefore + 60);
  await setUsdc(payer.account.address, U(1000));
  const late = await simulatePay(client, s, ps[5], signatures[5]);
  await step("P6 · the window closed: missed — and even with money now, the expired authorization cannot be used", await run(), { late: late.reason });

  // ── the ledger is lost: rebuild the history from the chain ──
  const rebuilt = openStore(`${DIR}/rebuilt`);
  await saveNew(rebuilt, input, { signatures, signedAtBlock: Number(head.number) });
  const fromChain = await tick(rebuilt, { client, mode: "observe" });
  const final = await tick(store, { client, mode: "observe" });
  const agree = final.periods.every((p, i) => p.status === fromChain.periods[i].status && (p.hash ?? null) === (fromChain.periods[i].hash ?? null));
  out.final = final.periods;
  out.history = final.history;
  out.rebuilt = { periods: fromChain.periods.map((p) => ({ number: p.number, status: p.status, hash: p.hash ?? null })), agreesWithLedger: agree };
  // money check: exactly the paid periods left the payer, each exactly once
  const transfers = await pub.getLogs({ address: USDC.address, event: ABI.usdc.find((x) => x.name === "Transfer"), args: { from: s.payer, to: s.recipient }, fromBlock: head.number, toBlock: "latest" });
  out.money = { recipientReceived: fmt(await balance(recipient)), transfersToRecipient: transfers.length, paidPeriods: final.periods.filter((p) => p.status === "paid").length, perTransfer: transfers.map((t) => fmt(t.args.value)) };
  log(`  ledger thrown away → rebuilt from chain: ${fromChain.periods.map((p) => `${p.number}:${p.status}`).join(" ")} · agrees with the ledger: ${agree}`);
  log(`  money: the recipient got ${out.money.recipientReceived} USDC in ${transfers.length} transfers for ${out.money.paidPeriods} paid periods`);

  const target = process.argv.includes("--record") ? "public/runs/fork-proof.json" : `${DIR}/fork-proof.json`;
  await mkdir(DIR, { recursive: true });
  await writeFile(target, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  log(`wrote ${target}`);
} finally {
  fork.stop();
}
process.exit(0);
