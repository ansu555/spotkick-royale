#!/bin/sh
# Installs Solidity deps into contracts/lib (run from contracts/). lib/ is gitignored.
# Pyth's Solidity SDK is taken from npm (@pythnetwork/entropy-sdk-solidity@2.2.1); the GitHub mirror is not cloneable.
set -e
cd "$(dirname "$0")"
mkdir -p lib
[ -d lib/forge-std ] || git clone --depth 1 https://github.com/foundry-rs/forge-std lib/forge-std
[ -d lib/openzeppelin-contracts ] || git clone --depth 1 --branch v5.7.0 https://github.com/OpenZeppelin/openzeppelin-contracts lib/openzeppelin-contracts
if [ ! -d lib/entropy-sdk-solidity ]; then
  tmp=$(mktemp -d); (cd "$tmp" && npm pack @pythnetwork/entropy-sdk-solidity@2.2.1 >/dev/null && tar xzf *.tgz)
  mkdir -p lib/entropy-sdk-solidity && cp "$tmp"/package/*.sol lib/entropy-sdk-solidity/
fi
