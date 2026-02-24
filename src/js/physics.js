/**
 * BankShotAI - Bank Shot Physics Engine
 *
 * Calculates direct and bank shot paths using reflection geometry.
 * Simplified model: angle of incidence = angle of reflection (no spin/english).
 * All coordinates in millimeters, origin at bottom-left corner pocket.
 */

import {
  TABLE_WIDTH, TABLE_LENGTH, BALL_RADIUS,
  POCKETS, RAIL_LEFT, RAIL_RIGHT, RAIL_BOTTOM, RAIL_TOP
} from './table-config.js?v=1771960650';

const RAIL = { LEFT: 'left', RIGHT: 'right', BOTTOM: 'bottom', TOP: 'top' };
const ALL_RAILS = [RAIL.LEFT, RAIL.RIGHT, RAIL.BOTTOM, RAIL.TOP];

export const DIFFICULTY = { EASY: 'easy', MEDIUM: 'medium', HARD: 'hard', VERY_HARD: 'very_hard' };

function hypot(dx, dy) { return Math.sqrt(dx * dx + dy * dy); }

/**
 * @typedef {Object} ShotPath
 * @property {number[]} cuePos
 * @property {number[]} objectPos
 * @property {number[]} targetPocket
 * @property {number[]} aimPoint
 * @property {number[][]} bankPoints
 * @property {string[]} railsUsed
 * @property {number} totalDistance
 * @property {string} difficulty
 * @property {number} difficultyScore
 * @property {Array<[number[], number[]]>} pathSegments
 */

export class BankShotCalculator {
  constructor(tableWidth = TABLE_WIDTH, tableLength = TABLE_LENGTH) {
    this.width = tableWidth;
    this.length = tableLength;
    this.pockets = POCKETS;
    this.diag = hypot(this.width, this.length);
  }

  /**
   * Find all viable shots from cue ball through object ball into pockets.
   * @param {number[]} cuePos
   * @param {number[]} objectPos
   * @param {string|null} targetPocket - specific pocket name or null for all
   * @param {number} maxBanks - 0=direct only, 1=single, 2=double
   * @returns {ShotPath[]}
   */
  findAllShots(cuePos, objectPos, targetPocket = null, maxBanks = 2) {
    const shots = [];
    const pockets = targetPocket
      ? { [targetPocket]: this.pockets[targetPocket] }
      : this.pockets;

    for (const [name, pocketPos] of Object.entries(pockets)) {
      // Direct shot
      const direct = this._calcDirect(cuePos, objectPos, pocketPos);
      if (direct) shots.push(direct);

      // Single bank shots
      if (maxBanks >= 1) {
        for (const rail of ALL_RAILS) {
          const shot = this._calcSingleBank(cuePos, objectPos, pocketPos, rail);
          if (shot) shots.push(shot);
        }
      }

      // Double bank shots
      if (maxBanks >= 2) {
        for (const rail1 of ALL_RAILS) {
          for (const rail2 of ALL_RAILS) {
            if (rail1 === rail2) continue;
            const shot = this._calcDoubleBank(cuePos, objectPos, pocketPos, rail1, rail2);
            if (shot) shots.push(shot);
          }
        }
      }
    }

    shots.sort((a, b) => a.difficultyScore - b.difficultyScore);
    return shots;
  }

  _ghostBallPoint(objectPos, direction) {
    const [dx, dy] = direction;
    const norm = hypot(dx, dy);
    if (norm < 1e-9) return [...objectPos];
    const ux = dx / norm, uy = dy / norm;
    return [objectPos[0] - ux * BALL_RADIUS * 2, objectPos[1] - uy * BALL_RADIUS * 2];
  }

  _calcDirect(cuePos, objectPos, pocketPos) {
    const dx = pocketPos[0] - objectPos[0];
    const dy = pocketPos[1] - objectPos[1];
    const dist = hypot(dx, dy);
    if (dist < 1e-6) return null;

    const direction = [dx / dist, dy / dist];
    const aim = this._ghostBallPoint(objectPos, direction);
    if (!this._onTable(aim)) return null;

    const cueDist = hypot(aim[0] - cuePos[0], aim[1] - cuePos[1]);
    const totalDist = cueDist + dist;
    const score = this._rateDifficulty(cueDist, dist, 0);

    return {
      cuePos, objectPos, targetPocket: pocketPos,
      aimPoint: aim, bankPoints: [], railsUsed: [],
      totalDistance: totalDist,
      difficulty: this._scoreToDifficulty(score),
      difficultyScore: score,
      pathSegments: [[cuePos, aim], [objectPos, pocketPos]],
    };
  }

  _calcSingleBank(cuePos, objectPos, pocketPos, rail) {
    const mirror = this._reflectPoint(pocketPos, rail);
    if (!mirror) return null;

    const bankPoint = this._lineRailIntersection(objectPos, mirror, rail);
    if (!bankPoint || !this._onRail(bankPoint, rail)) return null;

    const dx = bankPoint[0] - objectPos[0];
    const dy = bankPoint[1] - objectPos[1];
    const dist1 = hypot(dx, dy);
    if (dist1 < 1e-6) return null;

    const direction = [dx / dist1, dy / dist1];
    const aim = this._ghostBallPoint(objectPos, direction);
    if (!this._onTable(aim)) return null;

    const dist2 = hypot(pocketPos[0] - bankPoint[0], pocketPos[1] - bankPoint[1]);
    const cueDist = hypot(aim[0] - cuePos[0], aim[1] - cuePos[1]);
    const totalDist = cueDist + dist1 + dist2;
    const score = this._rateDifficulty(cueDist, dist1 + dist2, 1);

    return {
      cuePos, objectPos, targetPocket: pocketPos,
      aimPoint: aim, bankPoints: [bankPoint], railsUsed: [rail],
      totalDistance: totalDist,
      difficulty: this._scoreToDifficulty(score),
      difficultyScore: score,
      pathSegments: [[cuePos, aim], [objectPos, bankPoint], [bankPoint, pocketPos]],
    };
  }

  _calcDoubleBank(cuePos, objectPos, pocketPos, rail1, rail2) {
    const mirror1 = this._reflectPoint(pocketPos, rail2);
    if (!mirror1) return null;
    const mirror2 = this._reflectPoint(mirror1, rail1);
    if (!mirror2) return null;

    const bank1 = this._lineRailIntersection(objectPos, mirror2, rail1);
    if (!bank1 || !this._onRail(bank1, rail1)) return null;

    const bank2 = this._lineRailIntersection(bank1, mirror1, rail2);
    if (!bank2 || !this._onRail(bank2, rail2)) return null;

    const dx = bank1[0] - objectPos[0];
    const dy = bank1[1] - objectPos[1];
    const distOb = hypot(dx, dy);
    if (distOb < 1e-6) return null;

    const direction = [dx / distOb, dy / distOb];
    const aim = this._ghostBallPoint(objectPos, direction);
    if (!this._onTable(aim)) return null;

    const distB1B2 = hypot(bank2[0] - bank1[0], bank2[1] - bank1[1]);
    const distB2P = hypot(pocketPos[0] - bank2[0], pocketPos[1] - bank2[1]);
    const cueDist = hypot(aim[0] - cuePos[0], aim[1] - cuePos[1]);
    const totalDist = cueDist + distOb + distB1B2 + distB2P;
    const score = this._rateDifficulty(cueDist, distOb + distB1B2 + distB2P, 2);

    return {
      cuePos, objectPos, targetPocket: pocketPos,
      aimPoint: aim, bankPoints: [bank1, bank2], railsUsed: [rail1, rail2],
      totalDistance: totalDist,
      difficulty: this._scoreToDifficulty(score),
      difficultyScore: score,
      pathSegments: [[cuePos, aim], [objectPos, bank1], [bank1, bank2], [bank2, pocketPos]],
    };
  }

  _reflectPoint(point, rail) {
    const [x, y] = point;
    switch (rail) {
      case RAIL.LEFT:   return [-x, y];
      case RAIL.RIGHT:  return [2 * this.width - x, y];
      case RAIL.BOTTOM: return [x, -y];
      case RAIL.TOP:    return [x, 2 * this.length - y];
    }
    return null;
  }

  _lineRailIntersection(p1, p2, rail) {
    const [x1, y1] = p1;
    const dx = p2[0] - x1, dy = p2[1] - y1;
    let t;

    switch (rail) {
      case RAIL.LEFT:
        if (Math.abs(dx) < 1e-9) return null;
        t = (RAIL_LEFT - x1) / dx; break;
      case RAIL.RIGHT:
        if (Math.abs(dx) < 1e-9) return null;
        t = (RAIL_RIGHT - x1) / dx; break;
      case RAIL.BOTTOM:
        if (Math.abs(dy) < 1e-9) return null;
        t = (RAIL_BOTTOM - y1) / dy; break;
      case RAIL.TOP:
        if (Math.abs(dy) < 1e-9) return null;
        t = (RAIL_TOP - y1) / dy; break;
      default: return null;
    }

    if (t < 0) return null;
    return [x1 + t * dx, y1 + t * dy];
  }

  _onTable(point) {
    const [x, y] = point;
    const m = BALL_RADIUS;
    return x >= RAIL_LEFT - m && x <= RAIL_RIGHT + m &&
           y >= RAIL_BOTTOM - m && y <= RAIL_TOP + m;
  }

  _onRail(point, rail, margin = 50.0) {
    const [x, y] = point;
    if (rail === RAIL.LEFT || rail === RAIL.RIGHT) {
      return y >= -margin && y <= this.length + margin;
    }
    return x >= -margin && x <= this.width + margin;
  }

  _rateDifficulty(cueDist, obDist, numBanks) {
    const distFactor = (cueDist + obDist) / (2 * this.diag);
    const bankPenalty = numBanks * 0.25;
    return Math.min(1.0, distFactor * 0.5 + bankPenalty);
  }

  _scoreToDifficulty(score) {
    if (score < 0.25) return DIFFICULTY.EASY;
    if (score < 0.5) return DIFFICULTY.MEDIUM;
    if (score < 0.75) return DIFFICULTY.HARD;
    return DIFFICULTY.VERY_HARD;
  }
}
