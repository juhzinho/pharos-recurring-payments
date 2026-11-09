# Schedule format

```json
{
  "label": "Studio rent",
  "payer": "0x6ea08ca8f313d860808ef7431fc72c6fbcf4a72d",
  "recipient": "0x1111111111111111111111111111111111111111",
  "token": "USDC",
  "amount": "1850",
  "every": "monthly",
  "start": "2026-11-30T09:00:00Z",
  "count": 12,
  "graceHours": 72,
  "salt": "1"
}
```

| field | meaning | rules |
|---|---|---|
| `payer` | who pays (signs the authorizations) | an address; an EIP-7702 or contract wallet signs through EIP-1271 — `plan` warns |
| `recipient` | who is paid | an address, not the payer, not zero |
| `token` | the token | `USDC` (EIP-3009 is what makes each period payable once, in its window) |
| `amount` | per payment | a decimal string, up to 6 decimals |
| `every` | `weekly` or `monthly` | monthly keeps the start's day of month, clamped to short months (31 → Feb 28/29 → Mar 31) and the same UTC time |
| `start` | the first due time | ISO 8601 with a time zone (`Z` or `±hh:mm`), whole seconds |
| `count` | number of payments | 1 to 60 |
| `graceHours` | how late a payment may still be made | 1 to 144 (weekly) / 648 (monthly): a window closes before the next one opens |
| `salt` | tells two otherwise identical schedules apart | optional, default `"1"` |
| `label` | free text | not part of the schedule's identity |

The schedule id is `keccak256(abi.encode("pharos-recurring-payments/v1", payer, recipient, token, amount, every,
start, count, graceSeconds, salt))`; period k's nonce is `keccak256(abi.encode(id, k))`. Changing any field changes
every nonce, so old signatures never apply to a new schedule.

## Statuses

| status | meaning | source |
|---|---|---|
| `scheduled` | not due yet | chain time < due |
| `due` | the window is open, nothing attempted yet this window | chain time, ledger |
| `pending` | a transaction was sent and is not mined yet | ledger + receipt |
| `failed` | this window's last attempt failed (reason given); retried until the window closes | ledger |
| `paid` | the nonce was consumed by the payment (block and transaction recorded) | **chain** |
| `cancelled` | the payer cancelled the authorization on chain | **chain** |
| `missed` | the window closed unpaid — the authorization has expired | chain time + **chain** |

## Folder (`.recurring/<id>/`)

- `schedule.json` — the input, its id, the payer's signatures and the block they were stored at
- `to-sign.json` — the typed data the payer signs (`eth_signTypedData_v4`, one per period)
- `ledger.jsonl` — append-only, flushed per line: `attempt` (written before a send), `submitted` (hash),
  `confirmed`, `failed` (reason, `sent` true/false), `dropped`, `prepared`, `settled` (from chain: paid/cancelled,
  block, hash, source), `missed`
