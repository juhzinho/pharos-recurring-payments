// Records the demo's mainnet runs (read-only) → public/runs/:
//   plan-rent.json, plan-weekly.json  the two example schedules against Pacific now: calendar, coverage, gas, nonces
//   recovery.json                     a real USDC authorization used on Pacific, found again from chain state alone
//                                     (binary search on authorizationState, then that block's AuthorizationUsed log)
import { readFile, writeFile } from "node:fs/promises";
import { makeClient } from "../lib/chain.js";
import { ABI, USDC } from "../lib/contracts.js";
import { forecast } from "../lib/forecast.js";
import { findSettlement } from "../lib/onchain.js";
import { toJson } from "../lib/schedule.js";

const client = makeClient();
const save = (name, x) => writeFile(new URL(`../public/runs/${name}.json`, import.meta.url), JSON.stringify(toJson({ recordedAt: new Date().toISOString(), network: "Pharos Pacific Mainnet", ...x }), null, 2));

for (const [name, file] of [["plan-rent", "rent.json"], ["plan-weekly", "payroll-weekly.json"]]) {
  const f = await forecast(JSON.parse(await readFile(new URL(`../schedules/${file}`, import.meta.url), "utf8")), { client });
  await save(name, f);
  console.log(`${name}: block ${f.block.number} · covers ${f.payer.covers} · gas ${f.gas.perPayment.gas} · next #${f.next?.number} ${f.next?.dueIso}`);
}

// the most recent USDC AuthorizationUsed on Pacific (the RPC serves eth_getLogs over ≤ 1,000 blocks)
const head = await client.getBlockNumber();
const ev = ABI.usdc.find((x) => x.name === "AuthorizationUsed");
let log = null;
let scanned = 0;
for (let to = head; !log && to > head - 1_000_000n; to -= 1000n) {
  const logs = await client.getLogs({ address: USDC.address, event: ev, fromBlock: to - 999n, toBlock: to });
  scanned += 1000;
  log = logs.at(-1) ?? null;
}
if (!log) throw new Error("no AuthorizationUsed in the last 1,000,000 blocks");
const since = log.blockNumber - 500_000n;
const t = Date.now();
const found = await findSettlement(client, { payer: log.args.authorizer, tokenAddress: USDC.address }, { nonce: log.args.nonce }, { since, head });
const ms = Date.now() - t;
await save("recovery", {
  what: "A real EIP-3009 authorization used on Pacific, looked up again knowing only (authorizer, nonce): a binary search over authorizationState at past blocks, then that one block's log.",
  event: { block: Number(log.blockNumber), hash: log.transactionHash, authorizer: log.args.authorizer, nonce: log.args.nonce, foundBy: `a log scan over the last ${scanned.toLocaleString("en-US")} blocks` },
  search: { from: Number(since), to: Number(head), blocks: Number(head - since), seconds: ms / 1000 },
  found,
  match: found?.hash === log.transactionHash && BigInt(found.block) === log.blockNumber,
});
console.log(`recovery: block ${found?.block} ${found?.hash} · match ${found?.hash === log.transactionHash} · ${(ms / 1000).toFixed(1)} s over ${Number(head - since).toLocaleString("en-US")} blocks`);
process.exit(0);
