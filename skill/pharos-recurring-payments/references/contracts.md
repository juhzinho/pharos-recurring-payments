# Contracts (Pharos Pacific Mainnet, chain 1672)

| Role | Address | How it was confirmed |
|---|---|---|
| USDC (Circle FiatToken v2.2) | `0xC879C018dB60520F4355C26eD1a6D572cdAC1815` | official token registry (Pacific section); `decimals()` = 6; `version()` = "2"; `DOMAIN_SEPARATOR()` = EIP-712 {name "USDC", version "2", chainId 1672, this address}; `TRANSFER_WITH_AUTHORIZATION_TYPEHASH()` and `CANCEL_AUTHORIZATION_TYPEHASH()` equal the standard EIP-3009 type hashes |
| PROS/USD (Chainlink self-managed) | `0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466` | docs.pharos.xyz → Oracles; 18 decimals — only to show fees in USD |

## EIP-3009 as USDC enforces it

- `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s)` — accepted iff
  `validAfter < block.timestamp < validBefore` and `authorizationState(from, nonce)` is false; any account may submit.
- `cancelAuthorization(authorizer, nonce, v, r, s)` — the payer withdraws an unused authorization.
- `authorizationState(authorizer, nonce)` — true once used or cancelled, forever.
- Events: `AuthorizationUsed(authorizer indexed, nonce indexed)`, `AuthorizationCanceled(authorizer indexed, nonce indexed)`.
- Revert strings quoted by the agent: `FiatTokenV2: authorization is not yet valid`, `… is expired`,
  `… is used or canceled`, `ERC20: transfer amount exceeds balance`.

## Network facts

- Balances in USDC live in storage slot 9 (mapping) — used only to fund test wallets on a fork and for the gas
  measurement's state override.
- Past state is served (archive reads): a period's settlement block is found by binary search on `authorizationState`.
- `eth_getLogs` is served over at most 1,000 blocks; blocks come about every 0.95 s.
- The base fee read in every recorded run is 10 gwei (it is read from the block each time, never assumed).
