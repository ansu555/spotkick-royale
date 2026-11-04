// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IRandomness} from "../../src/ISpotkickRoyale.sol";

interface IOnSeed {
    function onSeed(uint64 requestId, bytes32 seed) external;
}

/// @notice Test randomness: requests are recorded; the test (or handler) fulfils them explicitly.
contract MockRandomness is IRandomness {
    uint256 public feeWei = 0.01 ether;
    uint64 public nextId = 1;
    address public royale;
    mapping(uint64 => bytes32) public userRand;
    mapping(uint64 => bool) public fulfilled;
    uint64 public lastId;

    function setRoyale(address r) external {
        royale = r;
    }

    function setFee(uint256 f) external {
        feeWei = f;
    }

    function fee() external view returns (uint256) {
        return feeWei;
    }

    function requestSeed(bytes32 userRandomness) external payable returns (uint64 id) {
        require(msg.sender == royale, "not royale");
        require(msg.value == feeWei, "fee");
        id = nextId++;
        userRand[id] = userRandomness;
        lastId = id;
    }

    function fulfill(uint64 id, bytes32 seed) external {
        fulfilled[id] = true;
        IOnSeed(royale).onSeed(id, seed);
    }

    /// @dev deterministic seed from the recorded user randomness (for fuzz/invariant runs)
    function fulfillDefault(uint64 id) external {
        fulfilled[id] = true;
        IOnSeed(royale).onSeed(id, keccak256(abi.encode("seed", userRand[id], id)));
    }
}
