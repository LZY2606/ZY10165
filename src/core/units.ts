/**
 * 精确整数计量口径。
 *
 * 所有时刻以「参考历元 T0（MJD 59000.0）起的整数微秒」表示，记为 tUs。
 * 频率、频率导数、色散量均以放大整数存储，相位以 PHASE_DEN 为分母的
 * 有理数分子计算，整周编号一律用 BigInt 向下取整除法得到，
 * 绝不通过浮点取模推断大计数。
 */

export const US_PER_S = 1_000_000n;
export const DAY_US = 86_400_000_000n;

/** fNum = f[Hz] * F_SCALE（皮赫兹） */
export const F_SCALE = 1_000_000_000_000n;
/** dNum = fdot[Hz/s] * D_SCALE */
export const D_SCALE = 1_000_000_000_000_000_000_000_000n; // 1e24
/** dmNum = DM[pc/cm^3] * DM_SCALE */
export const DM_SCALE = 1_000_000n;

/**
 * 相位分母：phase = phaseNum / PHASE_DEN（周）。
 * 取 2e36 使 f 项与 1/2·fdot 项都为整数分子：
 *   f·dt   = fNum·dtUs / 1e18            -> 分子乘 2e18
 *   ½fdot·dt² = dNum·dtUs² / 2e36        -> 分子即 dNum·dtUs²
 */
export const PHASE_DEN = 2_000_000_000_000_000_000_000_000_000_000_000_000n; // 2e36
export const TERM1_COEF = 2_000_000_000_000_000_000n; // 2e18

/** 色散常数 K = 4.148808e9 µs·MHz²·(pc/cm³)^-1（整数口径） */
export const K_DM_US = 4_148_808_000n;

/** b > 0 的向下取整除法（对负数也正确） */
export function floorDiv(a: bigint, b: bigint): bigint {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
}

/** 四舍五入到最近整数（半值向 +∞），b > 0 */
export function roundDiv(a: bigint, b: bigint): bigint {
  const q = floorDiv(a, b);
  const r = a - q * b; // 0 <= r < b
  if (r * 2n >= b) return q + 1n;
  return q;
}

/** 相位分子：f·dt + ½·fdot·dt²，以 PHASE_DEN 为分母 */
export function phaseNum(fNum: bigint, dNum: bigint, dtUs: bigint): bigint {
  return fNum * dtUs * TERM1_COEF + dNum * dtUs * dtUs;
}

/** 整周数 floor(phase)，精确整数 */
export function cycleOf(fNum: bigint, dNum: bigint, dtUs: bigint): bigint {
  return floorDiv(phaseNum(fNum, dNum, dtUs), PHASE_DEN);
}

/** 包裹相位 frac(phase) ∈ [0,1)，仅用于展示 */
export function wrappedPhase(fNum: bigint, dNum: bigint, dtUs: bigint): number {
  const num = phaseNum(fNum, dNum, dtUs);
  const c = floorDiv(num, PHASE_DEN);
  const rem = num - c * PHASE_DEN; // 0 <= rem < PHASE_DEN
  return Number(rem) / Number(PHASE_DEN);
}

/**
 * 色散时延（相对无穷大频率），返回整数微秒。
 * delay_us = K · DM · (1/f_MHz²)，f_MHz = fNum / 1e18
 */
export function dmDelayUs(dmNum: bigint, fNum: bigint): bigint {
  if (dmNum === 0n) return 0n;
  const num = K_DM_US * dmNum * 1_000_000_000_000_000_000_000_000_000_000_000_000n; // 1e36
  const den = DM_SCALE * fNum * fNum;
  return floorDiv(num, den);
}
