# Gas — SpotkickRoyale / Rain / SessionRegistry (Monad)

Monad charges the gas **limit**, not the gas used, so every external call should set a tight explicit limit:
`limit = worst-case measured gas × 1.30`, rounded up. A 30% margin covers cold SLOAD variance and the
caller-side overhead (EIP-1559 + `eth_call`/`eth_sendTransaction` framing) the report below does not include.

Measured with `forge test --gas-report` — Solc `0.8.28`, optimizer on (`optimizer_runs = 200`), EVM `prague`.
"Max" is the worst single call observed across the whole suite; `resolveRound`'s max is a full **10-alive-seat**
resolve (auto-picks + target + blast sort). `enter`/`setTier` maxima include the side path where they open a
new lobby or auto-start a full game.

## SpotkickRoyale — external functions

| Function | Min | Median | **Max** | Recommended limit (×1.30) |
|---|---|---|---|---|
| `enter` | 21,480 | 116,401 | 176,464 | **230,000** |
| `leaveLobby` | 24,693 | 67,162 | 67,162 | **90,000** |
| `pick` | 24,935 | 36,240 | 53,700 | **70,000** |
| `pickFor` | 28,046 | 32,261 | 59,228 | **80,000** |
| `cashOut` | 24,773 | 37,587 | 61,730 | **85,000** |
| `cashOutFor` | 27,895 | 42,188 | 56,481 | **75,000** |
| `withdraw` | 23,842 | 23,842 | 23,842 | **35,000** |
| `startGame` | 23,808 | 96,083 | 96,083 | **125,000** |
| `lockPicks` | 24,760 | 132,042 | 136,592 | **180,000** |
| `resolveRound` (10 alive) | 24,761 | 125,269 | **149,248** | **200,000** |
| `advance` | 24,403 | 35,245 | 40,845 | **55,000** |
| `refundStalled` | 24,870 | 27,281 | 130,889 | **170,000** |
| `setTier` (may open lobby) | 24,032 | 123,300 | 123,312 | **165,000** |
| `fundEntropy` | 23,541 | 47,375 | 47,375 | **65,000** |
| `setSaveTable` | 36,520 | 39,400 | 63,786 | **85,000** |
| `setMinPlayers` | 23,848 | 23,885 | 29,980 | **40,000** |
| `pause` / `unpause` | 23,499 | 29,757 | 29,757 | **40,000** |
| `withdrawTreasury` | 23,957 | 26,801 | 65,922 | **90,000** |
| `transferOwnership` | 30,797 | 30,797 | 30,797 | **40,000** |
| `acceptOwnership` | 33,154 | 33,154 | 33,154 | **45,000** |
| `onSeed` | 22,790 | 22,790 | 22,790 | **35,000** |

## Rain — external functions

| Function | Min | Median | **Max** | Recommended limit (×1.30) |
|---|---|---|---|---|
| `openRain` | 21,567 | 99,615 | 99,615 | **130,000** |
| `fund` | 23,768 | 40,777 | 55,655 | **75,000** |
| `join` | 23,791 | 59,474 | 59,474 | **80,000** |
| `settle` | 23,881 | 50,262 | 50,262 | **70,000** |
| `claim` | 24,120 | 42,934 | 42,934 | **60,000** |
| `reclaim` | 28,552 | 34,628 | 40,678 | **55,000** |
| `setMinWager` | 29,899 | 29,899 | 29,899 | **40,000** |
| `transferOwnership` / `acceptOwnership` | — | — | — | **45,000** |

## SessionRegistry — external functions

| Function | Min | Median | **Max** | Recommended limit (×1.30) |
|---|---|---|---|---|
| `authorize` | 21,834 | 37,761 | 46,323 | **65,000** |
| `revoke` | 28,449 | 28,449 | 28,449 | **40,000** |

`isAuthorized`/views are read-only (`eth_call`) and need no gas limit.

## Notes

- The driver's most expensive single call is `resolveRound` at 10 alive seats → **200,000** is the ceiling for
  the whole protocol. A one-size-fits-all driver limit of **230,000** (covering `enter`'s worst case) is safe.
- `cashOut`/`leaveLobby`/`resolveRound`/`refundStalled` forward every payout through an internal **30,000 gas**
  push (`_pay`); on failure the amount is credited to `claimable` (pull). A contract wallet that makes the push
  fail only delays its own payout — verified by `test/Reentrancy.t.sol` and the invariant handler.
- Gas on Monad testnet may meter differently from these Prague-EVM values; re-measure `resolveRound` and
  `enter` after any change to `RoyaleMath`/`KeeperModel` and before mainnet, then recompute limits.