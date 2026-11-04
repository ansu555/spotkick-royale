// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IRain, ISpotkickRoyale} from "./ISpotkickRoyale.sol";

/// @notice MON rain: anyone funds a pot, eligible players join until `endsAt`, `settle` freezes the joined count,
/// each joiner pulls `total / joined`. Eligibility = lifetime wagered on the royale >= the rain's `minWager`
/// (snapshotted at open so later owner changes cannot alter an open rain).
/// If nobody joined, each funder can `reclaim` exactly what they put in, so funds are never stuck.
/// Rounding dust (< joined wei) stays in the contract.
contract Rain is IRain, Ownable2Step, ReentrancyGuardTransient {
    struct RainData {
        address opener;
        uint64 endsAt;
        uint32 joined;
        uint128 total;
        uint128 minWager;
        bool settled;
    }

    uint64 public constant MIN_DURATION = 10;
    uint64 public constant MAX_DURATION = 7 days;

    ISpotkickRoyale public immutable royale;
    uint128 public minWager;
    uint64 public nextRainId = 1;

    mapping(uint64 => RainData) private _rains;
    mapping(uint64 => mapping(address => uint8)) private _state; // 0 none, 1 joined, 2 claimed
    mapping(uint64 => mapping(address => uint128)) private _funded;

    error NoValue();
    error BadDuration();
    error UnknownRain();
    error RainEnded();
    error RainNotEnded();
    error AlreadySettled();
    error NotSettled();
    error NotEligible(uint128 wagered, uint128 required);
    error AlreadyJoined();
    error NotJoined();
    error AlreadyClaimed();
    error NothingToReclaim();
    error TransferFailed();
    error ZeroAddress();

    event MinWagerSet(uint128 minWager);
    event RainReclaimed(uint64 indexed rainId, address indexed funder, uint128 amount);

    constructor(address owner_, ISpotkickRoyale royale_, uint128 minWager_) Ownable(owner_) {
        if (address(royale_) == address(0)) revert ZeroAddress();
        royale = royale_;
        minWager = minWager_;
        emit MinWagerSet(minWager_);
    }

    function setMinWager(uint128 v) external onlyOwner {
        minWager = v;
        emit MinWagerSet(v);
    }

    function openRain(uint64 durationSecs) external payable returns (uint64 rainId) {
        if (msg.value == 0) revert NoValue();
        if (durationSecs < MIN_DURATION || durationSecs > MAX_DURATION) revert BadDuration();
        rainId = nextRainId++;
        uint64 endsAt = uint64(block.timestamp) + durationSecs;
        _rains[rainId] = RainData(msg.sender, endsAt, 0, uint128(msg.value), minWager, false);
        _funded[rainId][msg.sender] = uint128(msg.value);
        emit RainOpened(rainId, endsAt, uint128(msg.value));
    }

    function fund(uint64 rainId) external payable {
        RainData storage r = _rains[rainId];
        if (r.opener == address(0)) revert UnknownRain();
        if (r.settled) revert AlreadySettled();
        if (msg.value == 0) revert NoValue();
        r.total += uint128(msg.value);
        _funded[rainId][msg.sender] += uint128(msg.value);
        emit RainFunded(rainId, uint128(msg.value), r.total);
    }

    function join(uint64 rainId) external {
        RainData storage r = _rains[rainId];
        if (r.opener == address(0)) revert UnknownRain();
        if (block.timestamp >= r.endsAt) revert RainEnded();
        if (_state[rainId][msg.sender] != 0) revert AlreadyJoined();
        uint128 w = royale.wagered(msg.sender);
        if (w < r.minWager) revert NotEligible(w, r.minWager);
        _state[rainId][msg.sender] = 1;
        uint32 j = r.joined + 1;
        r.joined = j;
        emit RainJoined(rainId, msg.sender, j);
    }

    function settle(uint64 rainId) external {
        RainData storage r = _rains[rainId];
        if (r.opener == address(0)) revert UnknownRain();
        if (block.timestamp < r.endsAt) revert RainNotEnded();
        if (r.settled) revert AlreadySettled();
        r.settled = true;
        emit RainSettled(rainId, r.total, r.joined);
    }

    function claim(uint64 rainId) external nonReentrant {
        RainData storage r = _rains[rainId];
        if (!r.settled) revert NotSettled();
        uint8 st = _state[rainId][msg.sender];
        if (st == 0) revert NotJoined();
        if (st == 2) revert AlreadyClaimed();
        _state[rainId][msg.sender] = 2;
        uint128 amount = r.total / r.joined;
        emit RainClaimed(rainId, msg.sender, amount);
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Only when nobody joined: each funder takes back their own contribution.
    function reclaim(uint64 rainId) external nonReentrant {
        RainData storage r = _rains[rainId];
        if (!r.settled) revert NotSettled();
        uint128 amt = _funded[rainId][msg.sender];
        if (r.joined != 0 || amt == 0) revert NothingToReclaim();
        _funded[rainId][msg.sender] = 0;
        emit RainReclaimed(rainId, msg.sender, amt);
        (bool ok,) = msg.sender.call{value: amt}("");
        if (!ok) revert TransferFailed();
    }

    // ---- views
    function getRain(uint64 rainId) external view returns (RainData memory) {
        return _rains[rainId];
    }

    function hasJoined(uint64 rainId, address player) external view returns (bool) {
        return _state[rainId][player] != 0;
    }

    function hasClaimed(uint64 rainId, address player) external view returns (bool) {
        return _state[rainId][player] == 2;
    }

    function funded(uint64 rainId, address funder) external view returns (uint128) {
        return _funded[rainId][funder];
    }
}
