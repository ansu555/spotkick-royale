// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @notice Constants mirrored from docs/INTERFACES.md section 1. Keep in sync with packages/shared/src/constants.ts.
library Config {
    uint8 internal constant MAX_SEATS = 10;
    uint8 internal constant MIN_PLAYERS = 1; // default; owner-configurable via setMinPlayers
    uint64 internal constant LOBBY_COUNTDOWN_SECS = 15;
    uint64 internal constant PICK_SECS = 7;
    uint64 internal constant BETWEEN_SECS = 9;
    uint8 internal constant REPICK_CAP = 5;
    uint256 internal constant FEE_BPS = 400;
    uint64 internal constant STALL_TIMEOUT_SECS = 600;
    uint64 internal constant ENTROPY_TIMEOUT_SECS = 120;

    int256 internal constant GOAL_W_MM = 7320;
    int256 internal constant GOAL_H_MM = 2440;
    int256 internal constant PICK_X_MAX = 3500;
    int256 internal constant PICK_Y_MIN = 140;
    int256 internal constant PICK_Y_MAX = 2300;
    int256 internal constant TARGET_X_MAX = 3300;
    int256 internal constant TARGET_Y_MIN = 250;
    int256 internal constant TARGET_Y_MAX = 2150;
    uint256 internal constant BLAST_R_MM = 1500;

    uint256 internal constant SAVE_COLS = 12;
    uint256 internal constant SAVE_ROWS = 4;
    uint256 internal constant SAVE_CELLS = 48;
}
