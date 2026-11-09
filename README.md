# Pharos Recurring Payments

A **SkillEngine skill** for Pharos Pacific that runs a repeating USDC payment — rent, a subscription, payroll-style
payouts — on a weekly or monthly schedule. The payer signs the whole schedule once; each payment is an
authorization **the USDC contract itself** accepts only inside its own window and only once, so the agent can pay on
time, retry after a failure and survive a crash without ever paying a period twice.

**Live demo:** https://pharos-recurring-payments.vercel.app · **Skill:** [skill/pharos-recurring-payments/SKILL.md](skill/pharos-recurring-payments/SKILL.md)

```
schedule (weekly | monthly) ─▶ payer signs N authorizations once (no gas) ─▶ every tick, at chain time:
  period k:  nonce_k = keccak(schedule id, k)          valid only while  due_k ≤ block time < due_k + grace
             open window → check balance / blacklist / simulate → prepare (or relay) → receipt → ledger
             USDC accepts nonce_k once → paid | cancelled — read from chain; window closed unpaid → missed
```

## Requirements

| # | Requirement | How it is met |
|---|---|---|
| 01 | Supports a schedule (weekly or monthly) with amount, token and recipient | A JSON schedule ([format](skill/pharos-recurring-payments/references/schedule-format.md)): payer, recipient, USDC, amount (exact decimal string), `weekly` or `monthly`, first due time, number of payments, grace window. Monthly keeps its day, clamped to short months (Dec 31 → Jan 31 → **Feb 28** → Mar 31, Feb 29 in leap years), same UTC time. Plan it live on mainnet: `npm run pay -- plan schedules/rent.json`, or on the site. |
| 02 | Prepares each payment on time and tracks paid, pending and failed status | `tick` runs on the **chain's clock**: the period whose window is open is checked and prepared as an unsigned transaction (any account can send it) or sent by a relayer. Every period has a status — `scheduled`, `due`, **`pending`** (in flight), **`paid`** (nonce consumed on chain, with block and tx), **`failed`** (with the reason and the deadline it is retried until), `missed`, `cancelled`. On the fork the six-week run shows each one ([fork-proof.json](public/runs/fork-proof.json)). |
| 03 | Handles insufficient balance or a failed transaction without double-paying | Three layers. **The chain:** each period's nonce is derived from the schedule, so USDC accepts it once — a deliberate replay on the fork was refused: `FiatTokenV2: authorization is used or canceled`. **The ledger:** an intent is on disk before a transaction leaves, its hash right after; a transaction in flight is never doubled. **The checks:** not enough USDC → `failed`, nothing sent, retried; on the fork period 3 failed twice at 100 USDC, then was paid **once** after a top-up. A transaction that **reverted** (the payer moved USDC out in the same block) was recorded as failed with USDC's reason and paid once later. After a simulated crash between sending and recording, the next tick found the payment on chain and sent nothing. Result: **1,000 USDC in 4 transfers for 4 paid periods.** |
| 04 | Shows a payment history and the next scheduled payment | `status` prints every period with its status, transaction or reason, the full history (attempts, failures with reasons, confirmations, where each settlement was found) and the next payment with how long until it. The site replays the six weeks step by step with the ledger growing beside it, and the live planner shows the next payment and whether today's balance covers the coming ones. A lost ledger is **rebuilt from the chain alone** — identical on the fork, and proven on a real Pacific authorization ([recovery.json](public/runs/recovery.json)). |

## Six weeks on a fork ([fork-proof.json](public/runs/fork-proof.json))

`npm run pay -- demo` forks Pacific mainnet (block 22,572,217 for the recorded run), funds fresh test keys on the
fork only, has the payer sign 6 weekly authorizations of 250 USDC once, and moves the chain clock week by week:

| period | what happened | status |
|---|---|---|
| 1 | an hour early the chain refuses it (`authorization is not yet valid`); at the due time the agent pays | paid |
| 2 | the agent "crashes" after sending, before recording the hash; the next tick finds the payment on chain and sends nothing; a replay is refused (`authorization is used or canceled`) | paid |
| 3 | the payer has 100 USDC: failed twice, nothing sent; after a top-up, paid once | paid |
| 4 | the payer moves USDC out in the same block: the sent payment reverts (`ERC20: transfer amount exceeds balance`); after a top-up, paid once | paid |
| 5 | the payer cancels it on chain before its due time; the agent finds the cancellation | cancelled |
| 6 | no USDC during the whole window; afterwards, even with money, the expired authorization is refused (`authorization is expired`) | missed |

Then the ledger is thrown away and the history is rebuilt from the chain: **identical** statuses and transactions.

## On mainnet (recorded, read-only)

- [plan-rent.json](public/runs/plan-rent.json) — 12 monthly payments of 1,850 USDC from a real Pacific wallet:
  the calendar, every nonce unused on chain, today's balance covers 75 payments, **112,438 gas** per payment
  (measured with an equivalent test signer at the head block; paid by whoever submits).
- [plan-weekly.json](public/runs/plan-weekly.json) — 8 weekly payouts of 640.5 USDC.
- [recovery.json](public/runs/recovery.json) — a real EIP-3009 authorization used on Pacific, found again knowing only
  its signer and nonce: block **22,413,311**, tx [`0xfb883c8b…`](https://www.pharosscan.xyz/tx/0xfb883c8bd2600a9ab9d7f5c600c62d6c31149063e09d2b1173c1dd8bff7c47c1),
  659,059 blocks searched in 13.8 s — the same block and transaction as the event.

## Run it

```bash
npm install
npm run pay -- plan schedules/rent.json                 # live: calendar, coverage, gas, nonces
npm run pay -- new schedules/rent.json --dir .recurring/rent
npm run pay -- attach .recurring/rent --sigs sigs.json   # signatures from the payer's wallet (to-sign.json), each checked
npm run pay -- tick .recurring/rent                      # on a timer: prepares the due payment (unsigned)
npm run pay -- status .recurring/rent                    # statuses, history, next payment
npm run pay -- cancel .recurring/rent --period 3         # what the payer signs to withdraw a future period
npm run pay -- demo                                      # the six weeks above, to .recurring-proof/ (Anvil comes via npm)
npm run web                                              # the demo site on http://localhost:3140
```

`tick --relay` sends the payment with `RELAYER_PRIVATE_KEY` (gas only); `sign` signs with `PAYER_PRIVATE_KEY` for a
payer running the tool themselves — see [.env.example](.env.example). Exit codes: `0` ok · `3` the due payment could
not be made this tick (reason printed) · `2` a mistake in the input · `1` the chain or RPC failed.

## Design notes

- **Why authorizations and not a standing allowance.** An allowance lets the spender take any amount at any time;
  a set of EIP-3009 authorizations states the exact amount, recipient and window of each payment up front. The
  agent holds signatures that can do nothing else — and the payer can cancel any future one on chain.
- **Chain time, not wall-clock time.** USDC judges the window with `block.timestamp`, so the agent does too.
- **Who pays gas.** Whoever submits: a relayer, the recipient, the payer. The authorization does not depend on the
  sender, so the payer needs no PROS.
- **EIP-7702.** It is live on Pacific; a delegated payer's signatures are checked through EIP-1271 by USDC, so
  `plan` warns before such a payer signs.

## Tests

```bash
npm test                 # 12 unit tests: calendar (month ends, leap years, offsets), validation, ids and nonces,
                         # signatures, the payment call, statuses from chain facts + ledger, the ledger
npm run test:e2e         # 6 live checks on Pacific: plan, coverage warning, history recovery on a real authorization,
                         # the CLI end to end with a test payer (due now, no USDC → failed, nothing sent), CLI errors, API
node test/e2e.js --fork  # + the six weeks on a fork
```

## Files

- `lib/schedule.js` — validation, calendar, ids and nonces · `lib/authorize.js` — what the payer signs, the calls
- `lib/onchain.js` — nonce state, settlement search, simulation · `lib/agent.js` — the tick and the statuses
- `lib/ledger.js` — the append-only ledger · `lib/forecast.js` — the live plan · `tasks/recurring/recurring.js` — the CLI
- `scripts/fork-proof.js` — the six weeks (`--record` rewrites the published proof) · `scripts/record.js` — mainnet runs
- [Contracts and how they were confirmed](skill/pharos-recurring-payments/references/contracts.md)

MIT
