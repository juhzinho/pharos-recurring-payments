#!/usr/bin/env node
// Recurring Payment Agent for Pharos Pacific: a weekly or monthly USDC payment, each period a pre-signed, time-locked
// EIP-3009 authorization whose nonce is derived from the schedule — USDC itself refuses to pay a period early, late
// or twice.
//   npm run pay -- plan schedules/rent.json                       the calendar, live on mainnet: coverage, gas, nonces
//   npm run pay -- new schedules/rent.json                        start a schedule folder + what the payer signs
//   npm run pay -- attach <dir> --sigs signatures.json            the payer's signatures (from any wallet), checked
//   npm run pay -- sign <dir>                                     or sign with PAYER_PRIVATE_KEY from .env (your own key)
//   npm run pay -- tick <dir>                                     prepare the payment that is due (unsigned transaction)
//   npm run pay -- tick <dir> --relay                             or send it with RELAYER_PRIVATE_KEY (pays gas only)
//   npm run pay -- status <dir>                                   paid / pending / failed / … per period, history, next
//   npm run pay -- cancel <dir> --period 3                        what the payer signs to withdraw one future period
//   npm run pay -- demo                                           the full life of a schedule on an Anvil fork
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createWalletClient, http, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeClient } from "../../lib/chain.js";
import { openStore } from "../../lib/ledger.js";
import { loadSchedule, saveNew, tick } from "../../lib/agent.js";
import { forecast } from "../../lib/forecast.js";
import { cancelCall, cancelTypedData, checkSignatures, scheduleTypedData } from "../../lib/authorize.js";
import { periods, toJson, validateSchedule } from "../../lib/schedule.js";
import { CHAIN_ID, PACIFIC_RPC } from "../../lib/contracts.js";
import { renderForecast, renderHistory, renderStatus } from "../../lib/render.js";

const USAGE = `usage: npm run pay -- plan <schedule.json>
       npm run pay -- new <schedule.json> [--dir .recurring/<name>]
       npm run pay -- attach <dir> --sigs <signatures.json>
       npm run pay -- sign <dir>                  (PAYER_PRIVATE_KEY in .env)
       npm run pay -- tick <dir> [--relay]        (--relay: RELAYER_PRIVATE_KEY in .env)
       npm run pay -- status <dir> [--json]
       npm run pay -- cancel <dir> --period <n> [--sig 0x…]
       npm run pay -- demo
Nothing is signed for the payer by this tool unless you run "sign" with your own key.`;

if (existsSync(".env")) process.loadEnvFile(".env");
const [cmd, arg, ...rest] = process.argv.slice(2);
const usage = (m) => Object.assign(new Error(m), { usage: true });
const flags = {};
try {
  for (let i = 0; i < rest.length; i++) {
    const k = rest[i].replace(/^--/, "");
    if (!rest[i].startsWith("--")) throw usage(`unexpected argument "${rest[i]}"`);
    if (["relay", "json"].includes(k)) flags[k] = true;
    else if (["dir", "sigs", "period", "sig"].includes(k)) {
      const v = rest[++i];
      if (v == null || v.startsWith("--")) throw usage(`--${k} needs a value`);
      flags[k] = v;
    } else throw usage(`unknown flag --${k}`);
  }
  if (!cmd || cmd === "--help" || cmd === "-h") {
    console.log(USAGE);
    process.exit(cmd ? 0 : 2);
  }
  const readJson = (path, what) => {
    if (!path) throw usage(`${cmd} needs ${what}`);
    if (!existsSync(path)) throw usage(`${what} not found: ${path}`);
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      throw usage(`${path} is not valid JSON (${e.message})`);
    }
  };
  const asUsage = async (fn) => {
    try {
      return await fn();
    } catch (e) {
      throw e.usage || /RPC|fetch|timeout|ECONN/i.test(e.message) ? e : usage(e.message);
    }
  };
  const storeOf = (dir) => {
    if (!dir || !existsSync(`${dir}/schedule.json`)) throw usage(`no schedule folder at ${dir ?? "(none given)"} — create one with: npm run pay -- new <schedule.json>`);
    return openStore(dir);
  };
  const key = (name) => {
    const k = process.env[name];
    if (!/^0x[0-9a-fA-F]{64}$/.test(k ?? "")) throw usage(`${name} is not set in .env (0x + 64 hex characters) — see .env.example`);
    return privateKeyToAccount(k);
  };
  const client = makeClient();

  if (cmd === "demo") {
    execFileSync(process.execPath, ["scripts/fork-proof.js"], { stdio: "inherit" });
    process.exit(0);
  }
  if (cmd === "plan") {
    const input = readJson(arg, "a schedule file");
    await asUsage(() => validateSchedule(input));
    console.log(renderForecast(await forecast(input, { client })));
    process.exit(0);
  }
  if (cmd === "new") {
    const input = readJson(arg, "a schedule file");
    const s = await asUsage(() => validateSchedule(input));
    const dir = flags.dir ?? `.recurring/${s.id.slice(2, 10)}`;
    if (existsSync(`${dir}/schedule.json`)) throw usage(`${dir} already holds a schedule — pick another --dir`);
    const store = openStore(dir);
    await saveNew(store, input);
    writeFileSync(`${dir}/to-sign.json`, JSON.stringify(toJson(scheduleTypedData(s)), null, 2));
    console.log(`schedule ${s.id}\n  folder ${dir}\n  ${s.count} messages for the payer to sign: ${dir}/to-sign.json (eth_signTypedData_v4, one per period, no gas)\n  then: npm run pay -- attach ${dir} --sigs <file with a JSON array of signatures>   (or: sign ${dir})`);
    process.exit(0);
  }
  if (!["attach", "sign", "tick", "status", "cancel"].includes(cmd)) throw usage(`unknown command “${cmd}”`);
  const store = storeOf(arg);
  const saved = store.loadSchedule();
  const { s } = await asUsage(() => loadSchedule(saved));

  if (cmd === "attach" || cmd === "sign") {
    if (saved.signatures) throw usage("this schedule is already signed (signatures cannot be swapped: start a new schedule with another salt)");
    let sigs;
    if (cmd === "attach") sigs = readJson(flags.sigs, "--sigs <signatures.json>");
    else {
      const payer = key("PAYER_PRIVATE_KEY");
      if (payer.address !== s.payer) throw usage(`PAYER_PRIVATE_KEY is ${payer.address}, but this schedule's payer is ${s.payer}`);
      sigs = await Promise.all(scheduleTypedData(s).map((t) => payer.signTypedData(t)));
    }
    await asUsage(() => checkSignatures(s, sigs));
    const signedAtBlock = Number(await client.getBlockNumber());
    store.saveSchedule({ ...saved, signatures: sigs, signedAtBlock });
    console.log(`${sigs.length} signatures checked (each recovers to the payer for its own period) and stored · block ${signedAtBlock}`);
    process.exit(0);
  }
  if (cmd === "cancel") {
    const n = Number(flags.period);
    const p = periods(s)[n - 1];
    if (!Number.isInteger(n) || !p) throw usage(`--period: 1 to ${s.count}`);
    if (!flags.sig) {
      console.log(JSON.stringify({ toSign: toJson(cancelTypedData(s, p)), then: `npm run pay -- cancel ${arg} --period ${n} --sig 0x…` }, null, 2));
      process.exit(0);
    }
    if (!/^0x[0-9a-fA-F]{130}$/.test(flags.sig)) throw usage("--sig: 0x + 130 hex characters");
    const signer = await recoverTypedDataAddress({ ...cancelTypedData(s, p), signature: flags.sig }).catch(() => null);
    if (signer !== s.payer) throw usage(`--sig is not the payer's cancellation of period ${n} (it ${signer ? `was signed by ${signer}` : "is not a valid signature"})`);
    const call = cancelCall(s, p, flags.sig);
    console.log(JSON.stringify({ unsignedTransaction: { chainId: CHAIN_ID, to: call.to, data: call.data, value: "0x0" }, note: `after it is mined, period ${n} can never be paid; the agent reports it as cancelled` }, null, 2));
    process.exit(0);
  }
  const relayer = cmd === "tick" && flags.relay ? createWalletClient({ account: key("RELAYER_PRIVATE_KEY"), chain: { id: CHAIN_ID, name: "Pharos Pacific", nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [process.env.PHAROS_RPC_URL ?? PACIFIC_RPC] } } }, transport: http(process.env.PHAROS_RPC_URL ?? PACIFIC_RPC) }) : null;
  const r = await tick(store, { client, mode: cmd === "status" ? "observe" : relayer ? "relay" : "prepare", relayer, log: (m) => console.error(`  · ${m}`) });
  if (flags.json) {
    console.log(JSON.stringify(toJson(r), null, 2));
    process.exit(0);
  }
  console.log(renderStatus(r));
  if (r.action?.tx) console.log(JSON.stringify({ unsignedTransaction: r.action.tx }, null, 2));
  if (cmd === "status") console.log(`\n  History\n${renderHistory(r.history)}`);
  process.exit(r.action?.kind === "failed" ? 3 : 0);
} catch (e) {
  console.error(`error: ${String(e.message).split("\n")[0]}`);
  if (e.usage) console.error(`\n${USAGE}`);
  process.exit(e.usage ? 2 : 1);
}
