# Deploying SpotkickRoyale (Monad)

Chain ids: testnet **10143**, mainnet **143** (verify at docs.monad.xyz before use). Nothing below has been broadcast.
Verify the Pyth Entropy address per chain at docs.pyth.network/entropy/contract-addresses (testnet: `0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320`).

```sh
./install-deps.sh                      # once: forge-std, OpenZeppelin v5.7.0, Pyth entropy SDK into lib/
export MONAD_TESTNET_RPC=...           # and MONAD_RPC for mainnet
export ENTROPY_ADDRESS=0x36825bf3Fbdf5a29E2d5148bfe7Dcf7B5639e320
export OWNER=<Safe address>            # optional; handed over with Ownable2Step (OWNER must acceptOwnership on royale, adapter, rain)
export TIERS_WEI=3000000000000000000,5000000000000000000,10000000000000000000,25000000000000000000   # default
# optional: ENTROPY_PROVIDER, ENTROPY_CALLBACK_GAS (150000), RAIN_MIN_WAGER (10 ether), ENTROPY_FUND_WEI
```

## 1. Dry run (simulation only, no transaction sent)
```sh
forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC
```

## 2. Testnet broadcast (review the dry run first)
```sh
forge script script/Deploy.s.sol --rpc-url $MONAD_TESTNET_RPC --broadcast --account <keystore-name>
```
(or `--private-key $DEPLOYER_KEY`). Writes `deployments/10143.json` (royale, sessions, rain, pythAdapter, owner, `placeholderSaveTable`).

## 3. Mainnet (after testnet soak, audit, and a real save table)
```sh
forge script script/Deploy.s.sol --rpc-url $MONAD_RPC --broadcast --account <keystore-name>
```

## 4. After deploy
- Save table: loaded from `../packages/shared/save-table.json` (array of 48 bps, or `{saveBps:[...]}`); if absent the script deploys a flat 3500 bps **PLACEHOLDER** and says so. Replace with `setSaveTable` (owner) before real money.
- Fund entropy: `royale.fundEntropy{value: ...}()` (owner). Entropy is paid from accrued treasury; the smallest tier must cover roughly 1 MON of entropy per game.
- Owner accepts ownership (Safe tx) on royale, adapter and rain.
- Check `adapter.fee()` and run one full 3-player game on testnet; record the seed delay.

## Local (anvil, MockRandomness)
```sh
anvil &
forge script script/DeployLocal.s.sol --rpc-url http://127.0.0.1:8545 --broadcast \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
```
Never use `DeployLocal` on a public network (anyone can fulfil the mock with any seed).
