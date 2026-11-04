// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Contract wallet used as a player in tests. Modes decide what its receive() does when paid.
contract MaliciousWallet {
    enum Mode { Accept, Reject, Burn, Reenter }

    Mode public mode;
    address public reenterTarget;
    bytes public reenterData;
    uint256 public reenterAttempts;
    uint256 public reenterSucceeded;

    function setMode(Mode m) external {
        mode = m;
    }

    function setReenter(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
        mode = Mode.Reenter;
    }

    function exec(address target, bytes calldata data, uint256 value) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target.call{value: value}(data);
    }

    receive() external payable {
        Mode m = mode;
        if (m == Mode.Reject) revert("no thanks");
        if (m == Mode.Burn) {
            while (true) {}
        }
        if (m == Mode.Reenter) {
            (bool ok,) = reenterTarget.call(reenterData);
            // counters are intentionally best-effort: under the 30k push cap the SSTOREs may OOG, which the
            // royale treats as a failed push (credited to claimable). Tests assert on totals, not on these.
            ++reenterAttempts;
            if (ok) ++reenterSucceeded;
        }
    }
}
