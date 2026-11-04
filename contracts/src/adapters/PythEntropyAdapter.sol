// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IEntropyV2} from "@pythnetwork/entropy-sdk-solidity/IEntropyV2.sol";
import {IEntropyConsumer} from "@pythnetwork/entropy-sdk-solidity/IEntropyConsumer.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IRandomness} from "../ISpotkickRoyale.sol";

interface ISeedReceiver {
    function onSeed(uint64 requestId, bytes32 seed) external;
}

/// @notice IRandomness over Pyth Entropy v2 (requestV2 / getFeeV2). Only the bound royale may request.
/// The Entropy contract calls `_entropyCallback` -> `entropyCallback`, which only forwards to `royale.onSeed`.
/// Verify the Entropy address per chain at docs.pyth.network/entropy/contract-addresses.
contract PythEntropyAdapter is IRandomness, IEntropyConsumer, Ownable2Step {
    IEntropyV2 public immutable entropy;
    address public provider;
    uint32 public callbackGasLimit;
    address public royale;

    error NotRoyale();
    error RoyaleAlreadySet();
    error ZeroAddress();
    error WrongFee(uint256 sent, uint256 required);

    event RoyaleSet(address royale);
    event ProviderSet(address provider);
    event CallbackGasLimitSet(uint32 gasLimit);

    constructor(address entropy_, address owner_, uint32 callbackGasLimit_) Ownable(owner_) {
        if (entropy_ == address(0)) revert ZeroAddress();
        entropy = IEntropyV2(entropy_);
        provider = entropy.getDefaultProvider();
        callbackGasLimit = callbackGasLimit_;
    }

    /// @notice One-time binding (royale and adapter reference each other, so deploy adapter first).
    function setRoyale(address royale_) external onlyOwner {
        if (royale != address(0)) revert RoyaleAlreadySet();
        if (royale_ == address(0)) revert ZeroAddress();
        royale = royale_;
        emit RoyaleSet(royale_);
    }

    function setProvider(address provider_) external onlyOwner {
        if (provider_ == address(0)) revert ZeroAddress();
        provider = provider_;
        emit ProviderSet(provider_);
    }

    /// @notice Callback gas handed to Entropy (rounded up to 10k by Entropy). The royale callback only stores a seed.
    function setCallbackGasLimit(uint32 gasLimit) external onlyOwner {
        callbackGasLimit = gasLimit;
        emit CallbackGasLimitSet(gasLimit);
    }

    function fee() public view returns (uint256) {
        return entropy.getFeeV2(provider, callbackGasLimit);
    }

    function requestSeed(bytes32 userRandomness) external payable returns (uint64 requestId) {
        if (msg.sender != royale) revert NotRoyale();
        uint256 required = fee();
        // Entropy does not refund excess, so insist on the exact fee.
        if (msg.value != required) revert WrongFee(msg.value, required);
        requestId = entropy.requestV2{value: required}(provider, userRandomness, callbackGasLimit);
    }

    function getEntropy() internal view override returns (address) {
        return address(entropy);
    }

    function entropyCallback(uint64 sequence, address, bytes32 randomNumber) internal override {
        ISeedReceiver(royale).onSeed(sequence, randomNumber);
    }
}
