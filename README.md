# Alloy Rebalancer

**Status: alpha, unaudited.** Run end to end with live wallets: allUSDC USDC.noble -> USDC.inj (Keplr, a
Ledger, and the headless bot in [`bot/`](bot/README.md)) and allUSDT USDT.eth.inj -> USDT.eth.atom (Peggy and
Eureka). The other routes are checked against saved API responses but have not yet run with a live wallet. Use
small amounts; routes through Nomic, Chainflip or Injective's Peggy bridge are additionally capped and need an
explicit acknowledgement in the page.

**Headless bot.** [`bot/`](bot/README.md) runs the allUSDC noble -> inj loop unattended on its own wallet, keeping
USDC.inj at or above a target share of the alloy. It reuses this page's route validators and pinned constants,
signs with its own key, and is set up as a systemd service on a Linux VM.

Browser tool that shifts the backing of an Osmosis alloy (transmuter pool) from one variant to another
by taking one variant out, bridging it, and depositing another back in, so the alloy's composition moves
while your alloy balance stays the same, minus gas and bridge fees. Keplr signs everything: Osmosis,
Injective and Noble directly, Avalanche, Ethereum and Injective EVM through Keplr's EVM provider, and
Bitcoin through Keplr's Bitcoin provider.

Ledger keys behind Keplr are supported. On Osmosis and Noble the page signs legacy amino JSON (the only
mode the Ledger Cosmos app accepts; the device may need Expert mode for larger contract messages). On
Injective it signs EIP-712 typed data through the Ledger Ethereum app (Keplr's
`experimentalSignEIP712CosmosTx_v0`): the amino sign doc is wrapped as typed data, the transaction carries
`ExtensionOptionsWeb3Tx` with `typedDataChainID` 1, and IBC transfers get a fully nonzero timeout height
because the chain's typed-data encoder refuses omitted zero fields. The generated typed data is tested
byte-for-byte against Injective's own web3gw `PrepareEip712` responses (`test-fixtures/eip712-golden-*`).
The Ethereum app may need blind signing enabled. The Bitcoin routes still need a mnemonic-backed account
(Keplr has no Ledger Bitcoin provider). EVM signatures go through Keplr's EVM provider either way.
A full USDC.noble -> USDC.inj loop has run on a live Ledger (amino on Osmosis, EVM on Avalanche, EIP-712
on Injective); the Peggy `MsgSendToEth` leg is the one Ledger signature not yet exercised.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The tool. Single dependency-free file, no build step. |
| `test.mjs` | Regression suite: encoder bytes against reference implementations, bech32 and Nomic derivations, and every route validator against saved Skip, Chainflip and Nomic responses. `node test.mjs` |
| `test-fixtures/` | Real API responses (good routes and the ones that must be refused), the Nomic signatory set the derivation is checked against, and reference bytes for the encoders. |
| `serve.cmd` | Serves this folder on `127.0.0.1:8900`. Local only, deliberately. |
| `bot/` | Headless allUSDC noble -> inj loop on its own wallet, holding USDC.inj at or above a target share. Reuses this page's validators. See `bot/README.md`. |
| `LICENSE` | Apache 2.0. |

## A word on trusting this page

It builds and signs transactions that move real funds across seven chains, so where you load it from
matters as much as what it does. Serve it locally (`serve.cmd`) or from a source you control over HTTPS;
never over plain HTTP to a network. The page ships a Content-Security-Policy meta tag (no external
scripts or styles, HTTPS-only connections); when hosting, add the headers a `<meta>` tag cannot carry
(`frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`). It is one file with no build step precisely so that what you read is
what runs, and `node test.mjs` checks the signing-critical parts against committed reference bytes and
real API responses. Keys never leave Keplr.

## What it does

Moves the allUSDC transmuter's backing from one constituent to another without changing your own
allUSDC balance. Pick what to reduce and what to increase; the page runs the matching plan. Keplr
signs everything: the Cosmos chains directly, Avalanche, Ethereum and Injective EVM through its
EIP-1193 provider. Each stage's input is the amount that verifiably arrived from the previous one.
USDC.noble and USDC.inj bridge over CCTP with Avalanche as the hub; USDC.axl (Skip's name for
USDC.eth.axl) only exists via Axelar, so anything touching it goes through Ethereum.

| Reduce → increase | Signatures | Legs |
| --- | --- | --- |
| noble → inj | 3, ~5 min | Osmosis own tx (3497 swap into USDC.noble + Skip's Noble transfer, atomic) → Noble → CCTP v1 → Avalanche; CCTP v2 → Injective; IBC + hook swap → allUSDC |
| inj → noble | 4, ~7 min | Osmosis own tx (3497 swap + IBC to your Injective address); Injective EVM CCTP v2 → Avalanche; CCTP v1 → your Noble account; Noble IBC + hook swap → allUSDC |
| noble → axl | 2, ~22 min | Osmosis own tx as above, toward Ethereum; Ethereum Axelar GMP → Osmosis with the 3497 axl→allUSDC swap on arrival |
| inj → axl | 3, ~22 min | Osmosis own tx → Injective; Injective EVM CCTP v2 → Ethereum; Ethereum Axelar GMP → allUSDC |
| axl → noble | 3, ~26 min | Osmosis own tx (3497 swap into USDC.axl + Skip's Axelar transfer to Ethereum, atomic); Ethereum CCTP v1 → your Noble account; Noble IBC + hook swap |
| axl → inj | 3, ~26 min | Osmosis own tx as above; Ethereum CCTP v2 → Injective; Injective IBC + hook swap |

**Alloyed BTC, ETH and USDT** each have one routable pair: the Axelar variant and the Cosmos Hub (IBC
Eureka) variant of the same Ethereum token (WBTC.eth.axl and WBTC.eth.atom; ETH.axl and ETH.atom;
USDT.eth.axl and USDT.eth.atom). Both directions are two signatures and go through Ethereum:

| Reduce → increase | Legs |
| --- | --- |
| axl → atom | Osmosis own tx (pool swap into the Axelar variant + Skip's Axelar transfer to Ethereum); Ethereum tx to Skip's Eureka contract → Cosmos Hub → Osmosis with the pool swap into the alloy on arrival |
| atom → axl | Osmosis own tx (pool swap into the Hub variant + Skip's IBC transfer to the Hub, whose Skip contract forwards over Eureka to your Ethereum address); Ethereum Axelar GMP → Osmosis with the pool swap on arrival |

Fees: Axelar unwrap about $0.85 to $1.60 taken from the amount, Axelar wrap about $0.11 of ETH as native
value, Eureka about $0.20 either way taken from the amount, plus Ethereum gas for one transaction and
its approval. Eureka delivery takes about 20 minutes, Axelar about 16.

**Alloyed USDT's Injective variant (USDT.eth.inj)** rides Injective's Peggy bridge, which Skip does not drive,
so those legs are built by the page from pinned constants and verified against the chain's own decoder
(`MsgSendToEth`) and the canonical ABI signature (`sendToInjective(address,bytes32,uint256,string)`):

| Reduce → increase | Legs |
| --- | --- |
| inj → axl / inj → atom | Osmosis own tx (pool swap into USDT.eth.inj + IBC to your Injective address); Injective `MsgSendToEth` to your Ethereum address (bridge fee about 5 USDT, what relayers accept; batched, usually minutes, sometimes an hour or more); then the Axelar or Eureka wrap into the alloy |
| axl → inj / atom → inj | Axelar or Eureka unwrap to Ethereum; Ethereum `sendToInjective` on the Peggy contract with your Injective account as destination (about 20 minutes); Injective IBC to your Osmosis address; Osmosis pool swap into allUSDT |

**Freeze monitoring.** Every pool refresh (60 s) reads the transmuter's `is_active` and `get_corrupted_denoms`.
An inactive transmuter or a corrupted variant marks the alloy FROZEN in the pool box, flags the corrupted
variant in its row, and disables starting any stage for that alloy; a cycle already in flight keeps its
recorded state and can Continue once the alloy is active again.

No other variant of these alloys has a bridge route in Skip: nBTC (Nomic), ckBTC (Internet Computer),
the Osmosis-minted WBTC, cbBTC.axl (a different token), USDT.eth.inj (Injective's Peggy bridge). Alloyed
SOL has a single variant and is composition view only.

**Alloyed BTC's Nomic variant (nBTC)** has no Skip route, so its legs are built here from three pieces, all
of them verified as far as they can be without spending funds:

| Reduce → increase | Legs |
| --- | --- |
| axl → nBTC, atom → nBTC | Axelar or Eureka unwrap to Ethereum WBTC; then one Ethereum ERC20 transfer of WBTC into a Chainflip deposit channel whose destination is a freshly derived **Nomic deposit address**; Chainflip pays BTC there, Nomic mints nBTC and IBC-delivers it to your Osmosis address; Osmosis pool swap into allBTC (1:1 in BTC terms, nBTC has 14 decimals to allBTC's 8) |
| nBTC → axl, nBTC → atom | Osmosis own tx (pool swap into nBTC + IBC to Nomic over `channel-6897` with memo `{"type":"bitcoin","data":"<your Keplr Bitcoin address>"}`), Nomic pays BTC out in its next checkpoint; Keplr Bitcoin sends that BTC into a Chainflip channel paying WBTC to your Ethereum address; Axelar or Eureka wrap into the alloy |

Nomic deposit addresses are derived in the page (a P2WSH over Nomic's weighted signatory set committing to the
IBC destination), reimplemented from `nomic-bitcoin-js` and checked in the test suite against that library's
output for the same signatory set: identical broadcast bytes, identical address. Every relayer in the pinned
list (`relayer.nomic.io`, `relayer.nomic.mappum.io`) must return the same signatory set and accept the
address, or nothing is derived; an address Nomic never learns about swallows the deposit. Chainflip channels
are opened through Chainflip's public backend (`/api/openSwapDepositChannel`, 30 bps commission) and trusted
only after its status endpoint echoes back the destination, deposit address, amount and refund address that
were asked for. Chainflip is a market swap: roughly $8 network fee plus slippage (a fill-or-kill minimum
price at the quote's recommended tolerance protects the floor, refunds go to your own address). Nomic charges
miner fees and, on IBC deposits to Osmosis, a 0% bridge fee at the time of writing (1.5% elsewhere). Expect
hours: Bitcoin confirmations for Chainflip and Nomic, and Nomic's checkpoint cadence for withdrawals. Keplr's
Bitcoin provider (`window.bitcoin_keplr`) supplies the Bitcoin address and signs the one BTC send.

Assumptions still to be confirmed with a small live run: that Nomic's checkpoint pays out to a taproot
(`bc1p…`) address, which is what Keplr Bitcoin uses by default; Nomic's minimum withdrawal; and that Keplr's
Bitcoin account is funded enough for one miner fee on the send.

### Routes still to build

- **XRP.coreum ↔ XRP.xrplevm (Alloyed XRP).** Both variants bridge to XRPL, so XRPL is the hub:
  Coreum's XRPL bridge contract (`core1zhs909…studdrz`, 0.87 XRP bridging fee, relayer set read from its
  `config`) on one side, and XRPL ↔ XRPL EVM over Axelar on the other. Blocked until the XRPL EVM IBC
  connection to Osmosis is live again (Skip returns no route for it today), and it needs an XRPL wallet
  (Xaman or Crossmark; Keplr does not sign XRPL). Four signatures per direction across two wallets.


This is not an arbitrage. The transmuter swaps at 1:1 with no fee, so nothing is earned; the point
is the change in the pool's composition. The axl directions carry Axelar's flat fee (about 1.05
USDC out of the amount when unwrapping to Ethereum, about 0.11 USD of ETH when wrapping in) plus
Ethereum gas, so small cycles there are proportionally dearer.

Why some directions take the long way: Skip's default answers for several of these legs go to
addresses that cannot be checked from the transaction. Asked to move USDC.inj off Osmosis, or USDC
from Avalanche to Osmosis as USDC.noble, it routes through **per-destination forwarders** of its own
(the receiver changes with the destination; the calldata holds neither your Osmosis nor your Noble
address). Asked to move USDC.axl off Osmosis, it swaps it into USDC.noble on pool 3497 (or pool 1223
at small size) and CCTPs from Noble, which is not an axl exit at all. Asked for allUSDC directly from
Avalanche, it picks its Go Fast solver or a CCTP v1 mint on Noble and re-deposits **USDC.noble**,
undoing the rebalance. Asked for USDC.inj from Osmosis in one request, it routes small amounts through
pool 3497 itself (pulling USDC.inj *out*) and larger ones through Injective's DEX at 30 bps. Asked to exit allUSDC toward a hub at small size, it swaps allUSDC into allBTC on pool 3504 and allBTC into USDC.noble on pool 1943 for a 0.04% edge, which leaves the transmuter's Noble balance untouched. So every transmuter exit is the page's own `MsgSwapExactAmountIn` on pool 3497, and the Skip leg starts from the constituent. Every one
of these is a saved fixture the validators must refuse. Where the direct route was unverifiable the
page builds the leg itself (the transmuter swap is our own `MsgSwapExactAmountIn`, verified against
the chain's decoder) or asks Skip with the bridge set restricted, and every recipient is your own
address in the signed bytes.

Every Skip response is checked field by field against pinned constants before a wallet opens: pool
id, both denoms per hop, the entry point contract, the Noble orbiter account, the Axelar GMP account
and Skip's Axelar receiver, both CCTP v1 adapters (they differ per chain) and the v2 adapter, the
CCTP destination domain, mint and final recipients (must be you, including inside Axelar GMP calldata
and payloads), exact approval amounts, native value equal to the quoted relayer fee and under a cap,
no affiliates, no extra bridges, at most 5 bps quoted loss on CCTP legs (or a small flat allowance for the relay fee, so a 25 USDC test
cycle is not refused) and a fixed cap on the Axelar fee. A route that deviates is refused with the list of reasons; nothing is corrected silently.
Arrival at each stage means the destination balance **rose** by the quoted amount, not that Skip
said so. EVM balances are read over public RPC so refreshing never asks the wallet to hop chains.

**Fund gas** buys a chain's fee token with 1 allUSDC (5 for Ethereum, since Axelar's flat fee is about
$1.10) and delivers it to your address there: OSMO via pool 3499; AVAX and ETH via Axelar GMP; INJ via
pool 1319 and IBC; USDC on Noble via pool 3497 and IBC. Pools are not pinned for these, but the
contract, the exact amount, no affiliates, the recipient and a minimum USD value back are.

The alloy selector offers a pinned set (Alloyed BTC, ETH, SOL, USDC, USDT and XRP, by pool id and contract
address) rather than discovering pools at load. The composition comes from the contract's
`list_asset_configs` (the valid variants and their normalisation factors), not from what the contract
happens to hold. Variant names and decimals come from the generated frontend assetlist in osmosis-labs/assetlists
(USDC.noble, nBTC and so on), with Skip's registry as the fallback if GitHub is unreachable. The table shows each variant's balance, its share in the transmuter's normalised units (variants can carry different exponents), any
limiter configured for it, and a bar of the distribution. Bridge plans exist for Alloyed USDC, USDT, BTC and ETH; Alloyed SOL and XRP are composition view only.

**Let Skip choose the exit route** is an opt-in toggle for the exits that go out through USDC.noble. Off
(the default), the exit is the page's own pool 3497 swap plus Skip's transfer from USDC.noble. On, Skip
routes from allUSDC itself and may go through other pools when they pay a hair more; everything after
the swap is still checked as strictly, and the page states whether the chosen path took USDC.noble out
of pool 3497 or bypassed it, in which case the cycle only dilutes Noble's share and removes none of it.
Both quotes are shown side by side before you start. Exits into USDC.inj or USDC.axl are never routed
by Skip, so the toggle does not apply to them.

Cycle state persists in local storage so a reload mid-flight resumes at the right stage. Each stage
records the transaction hash the moment it exists (before broadcast on Cosmos chains, as soon as the
wallet returns it on EVM chains) together with the destination balance it started from and the amount it
expects, so a reload after signing never signs again: on Continue, or automatically once Keplr is
reconnected, the page confirms the transaction exists onchain and goes back to waiting for arrival. A
recorded transaction the network does not know about is never cleared automatically: the page stops,
explains, and clearing it is a separate confirmed action (see Safety behaviour). Balances refresh every 30
seconds and the pool every 60. If USDC is
found parked on Avalanche, Ethereum, Injective or Noble with no cycle recorded, the page offers to
continue from that balance in whichever direction passes there. Balances display to two decimal
places (exact amounts appear in confirmations and the log). Pinned contract addresses will need
updating if Skip rotates them; the failure message names the constant.

The CCTP v1 legs (Noble to and from Avalanche or Ethereum) were still routing on 2026-08-28, after
Circle's announced v1 deprecation date. Expect them to stop at some point; the affected stage will
then fail at route validation.

## Safety behaviour

- **Every EVM call is decoded, not pattern-matched.** Each pinned adapter (Skip's CCTP v1 and v2 adapters,
  Axelar receiver, Eureka contract) has its function selector pinned and its arguments compared word by
  word: amount net of the quoted fee, destination domain, mint recipient, burn token, fee, relayer or fee
  recipient, and, for Axelar and Eureka, the dynamic strings read from their ABI offsets (destination chain,
  address and token symbol; the Osmosis instructions decoded as exactly a `0x00000002` envelope plus one
  UTF-8 JSON document whose only key is `swap_and_action_with_recover` with your recovery address; the Hub
  receiver and client). Extra words are refused. Stale nonzero allowances are reset to zero before a new
  approval, as USDT requires.
- **A recorded transaction is never re-signed automatically.** Each stage records the hash and the chain it
  was broadcast on the moment the hash exists. On resume the page classifies it as included, pending,
  failed or unknown (Cosmos via the tx endpoint, EVM via receipt and `eth_getTransactionByHash`, Bitcoin
  via mempool.space). Included or pending: it waits. Failed or unknown: it stops and explains; discarding
  the record is a separate button behind a confirmation, because "unknown" is not proof it will not land.
- **Cycles are bound to the wallets that started them.** The Osmosis, Injective, Noble, Hub, EVM and (for
  BTC plans) Bitcoin addresses are recorded; if any differs on Continue, the cycle refuses to proceed
  rather than spending another account's balance while the earlier transfer sits at the old one.
- **Balance baselines never default to zero.** A failed balance read stops the stage; the arrival check is
  always "rose by the quoted amount from a real baseline".
- **Chainflip channels must carry fill-or-kill protection** equal to what was requested (refund address,
  retry window, minimum price within 1e-9) and be provably opened through Chainflip's backend, or the
  deposit is not sent.
- **Pool state fails closed.** An alloy is marked unavailable while its state is being read and stays that
  way if any safety-critical query (composition, `is_active`, corrupted denoms) fails.
- Contract-controlled text (limiter labels) is escaped before it reaches the page; the confirmation sheet's
  backdrop cancels rather than orphaning the pending decision.

## Implementation notes

Protobuf encoding is hand-written and verified against reference implementations: `MsgTransfer` and
`MsgExecuteContract` against `cosmjs-types`, `MsgSwapExactAmountIn` and `MsgSendToEth` against the chains'
own `/cosmos/tx/v1beta1/decode`. Nomic deposit addresses are checked against `nomic-bitcoin-js` output
for the same signatory set. The Peggy selector is checked against `keccak256` of its canonical signature
by a keccak implementation in the test suite. All signing is `SIGN_MODE_DIRECT`; Injective's
`EthAccount` wrapper and `ethsecp256k1` pubkey type are handled explicitly.

The two recurring hazards from the sibling `manualibc` tool apply here too: `timeout_height` must always be
emitted (empty submessage), and `SignDoc.account_number` must be omitted when zero. The suite guards the
long async handlers against temporal-dead-zone bugs by checking each binding is declared before use.
