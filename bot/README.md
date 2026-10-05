# alloybot

A headless service that keeps **USDC.inj at or above a target share of the allUSDC alloy** on Osmosis, by running
the Alloy Rebalancer page's `noble -> inj` loop on a dedicated wallet.

**Status: alpha, unaudited, and it holds a hot key.** It has run live since 2026-09-24 at 100 USDC per loop (results
below). Fund it only with what you are prepared to lose.

## Background

allUSDC is an Osmosis alloy: a transmuter pool (pool 3497) that holds several USDC variants and mints one fungible
allUSDC against them at 1:1. Its backing is currently mostly USDC.noble. Anyone can change that mix by taking one
variant out of the pool, bridging it, and depositing another back in; the pool swaps 1:1 with no fee, so nothing is
earned or lost on the swaps, only on bridge fees and gas.

The page in the repository root (`index.html`) does this by hand with Keplr. This bot does the same loop without a
person in the loop: whenever USDC.inj is below `target_inj_pct` of the pool, it takes USDC.noble out and brings the
same amount back in as USDC.inj. Its own allUSDC balance stays the same apart from fees.

## One loop

By default the bot builds every message itself and relays both CCTP bridges on its own, with no Skip in the path:

| Stage | Chain | What happens |
| --- | --- | --- |
| C1 | Osmosis | swap allUSDC -> USDC.noble on pool 3497 at exactly 1:1, IBC to Noble's orbiter, which burns it via CCTP v1 toward Avalanche (one tx) |
| C1m | Avalanche | once Circle attests the burn, mint it with `MessageTransmitter.receiveMessage` |
| C2 | Avalanche | `TokenMessengerV2.depositForBurn` toward Injective EVM (standard finality, no fee), approving a standing allowance first when the last one has run low |
| C2m | Injective EVM | once attested, mint it with `MessageTransmitterV2.receiveMessage` |
| C3 | Injective | IBC the USDC.inj to the bot's own Osmosis address, no memo |
| C3s | Osmosis | swap USDC.inj -> allUSDC on pool 3497 at exactly 1:1 |

The standing allowance (`cctp_approval_usdc`) adds no exposure: `depositForBurn` only pulls from its own caller, so
only the bot's burns can spend it, and the bot holds USDC on Avalanche only while a loop is between C1m and C2.
Both burns name the bot's own EVM address as `destinationCaller`, so only the bot can mint them. Before a mint is
submitted, the message Circle attested is decoded and checked field by field: domains, the TokenMessengers, the mint
recipient, the amount, the burn token, no fee and no hook. The pinned Circle contracts are checked onchain once per
start (each MessageTransmitter's `localDomain`, each TokenMessengerV2's transmitter), and a mismatch halts.

`--skip` (added to `ExecStart` in `alloybot.service`) starts new loops through Skip's routes instead, as the bot ran
until 2026-09-28:

| Stage | Chain | What happens |
| --- | --- | --- |
| A1 | Osmosis | swap allUSDC -> USDC.noble on pool 3497 at exactly 1:1, IBC to Noble, CCTP v1 to Avalanche (one tx) |
| A2 | Avalanche | exact-amount USDC approval, then Skip's CCTP v2 burn to Injective |
| A3 | Injective | IBC to Osmosis with an ibc-hooks swap into allUSDC on pool 3497, minimum raised to the full amount |

In that mode every Skip response is checked by the page's own route validators before anything is signed; the bot
loads them, and the pinned contract addresses, straight out of `../index.html`, so there is one copy of those rules.

Every cycle records which stages it runs, so a loop in flight always finishes in the implementation it started with.
A loop that has not signed its first stage yet (for example, one parked on Skip's `no routes found`) is switched to the
implementation the process runs. Each stage's input is the amount that verifiably arrived from the previous one.

A loop starts only when all of these hold:

- USDC.inj is below `target_inj_pct` by at least `min_loop_usdc`, and no loop is already in flight
- the wallet holds idle allUSDC above `reserve_usdc`, and no funds are sitting outside the alloy (see recovery below)
- the transmuter is active, has no corrupted variant and no limiter set
- today's loop count and fee budget have room, and the IBC rate limits have room for the amount

Once the pool is back at target the bot idles, and it starts again by itself if the share falls.

## Measured results

The first ten live loops on 2026-09-24, 100 USDC each, through Skip (`--skip` today), reconstructed from onchain data
(the wallet's allUSDC balance reconciles to the unit). The CCTP loop drops the Skip relay fees below and instead pays
two more Avalanche transactions (the v1 mint, about 0.0006 AVAX at a 5 gwei base fee), negligible Injective EVM gas,
and one more Osmosis fee for the final swap.

**Time.** Median 167 s from the A1 transaction to allUSDC back on Osmosis (average 182 s), plus about 20 s before the
next loop starts: about 17 loops an hour.

| Stage | Typical |
| --- | --- |
| A1 sent -> A2 burn sent (Osmosis, Noble, CCTP v1 to Avalanche, approval) | 54 s |
| A2 burn -> A3 sent (CCTP v2 to Injective) | 111 s |
| A3 sent -> allUSDC back on Osmosis | 1 s |

**Cost per loop.**

| Item | Average | Range |
| --- | --- | --- |
| A1 relay fee, Noble to Avalanche | 0.00157 USDC | 0.00011 to 0.00526 |
| A2 CCTP v2 fee | 0.00046 USDC | flat |
| Osmosis tx fee, paid in allUSDC | 0.00165 allUSDC | flat |
| Avalanche gas, approval + burn | 0.000154 AVAX ($0.0016) | $0.00014 to $0.0067 |
| Injective gas | 0.00006 INJ ($0.0005) | flat |
| **Total** | **$0.0058 (0.58 bps of 100 USDC)** | **$0.0028 to $0.0146** |

The spread is almost all Avalanche's gas price (0.05 to 2.46 gwei that day): the relay fee and the Avalanche gas both
follow it. None of these fees grow with the amount: Skip quoted and the validators accepted identical fees for every
leg at 100, 1,000, 5,000, 10,000, 25,000 and 50,000 USDC, with A3 at exactly 1:1. Larger loops therefore cost the same
in dollars and less per dollar moved.

## How it stays safe

- **Nothing is signed that the page would refuse.** In `--skip` mode every route goes through the page's validators:
  pinned contracts, pinned CCTP adapters and relayers, recipients that are the bot's own addresses, bounded fees, exact
  amounts. In CCTP mode the bot builds each message from pinned constants, checks the orbiter memo with the page's
  orbiter check, and checks every burn event and attested message against what it asked for before minting.
- **No double signing.** Every signed transaction is written to a durable journal (fsynced, with its raw bytes and
  timeout height or nonce) before it is broadcast. A recorded transaction is only forgotten when the chain proves it
  can never move funds: included with an error, past its timeout height, its nonce used by another transaction, or
  refused by the node for a deterministic validation reason. An unclear send (a timeout, a dropped connection, a
  provider error) keeps the record, and the next check resolves it by hash; a restart resumes where it was.
- **A retry needs proof.** A stage whose transaction landed is signed again only when its funds are provably back
  where the stage started (an A3 or C3 refund on Injective, a refunded IBC hop to Noble), at most three signatures per
  stage. A mint whose nonce is already used is never sent again: only the bot can mint its burns, so it was minted.
- **Exact swaps.** Both pool 3497 swaps require the full amount out; a short fill reverts instead of landing short.
- **Stray funds are brought home.** USDC.inj on Injective, USDC on Avalanche, or USDC.noble or USDC.inj on Osmosis found
  with no loop in flight is first read again a minute later (a public endpoint a few blocks behind can still show what
  the last stage just sent). A sighting counts only when the freshest endpoint has also seen every tx the last finished
  loop sent from that account (its sequence or nonce is past them); a node behind them is serving the loop's own funds
  from before they moved. It is then recovered by the part of the loop that starts where it is: C3 onward (A3), C2
  onward (A2 then A3), or a single 1:1 swap into allUSDC on pool 3497. A refunded IBC hop in A1 or C1 is resent from the refunded
  USDC.noble without swapping more. Recovery uses the same validators, journal and fee rules as a loop, runs even
  when the pool is at target, and does not count as a loop. `auto_recover: false` halts instead.
- **Waits instead of halting when time fixes it.** A transfer that has not arrived after its 30-minute window keeps
  being waited for (waiting never re-signs anything), with an alert when it first goes late and every 3 hours after.
  A stage that cannot pay its AVAX or INJ gas mid-loop buys more from the Osmosis allUSDC reserve and carries on.
  Using up `max_gas_refills_per_day` waits for 00:00 UTC with one alert.
- **Halts only for what needs a person.** A loop that lost more than Skip quoted by over `max_loop_loss_bps` of its
  amount, a stage signed three times without success, a balance missing at the start of a stage, a state file for a
  different wallet, or a lost journal each write a `HALTED` file and stop the bot until a person deletes it. A halted
  loop keeps its journal and resumes from the stage it was on.
- **Refused quotes are asked again, indefinitely.** Skip occasionally answers with a detour (a three-hop swap instead
  of pool 3497), and during an Avalanche gas spike the Noble relay fee it quotes can exceed the page's bound; both clear
  by themselves. Nothing is signed for a refused route, so the bot asks again after 30 s, 1, 2, 4 and 8 minutes and
  then every 15 minutes, and sends one alert after six refusals in a row. What is accepted does not change.
- **Hard daily fee ceiling.** A loop starts only if its worst-case loss (the validated quote bounds plus
  `max_loop_loss_bps` of its amount) and its
  fee fit in `max_fee_usdc_per_day`, and every Osmosis transaction rechecks its exact fee before broadcast.
- **One signer.** A lock file stops two instances from running against the same state.

**Gas is self-managed.** Osmosis fees are paid in allUSDC (a chain fee token, pool 3499), so the wallet never needs
OSMO. When AVAX or INJ falls below its floor between loops, the bot buys more with allUSDC through the page's Fund Gas
route: 2 allUSDC for AVAX (Axelar's fee is a flat ~$0.11, which makes 1 allUSDC poor value) and 1 for INJ. A quote
worth less than `gas_min_value_pct` of its cost is not bought; the bot waits and asks again.

## IBC rate limits

Osmosis caps the net flow of each IBC denom per time window. For USDC.inj arriving on Osmosis (A3) every window allows
**100% of USDC.inj's supply on Osmosis**, measured when the window starts; that includes 24-hour, 36-hour, 7-day and
10.5-day windows. When a window expires, the first transfer after it restarts the window and snapshots the supply
again, so the limit grows as USDC.inj is added. (USDC.noble leaving Osmosis, A1, is capped at 20% a day of a much
larger supply and has not been close to binding.)

In practice, net USDC.inj inflow is limited to roughly the current USDC.inj supply per window (about 250k on
2026-09-24), shared with everyone else's flows. Before A1 and before A3 the bot reads every window, sized from the
current supply for a window about to reset, and waits for the earliest reset if there is not room for the amount. It
does not halt for this. `alloybotctl status` shows the remaining room as `rateLimitRoom.injIn`.

## Setup on a Linux VM

For Ubuntu 22.04+ or Debian 12: anything with systemd 247 or newer (`systemctl --version`).

### 1. Clock and packages

```sh
timedatectl                      # must say "System clock synchronized: yes"
sudo timedatectl set-ntp true    # if it does not

sudo apt update && sudo apt install -y git ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node --version                   # v22.x, installed at /usr/bin/node
```

IBC timeouts are timestamps, so a drifting clock causes refunds or refusals.

If `apt install nodejs` fails with a `dpkg-deb ... Broken pipe` error, an older distro Node package is in the way:
`sudo apt remove -y nodejs libnode-dev libnode72; sudo apt --fix-broken install -y`, then install again.

### 2. Code

```sh
sudo git clone https://github.com/JohnnyWyles/alloyrebalancer.git /opt/alloyrebalancer
cd /opt/alloyrebalancer && sudo git checkout headless-bot
cd bot && sudo npm ci --omit=dev
sudo node test.mjs && (cd .. && sudo node test.mjs)    # both must end "0 failed"
```

### 3. Service user and wallet

```sh
sudo useradd --system --home /var/lib/alloybot --shell /usr/sbin/nologin alloybot
sudo install -d -m 700 -o root -g root /etc/alloybot
sudo node /opt/alloyrebalancer/bot/bot.mjs keygen /etc/alloybot/mnemonic
sudo cat /etc/alloybot/mnemonic    # write the 24 words down on paper, once, then clear the screen
```

The mnemonic stays root-only. systemd hands the service a private copy at start (`LoadCredential`), so the `alloybot`
user cannot read `/etc/alloybot` itself. The paper copy is how you recover the funds if the VM is lost.

```sh
sudo install -m 755 /opt/alloyrebalancer/bot/alloybotctl /usr/local/bin/alloybotctl
alloybotctl addresses
```

This prints the wallet's three addresses: `osmo1...` (Osmosis), `inj1...` (Injective) and `0x...` (Avalanche). The
last two come from the same key, as in Keplr.

### 4. Config

```sh
sudo install -d -m 700 -o alloybot -g alloybot /var/lib/alloybot
sudo install -m 600 -o alloybot -g alloybot /opt/alloyrebalancer/bot/config.example.json /var/lib/alloybot/config.json
```

The example is set for a first run: 100 USDC loops and **one loop a day**. `run` and `once` refuse to start without
this file, so a skipped step never means live loops on built-in defaults.

### 5. Fund it

Send **105 allUSDC** to the `osmo1...` address (in the Osmosis app, the asset shown as USDC). Nothing else is needed:
no OSMO, AVAX or INJ. Sending some AVAX yourself is fine and saves the first refill.

```sh
alloybotctl status
```

`balances.allUSDC` must show the amount sent. If it shows 0 and `usdcNobleOnOsmosis` shows the amount, a variant
arrived instead of allUSDC; the bot will not start (it treats USDC.noble on Osmosis as funds stranded by a failed
loop). Send allUSDC instead; the variant can be recovered by importing the mnemonic into Keplr.

The first run buys AVAX gas for 2 allUSDC and INJ gas for 1. Each loop is sized `min(loop_usdc, allUSDC -
reserve_usdc)`, so with 105 the first loop carries about 99.

### 6. Dry run

```sh
alloybotctl once --dry-run
```

This reads everything, builds and simulates the gas refills and the C1 transaction, checks the pinned Circle contracts
onchain, and prints the C2 burn call it would make; it broadcasts nothing. Expect `dry run: would broadcast ...` and
`[dry] CCTP contracts check out`. With `--skip` it builds and simulates A1 and runs the A2 and A3 routes through the
validators instead (`[dry A2] route ok`, `[dry A3] route ok (min_asset raised to the full amount)`).

### 7. Start

```sh
sudo install -m 644 /opt/alloyrebalancer/bot/alloybot.service /etc/systemd/system/alloybot.service
sudo systemctl daemon-reload
sudo systemctl enable --now alloybot
sudo journalctl -u alloybot -f
```

Expect the gas refills, then `starting loop ...`, the three stages, and about three minutes later a line like
`loop complete: 100 out, 99.998952 back, loss 0.001048`. With `max_loops_per_day: 1` it then logs
`max_loops_per_day reached` until 00:00 UTC.

### 8. Ramp up

Edit `/var/lib/alloybot/config.json` (`sudo -u alloybot nano /var/lib/alloybot/config.json`). The bot re-reads it
every minute; no restart is needed. The first two rows are what the live run used; the last two are the planned
next steps, not yet run:

| Step | `loop_usdc` | `max_loops_per_day` | `max_loop_loss_bps` | `reserve_usdc` | `max_fee_usdc_per_day` | Capital |
| --- | --- | --- | --- | --- | --- | --- |
| first loop | 100 | 1 | 10 | 3 | 5 | 105 |
| first day | 100 | 10, then 500 | 5 | 1 | 5 | 105 |
| scaling | 500 | 500 | 2 | 1 | 5 | ~515 |
| larger | 5,000 to 10,000 | 30 to 60 | 1 | 1 | 6 | loop + ~5 |

About 420 loops fit in a day, so `max_loops_per_day` above that changes nothing. Beyond a few thousand USDC per loop,
the IBC rate limit (above) sets the pace, not the loop count. `max_fee_usdc_per_day` must cover the day's loops (about
0.003 to 0.008 allUSDC each), a few gas refills, and one loop's worst-case loss. New capital is picked up by the next
loop without a restart.

## Day to day

| To | Do |
| --- | --- |
| see what it is doing | `alloybotctl status`; `sudo journalctl -u alloybot -f` |
| pause | `sudo -u alloybot touch /var/lib/alloybot/STOP` (a loop in flight finishes); delete the file to resume |
| move the target | edit `target_inj_pct` in `config.json` |
| stop it | `sudo systemctl stop alloybot`; safe mid-loop, the journal resumes the stage on the next start |
| after a halt | read the reason in `/var/lib/alloybot/HALTED`, fix the cause, then `sudo rm /var/lib/alloybot/HALTED` |
| update | `cd /opt/alloyrebalancer && sudo git pull && cd bot && sudo npm ci --omit=dev && sudo node test.mjs && sudo systemctl restart alloybot` |

Halts you might see:

- **... lost X allUSDC, Y more than Skip quoted**: a loop came back short by more than its quotes explain (in CCTP mode
  every leg is quoted at exactly 1:1). Compare the stage amounts in `/var/lib/alloybot/state.json` history and the
  transactions before deleting `HALTED`.
- **attested message refused / ... is not what C1 asked for**: a burn or Circle's message for it did not match what
  the bot sent. Nothing was minted. Read the fields in the reason against the burn transaction before resuming.
- **Circle has not attested ... yet** (a wait, not a halt): the mint stage checks again every minute. A burn that stays
  unattested for long means Circle's attestation service is behind; the funds are in CCTP, the journal keeps the burn,
  and the mint is sent as soon as the attestation exists. To mint by hand, fetch `message` and `attestation` from
  `https://iris-api.circle.com/v2/messages/<source domain>?transactionHash=<burn tx>` and call `receiveMessage` from the
  bot's own address (it is the only allowed caller).
- **... was signed 3 times without success**: three attempts at one stage each failed without moving funds, which
  points at something systematic (fees, account state). The reasons are in `journalctl`.
- **... with no loop in flight, and auto_recover is off**: funds are outside the alloy and automatic recovery is
  disabled. Turn it on, or import the mnemonic into Keplr and use the page's stranded-funds offer.
- **state.json is missing but JOURNAL_INITIALIZED says ...**: the journal was lost (deleted, or the disk restored from
  an older snapshot). It may have been tracking a loop in flight, so the bot will not start a fresh one. Restore
  `state.json`, or check onchain that no funds are outside the alloy (`alloybotctl status` still works: no USDC on
  Avalanche or Injective, no USDC.noble on Osmosis), then delete `JOURNAL_INITIALIZED` and `HALTED`.

## Alerts (optional)

Create a Telegram bot with @BotFather and save its token in a file (not in `config.json`):

```sh
sudo -u alloybot sh -c 'umask 077; cat > /var/lib/alloybot/telegram.token'   # paste the token, Enter, Ctrl-D
```

Then set in `config.json`:

```json
"telegram": { "token_file": "/var/lib/alloybot/telegram.token", "chat_id": "<your chat id>" }
```

Halts, recoveries, late arrivals, six refused quotes in a row, a used-up refill budget, and runs of repeated errors
are sent there.

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | false stops new loops (one in flight finishes) |
| `target_inj_pct` | 50 | USDC.inj share of pool 3497 to hold at or above |
| `loop_usdc` | 100 | allUSDC per loop |
| `min_loop_usdc` | 10 | no loop below this, for either the idle balance or the remaining shortfall |
| `reserve_usdc` | 3 | allUSDC kept back; Osmosis fees are about 0.0017 per loop |
| `max_loops_per_day` | 100 | per UTC day |
| `max_loop_loss_bps` | 10 | loss allowed beyond what Skip quoted for the loop, as bps of its amount; more halts. Expensive but quoted loops (a gas spike) do not halt |
| `max_fee_usdc_per_day` | 5 | per UTC day: loop losses, Osmosis fees, gas refills. A loop or refill that would not fit (with its worst-case loss) waits for 00:00 UTC |
| `gas_floor` | avax 0.02, inj 0.001 | refill below these, between loops. 0.02 AVAX covers one loop at the fee cap |
| `max_gas_refills_per_day` | 4 | needing more waits for 00:00 UTC, with one alert |
| `gas_refill_usdc` | avax 2, inj 1 | allUSDC per refill (at most 10) |
| `gas_min_value_pct` | 80 | a refill must deliver at least this % of its cost in gas, otherwise it waits |
| `avax_max_fee_gwei` | 50 | above this an Avalanche send (C1m, C2, or A2) waits instead of paying |
| `inj_evm_max_fee_gwei` | 5 | the same for the Injective EVM mint (C2m); the chain's base fee is a fixed 0.16 gwei |
| `cctp_approval_usdc` | 1000000 | standing USDC allowance C2 gives TokenMessengerV2 on Avalanche, topped up when it runs below a loop; saves an approval (about 55k gas) per loop. 0 approves exactly each loop's amount |
| `osmo_fee_margin` | 2 | Osmosis fee over the base fee, converted at the fee pool's spot price |
| `rate_limit_margin_pct` | 1 | % of each IBC rate-limit quota cap left free for other users; the bot only uses the rest |
| `stranded_threshold_usdc` | 1 | funds outside the alloy above this, with no loop in flight, are recovered |
| `auto_recover` | true | recover such funds automatically; false halts instead |
| `telegram` | null | optional alerts, see above |

## Files

| File | What it is |
| --- | --- |
| `bot.mjs` | commands (`run`, `once`, `status`, `addresses`, `keygen`), decision loop, config, journal |
| `cycle.mjs` | the resumable loop runner (resume, retry, re-quote, fee ceiling and halt rules) and recovery planning |
| `stages.mjs` | the CCTP stages C1 to C3s, the Skip stages A1 to A3, and N0 (the USDC.noble recovery swap) |
| `cctp.mjs` | pinned Circle contracts, calldata, CCTP message decoding and checks, Iris attestations, the Noble burn lookup |
| `chain.mjs` | pool reads, IBC rate-limit headroom, balances, gas refills |
| `lock.mjs` | the single-signer lock: when a leftover `LOCK` is stale (process gone, taken before a reboot, or its pid reused by another program) |
| `sign.mjs` | key derivation, Cosmos sign-direct (secp256k1; ethsecp256k1 for Injective), EIP-1559, send classification |
| `page.mjs`, `extract.mjs` | load constants, encoders, validators and network helpers from `../index.html` |
| `test.mjs` | signing against cosmjs and ethers reference output, decision and fee-cap math, rate-limit sizing, runner rules, CCTP messages and calldata against real mainnet burns |
| `alloybot.service`, `alloybotctl` | systemd unit (hardened, `LoadCredential` for the mnemonic) and a wrapper that runs one command the same way |
| `config.example.json` | first-run config |

`node test.mjs` runs the bot's suite; `node ../test.mjs` runs the page's.

Dependencies (bot only; the page stays dependency-free): `@noble/curves`, `@noble/hashes`, `@scure/bip32`,
`@scure/bip39`, pinned to exact versions with a lockfile. Node has no built-in keccak-256 or ECDSA recovery, and
audited libraries are preferable to hand-written signing code on a hot wallet.
