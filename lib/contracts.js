import { encodeAbiParameters, getAddress, keccak256, parseAbi } from "viem";

// Pharos Pacific Mainnet (chain 1672). Checked on chain (see skill/…/references/contracts.md):
// - USDC is Circle FiatToken v2.2 — EIP-3009 (transferWithAuthorization, cancelAuthorization, authorizationState),
//   EIP-712 domain {name "USDC", version "2", chainId 1672}; official token registry.
// - PROS/USD: Chainlink self-managed feed, 18 decimals (only to show fees in USD).

export const CHAIN_ID = 1672;
export const PACIFIC_RPC = "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const USDC = { symbol: "USDC", address: getAddress("0xc879c018db60520f4355c26ed1a6d572cdac1815"), decimals: 6 };
export const PROS_USD = getAddress("0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466");
export const USDC_DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC.address };

export const TYPES = {
  TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }],
  CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }],
};

export const ABI = {
  usdc: parseAbi([
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address to, uint256 value) returns (bool)",
    "function isBlacklisted(address) view returns (bool)",
    "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
    "function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
    "function cancelAuthorization(address authorizer, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
    "event AuthorizationCanceled(address indexed authorizer, bytes32 indexed nonce)",
  ]),
  feed: parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]),
};

// USDC balances live in slot 9 (mapping address → uint256); used only for fork funding and simulations.
export const USDC_BALANCE_SLOT = 9n;
export const balanceSlot = (owner) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, USDC_BALANCE_SLOT]));
