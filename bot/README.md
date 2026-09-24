# alloybot

A headless version of the page's allUSDC **noble -> inj** loop that runs on its own wallet and keeps USDC.inj at or
above a target share of the allUSDC alloy (pool 3497).

**Status: alpha, unaudited, a hot wallet.** Fund it only with what you are prepared to lose, and start with one loop a day.

## What it does

Every 60 seconds it reads pool 3497. A loop starts only when **all** of these hold:

- USDC.inj is below `target_inj_pct` by at least `min_loop_usdc`
- no loop is already in flight, and the wallet has idle allUSDC above `reserve_usdc`
- the transmuter is active, has no corrupted variant and no limiter set
- the day's loop and fee caps are not used up, and the IBC rate limits have room
- no funds are sitting outside the alloy from an earlier loop

It then runs the same three stages as the page, each verified by the page's own validators (the bot loads them
straight out of `../index.html`):

| Stage | Chain | What happens |
| --- | --- | --- |
| A1 | Osmosis | swap allUSDC -> USDC.noble on pool 3497 at exactly 1:1, IBC to Noble, CCTP v1 to Avalanche (one tx) |
| A2 | Avalanche | exact-amount approval, then CCTP v2 burn to Injective |
| A3 | Injective | IBC to Osmosis with a hook swap into allUSDC; the bot raises the swap's minimum to the full amount |

Each stage's input is what verifiably arrived from the previous one. A loop takes about 20 minutes, and while the pool
stays below target the next one starts as soon as the last one finishes. At 100 USDC a loop costs about 0.02 USDC
in bridge fees (quoted live on 2026-09-24) plus gas.

**Gas looks after itself.** Osmosis fees are paid in allUSDC (a chain fee token), so the wallet never holds OSMO.
When AVAX or INJ falls below its floor the bot buys more with allUSDC through the page's Fund Gas route: 2 allUSDC
for AVAX (Axelar takes a flat ~$0.11, so 1 allUSDC returned only $0.82 on 2026-09-24) and 1 allUSDC for INJ. A quote
worth less than `gas_min_value_pct` of what it costs is not bought; the bot waits 30 minutes and asks again.

**A refused quote is asked again.** Skip sometimes answers with a detour (for example a three-hop swap instead of
pool 3497) that it no longer offers a minute later. Nothing is signed for a refused route, so the bot asks again after
30 s, 1, 2, 4 and 8 minutes, and halts only when six answers in a row are refused. Every answer still goes through the
page's validator; nothing about what is accepted changes. Gas routes are asked again every 10 minutes, six times.

**It halts rather than guessing.** A route refused six times in a row, a loss above `max_loop_loss_bps`, an arrival
that does not come, or funds found outside the alloy all write a `HALTED` file and stop the bot until a person deletes
it. A halted loop keeps its journal and resumes where it was. A stage is signed again only when the chain proves the previous attempt
never moved funds (failed in block, past its timeout height, rejected at CheckTx), or when an A3 refund is back on
Injective, and never more than 3 times.

## Setup on a Linux VM

Written for Ubuntu 22.04+ or Debian 12 (anything with systemd 247 or newer; check with `systemctl --version`).

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

The mnemonic stays root-only. systemd hands the service a private copy at start (`LoadCredential`), so the
`alloybot` user cannot read `/etc/alloybot` itself. The paper copy is how you recover funds if the VM is lost.

```sh
sudo install -m 755 /opt/alloyrebalancer/bot/alloybotctl /usr/local/bin/alloybotctl
alloybotctl addresses
```

This prints the wallet's three addresses: `osmo1...` (Osmosis), `inj1...` (Injective) and `0x...` (Avalanche).

### 4. Config

```sh
sudo install -d -m 700 -o alloybot -g alloybot /var/lib/alloybot
sudo install -m 600 -o alloybot -g alloybot /opt/alloyrebalancer/bot/config.example.json /var/lib/alloybot/config.json
```

The example is set for the first run: 100 USDC loops, 3 USDC reserve, **one loop a day**.

### 5. Fund it

Send **105 allUSDC** to the `osmo1...` address. In the Osmosis app this is the asset shown as USDC. Send nothing else:
no OSMO, AVAX or INJ.

```sh
alloybotctl status
```

`balances.allUSDC` must read 105. If it reads 0 and `usdcNobleOnOsmosis` shows the amount, a variant arrived instead
of allUSDC, and the bot will refuse to start (it treats USDC.noble on Osmosis as funds stranded by a failed loop).
Send allUSDC instead; the variant can be recovered later by importing the mnemonic into Keplr.

What happens to the 105: the first run buys AVAX gas for 2 allUSDC and INJ gas for 1, and each loop is sized as
`min(loop_usdc, allUSDC - reserve_usdc)`, so the first loop carries about 99 allUSDC. Send 108 if you want the
first one to be a full 100.

### 6. Dry run

```sh
alloybotctl once --dry-run
```

This reads everything, builds and simulates the gas refills and the A1 transaction, fetches the A2 and A3 routes
for the same amount and runs them through the validators. It broadcasts nothing. Expect lines ending in
`dry run: would broadcast ...` and `[dry A2] route ok`, `[dry A3] route ok (min_asset raised to the full amount)`.

### 7. Start

```sh
sudo install -m 644 /opt/alloyrebalancer/bot/alloybot.service /etc/systemd/system/alloybot.service
sudo systemctl daemon-reload
sudo systemctl enable --now alloybot
journalctl -u alloybot -f
```

The first minutes: an AVAX refill (Axelar, a few minutes), an INJ refill, then `starting loop ...` and the three
stages. After about 20 minutes: `loop complete: 99 out, 98.98 back, loss 0.02`. With `max_loops_per_day: 1` it then
logs `max_loops_per_day reached` until 00:00 UTC.

### 8. Ramp up

After a few clean loops, edit `/var/lib/alloybot/config.json` (the bot re-reads it every minute, no restart):

```sh
sudo -u alloybot nano /var/lib/alloybot/config.json
```

Raise `max_loops_per_day` (about 70 loops fit in a day), then `loop_usdc` once you add capital. Raise
`max_fee_usdc_per_day` alongside: at 100 USDC a loop, 70 loops cost about 1.5 USDC in bridge fees plus gas refills.

## Day to day

| To | Do |
| --- | --- |
| see what it is doing | `alloybotctl status`, `journalctl -u alloybot -f` |
| pause without stopping | `sudo -u alloybot touch /var/lib/alloybot/STOP` (a loop in flight still finishes); delete the file to resume |
| move the target | edit `target_inj_pct` in `config.json` |
| stop it | `sudo systemctl stop alloybot`: safe mid-loop, the journal resumes the stage on the next start |
| after a halt | read the reason in `/var/lib/alloybot/HALTED` or `journalctl`, fix the cause, then `sudo rm /var/lib/alloybot/HALTED` |
| update | `cd /opt/alloyrebalancer && sudo git pull && cd bot && sudo npm ci --omit=dev && sudo node test.mjs && sudo systemctl restart alloybot` |

Halts you might see and what they mean:

- **N refused quotes in a row**: Skip has kept offering a route the validator refuses for about 15 minutes, which
  usually means an adapter, recipient or route shape changed. Check the page and its tests before deleting `HALTED`.
- **USDC.noble on Osmosis / USDC on Avalanche / USDC.inj on Injective with no loop in flight**: an earlier loop left
  funds outside the alloy. Import the mnemonic into Keplr and use the page's stranded-funds offer, or move them by hand.
- **rose by only ...**: a bridge leg did not deliver in time. Look up the recorded tx in `state.json`. When the funds
  land, deleting `HALTED` resumes the loop from that stage.

## Alerts (optional)

Create a Telegram bot with @BotFather, save its token (never paste it into config.json):

```sh
sudo -u alloybot sh -c 'umask 077; cat > /var/lib/alloybot/telegram.token'   # paste the token, Enter, Ctrl-D
```

and set in `config.json`:

```json
"telegram": { "token_file": "/var/lib/alloybot/telegram.token", "chat_id": "<your chat id>" }
```

Halts and repeated errors are sent there.

## Config reference

| Key | Default | Meaning |
| --- | --- | --- |
| `enabled` | true | false stops new loops (one in flight finishes) |
| `target_inj_pct` | 50 | USDC.inj share of pool 3497 to hold at or above |
| `loop_usdc` | 100 | allUSDC per loop |
| `min_loop_usdc` | 10 | no loop below this, for either the idle balance or the remaining shortfall |
| `reserve_usdc` | 3 | allUSDC kept back for Osmosis fees and gas refills |
| `max_loops_per_day` | 100 | UTC day |
| `max_loop_loss_bps` | 10 | allUSDC back vs out per loop; more halts |
| `max_fee_usdc_per_day` | 5 | loop losses + gas refills + Osmosis fees; reaching it pauses until 00:00 UTC |
| `gas_floor` | avax 0.005, inj 0.001 | refill below these |
| `max_gas_refills_per_day` | 4 | needing more halts |
| `gas_refill_usdc` | avax 2, inj 1 | allUSDC spent per refill (at most 10) |
| `gas_min_value_pct` | 80 | a refill quote must deliver at least this % of its cost in gas, otherwise it waits |
| `avax_max_fee_gwei` | 50 | above this the A2 send waits instead of paying |
| `osmo_fee_margin` | 2 | Osmosis fee over the base fee, at the fee pool's spot price |
| `rate_limit_margin_pct` | 1 | headroom kept below the IBC rate limits |
| `stranded_threshold_usdc` | 1 | funds outside the alloy above this, with no loop in flight, halt |

## Files

| File | What it is |
| --- | --- |
| `bot.mjs` | commands, decision loop, config, journal |
| `cycle.mjs` | the resumable loop runner (resume, retry and halt rules) |
| `stages.mjs` | A1, A2, A3 |
| `chain.mjs` | pool reads, IBC rate-limit headroom, balances, gas refill |
| `sign.mjs` | key derivation, Cosmos sign-direct (secp256k1 and Injective ethsecp256k1), EIP-1559 |
| `page.mjs`, `extract.mjs` | load constants, encoders, validators and network helpers from `../index.html` |
| `test.mjs` | signing against cosmjs and ethers reference output, decision math, runner rules |

Dependencies (bot only; the page stays dependency-free): `@noble/curves`, `@noble/hashes`, `@scure/bip32`,
`@scure/bip39`, pinned exactly. Node has no keccak-256 or ECDSA recovery, and hand-written signing code has no
place on a hot wallet.
