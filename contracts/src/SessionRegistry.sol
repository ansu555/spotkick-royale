// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ISessionRegistry} from "./ISpotkickRoyale.sol";

/// @notice A wallet authorises a short-lived session key that may only call pickFor/cashOutFor on its behalf.
/// Funds are always paid to the player, never to the session key.
contract SessionRegistry is ISessionRegistry {
    /// @dev player => key => expiry (unix seconds). 0 = not authorised.
    mapping(address => mapping(address => uint64)) private _expiry;

    error ZeroKey();
    error ExpiryInPast();
    error ExpiryTooFar();

    /// @notice Hard cap on a session's lifetime.
    uint64 public constant MAX_SESSION_SECS = 7 days;

    function authorize(address key, uint64 expiry) external {
        if (key == address(0) || key == msg.sender) revert ZeroKey();
        if (expiry <= block.timestamp) revert ExpiryInPast();
        if (expiry > block.timestamp + MAX_SESSION_SECS) revert ExpiryTooFar();
        _expiry[msg.sender][key] = expiry;
        emit SessionAuthorized(msg.sender, key, expiry);
    }

    function revoke(address key) external {
        delete _expiry[msg.sender][key];
        emit SessionRevoked(msg.sender, key);
    }

    function isAuthorized(address player, address key) external view returns (bool) {
        return _expiry[player][key] > block.timestamp;
    }
}
