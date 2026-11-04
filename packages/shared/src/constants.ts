// Mirrors contracts Config / docs/INTERFACES.md section 1.
// Units note: goal positions are integer millimetres. x in [-3500, 3500]
// (0 = goal centre), y in [140, 2300] (0 = ground).

export const MAX_SEATS = 10;
export const MIN_PLAYERS = 3;
export const LOBBY_COUNTDOWN_SECS = 15;
export const PICK_SECS = 7;
export const BETWEEN_SECS = 9;
export const REPICK_CAP = 5;
export const FEE_BPS = 400;
export const STALL_TIMEOUT_SECS = 600;
export const ENTROPY_TIMEOUT_SECS = 120;

export const GOAL_W_MM = 7320;
export const GOAL_H_MM = 2440;

// Picks are valid inside x ∈ [-PICK_X_MAX, PICK_X_MAX], y ∈ [PICK_Y_MIN, PICK_Y_MAX].
export const PICK_X_MAX = 3500;
export const PICK_X_MIN = -PICK_X_MAX;
export const PICK_Y_MIN = 140;
export const PICK_Y_MAX = 2300;

// Target (strike/save point) is clamped to x ∈ [-TARGET_X_MAX, TARGET_X_MAX],
// y ∈ [TARGET_Y_MIN, TARGET_Y_MAX].
export const TARGET_X_MAX = 3300;
export const TARGET_X_MIN = -TARGET_X_MAX;
export const TARGET_Y_MIN = 250;
export const TARGET_Y_MAX = 2150;

// Nominal blast radius (mm) used by the 25–75% survivorship fit.
export const BLAST_R_MM = 1500;

// saveBps grid: row 0 = top of the goal, 12 columns left → right, 48 cells total.
export const SAVE_GRID_COLS = 12;
export const SAVE_GRID_ROWS = 4;
export const SAVE_GRID = SAVE_GRID_COLS * SAVE_GRID_ROWS;