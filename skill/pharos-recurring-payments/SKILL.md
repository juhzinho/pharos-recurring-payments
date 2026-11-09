---
name: pharos-recurring-payments
description: Run a repeating USDC payment on Pharos Pacific Mainnet — rent, a subscription, payroll-style payouts — on a weekly or monthly schedule. The payer signs the whole schedule once (one EIP-3009 authorization per period, each valid only inside its own window, with a nonce derived from the schedule); the agent pays each period on time, tracks paid / pending / failed / missed / cancelled from chain, retries after insufficient balance or a reverted transaction, and can never pay a period twice. Use for "pay rent every month", "weekly payout", "subscription", "recurring transfer", "standing order", "what is my next payment" on Pharos.
license: MIT
metadata:
  author: juhzinho
  version: "1.0.0"
  chain: "Pharos Pacific Mainnet (1672)"
---

# Pharos Recurring Payments

A Skill for an agent that must pay the same thing on a schedule without ever paying a period twice — after a
crash, a retry, a reverted transaction or a second agent running the same schedule.

```
schedule (weekly | monthly) ─▶ payer signs N authorizations once ─▶ every tick, at chain time:
  period k:  nonce_k = keccak(schedule id, k)     valid only while  due_k ≤ block time < due_k + grace
             USDC accepts nonce_k once → paid | cancelled | (window closed) missed — read from chain
```

## Why it cannot double-pay

Each period is a USDC `TransferWithAuthorization` signed by the payer: recipient, amount, `validAfter = due − 1`,
`validBefore = due + grace`, and a nonce derived from the schedule and the period number. USDC itself (Circle
FiatToken v2.2 on Pacific) refuses it before the due time (`authorization is not yet valid`), after the window
(`authorization is expired`) and a second time (`authorization is used or canceled`). The agent's own ledger only
adds the human story (attempts, reasons); paid, cancelled and missed are read from `authorizationState`.

## When to use

- The user wants a repeating payment set up, run, paused (cancel a period) or explained.
- The user asks what was paid, what failed and why, or when the next payment is.
- A schedule's ledger was lost: `status` rebuilds the history from chain (it finds each period's block and
  transaction by a binary search on `authorizationState`, then that block's log).

## How to run it

The executable lives in the repository root (`tasks/recurring/recurring.js`). From there:

```bash
npm install
npm run pay -- plan schedules/rent.json            # live on mainnet: calendar, coverage by today's balance, gas, nonces
npm run pay -- new schedules/rent.json             # a schedule folder + to-sign.json (one EIP-712 message per period)
npm run pay -- attach <dir> --sigs sigs.json       # the payer's signatures, from any wallet — each checked
npm run pay -- tick <dir>                          # the due payment as an unsigned transaction (any account can send it)
npm run pay -- tick <dir> --relay                  # or send it with RELAYER_PRIVATE_KEY (pays gas, moves nothing else)
npm run pay -- status <dir>                        # each period's status, the history, the next payment
npm run pay -- cancel <dir> --period 3             # what the payer signs to withdraw one future period
npm run pay -- demo                                # six weeks of a schedule on an Anvil fork
```

Run `tick` on a timer (cron, a scheduled agent): it is idempotent and uses the chain's clock. Exit codes: `0` ok ·
`3` the due payment could not be made this tick (reason printed, retried next tick) · `2` a mistake in the input ·
`1` the chain or RPC failed. Formats: [references/schedule-format.md](references/schedule-format.md). Contracts and
how they were confirmed: [references/contracts.md](references/contracts.md).

## Rules for the agent

1. **Never hold the payer's key.** The payer signs the typed data in `to-sign.json` with their own wallet; `sign`
   (PAYER_PRIVATE_KEY) exists only for a payer running the tool themselves.
2. Report per period with its status, and for `failed` / `missed` the reason exactly as given. Never say "paid"
   unless the period's nonce is consumed on chain.
3. A failed period is retried only inside its window; say until when. Never re-sign a missed period's payment
   under the same schedule to "catch up" — propose a new one-off payment and let the payer decide.
4. Never send a second transaction for a period while one is in flight; the tool waits ~3 minutes before treating it
   as dropped (and even then USDC accepts the period once).
5. Show the next payment (date and how long until it) and whether today's balance covers the coming ones.
