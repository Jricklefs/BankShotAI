/**
 * Standard pool table dimensions and constants.
 * All measurements in millimeters.
 */

// 8-foot table playing surface
export const TABLE_WIDTH = 1118.0;   // 44 inches (short rail, x-axis)
export const TABLE_LENGTH = 2235.0;  // 88 inches (long rail, y-axis)

// Ball dimensions
export const BALL_DIAMETER = 57.15;  // 2.25 inches
export const BALL_RADIUS = BALL_DIAMETER / 2.0;

// Pocket dimensions
export const CORNER_POCKET_OPENING = 114.3;  // ~4.5 inches
export const SIDE_POCKET_OPENING = 127.0;    // ~5 inches

// Pocket positions: {name: [x, y]} — origin at bottom-left corner pocket
export const POCKETS = {
  bottom_left:  [0.0, 0.0],
  bottom_right: [TABLE_WIDTH, 0.0],
  side_left:    [0.0, TABLE_LENGTH / 2.0],
  side_right:   [TABLE_WIDTH, TABLE_LENGTH / 2.0],
  top_left:     [0.0, TABLE_LENGTH],
  top_right:    [TABLE_WIDTH, TABLE_LENGTH],
};

// Rail boundaries (inner edges)
export const RAIL_LEFT = 0.0;
export const RAIL_RIGHT = TABLE_WIDTH;
export const RAIL_BOTTOM = 0.0;
export const RAIL_TOP = TABLE_LENGTH;

// Ball colors with HSV ranges and web-friendly hex/rgb
export const BALL_COLORS = {
  white:  { number: 0,  hsvLow: [0, 0, 200],     hsvHigh: [180, 40, 255],   hex: '#ffffff', rgb: [255, 255, 255] },
  yellow: { number: 1,  hsvLow: [20, 100, 100],   hsvHigh: [35, 255, 255],   hex: '#ffd700', rgb: [255, 215, 0] },
  blue:   { number: 2,  hsvLow: [100, 100, 50],   hsvHigh: [130, 255, 255],  hex: '#0000c8', rgb: [0, 0, 200] },
  red:    { number: 3,  hsvLow: [0, 100, 100],    hsvHigh: [10, 255, 255],   hex: '#c80000', rgb: [200, 0, 0] },
  purple: { number: 4,  hsvLow: [130, 50, 50],    hsvHigh: [160, 255, 255],  hex: '#800080', rgb: [128, 0, 128] },
  orange: { number: 5,  hsvLow: [10, 100, 100],   hsvHigh: [20, 255, 255],   hex: '#ff8c00', rgb: [255, 140, 0] },
  green:  { number: 6,  hsvLow: [35, 100, 50],    hsvHigh: [55, 255, 255],   hex: '#008000', rgb: [0, 128, 0] },
  maroon: { number: 7,  hsvLow: [0, 50, 30],      hsvHigh: [10, 200, 100],   hex: '#800000', rgb: [128, 0, 0] },
  black:  { number: 8,  hsvLow: [0, 0, 0],        hsvHigh: [180, 100, 50],   hex: '#000000', rgb: [0, 0, 0] },
};

// Synthetic ball rack for testing
export function createSyntheticBalls() {
  const balls = [];
  const rowSpacing = BALL_DIAMETER * 0.866; // sqrt(3)/2
  const footX = TABLE_WIDTH / 2;
  const footY = TABLE_LENGTH * 0.75;

  // Cue ball
  balls.push({ x: TABLE_WIDTH / 2, y: TABLE_LENGTH * 0.25, color: 'white', number: 0, isStriped: false });

  const rack = [
    [0, 0, 'yellow', 1, false],
    [-0.5, 1, 'blue', 2, false],
    [0.5, 1, 'orange', 13, true],
    [-1, 2, 'red', 3, false],
    [0, 2, 'black', 8, false],
    [1, 2, 'yellow', 9, true],
    [-1.5, 3, 'purple', 4, false],
    [-0.5, 3, 'blue', 10, true],
    [0.5, 3, 'maroon', 7, false],
    [1.5, 3, 'red', 11, true],
    [-2, 4, 'orange', 5, false],
    [-1, 4, 'green', 14, true],
    [0, 4, 'purple', 12, true],
    [1, 4, 'green', 6, false],
    [2, 4, 'maroon', 15, true],
  ];

  for (const [col, row, color, num, striped] of rack) {
    balls.push({
      x: footX + col * BALL_DIAMETER,
      y: footY + row * rowSpacing,
      color,
      number: num,
      isStriped: striped,
    });
  }

  return balls;
}
