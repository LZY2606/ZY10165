import {
  ENDPOINT_OFFSET_SECONDS,
  GAP_SECONDS,
  NS_PER_SEC,
  PHASE0_CYC,
  SPIN_F0_HZ,
  SPIN_F1_HZ_S,
  TRUE_DM,
} from '../constants.js';
import { dmDelaySeconds, secondsToNs } from '../phase.js';
import type { GapDef, SessionCode, ToaInput } from '../types.js';

export interface FixtureSpec {
  tRefNs: bigint;
  f0Nominal: number;
  f1True: number;
  dmTrue: number;
  phase0Cycles: number;
  gapS: number;
  endpointOffsetS: number;
  freqs: { session: SessionCode; ordinal: number; freqMhz: number; dtS: number }[];
}

/**
 * 固定夹具口径：
 * - 历元 tRef 为整数纳秒；f0=100 Hz（P=10 ms），f1=0，DM=100 pc cm^-3。
 * - 望次 A：tRef 处 1400/800/400 MHz 三个频段 + tRef+600 s 一个 1400 MHz 点，
 *   其中三个频段用于分离 DM，第二个历元用于约束频率斜率。
 * - 望次 B：跨过 2,592,000 s（30 天）空档后的 1400 MHz 单点。
 * - 望次 C：B 之后 1000 s 的末端 1400 MHz 点（仅 v2 包含）。
 * A/B 两个历元时，二次多项式可吸收任意整数周跳（两方案 rms 都≈0，并列）；
 * 加入 C 后出现第三个不同历元，周错方案残差升至约 1.2 us，两分支可区分。
 */
export const FIXTURE_SPEC: FixtureSpec = {
  tRefNs: 1_000_000_000_000_000_000n,
  f0Nominal: SPIN_F0_HZ,
  f1True: SPIN_F1_HZ_S,
  dmTrue: TRUE_DM,
  phase0Cycles: PHASE0_CYC,
  gapS: GAP_SECONDS,
  endpointOffsetS: ENDPOINT_OFFSET_SECONDS,
  freqs: [
    { session: 'A', ordinal: 0, freqMhz: 1400, dtS: 0 },
    { session: 'A', ordinal: 1, freqMhz: 800, dtS: 0 },
    { session: 'A', ordinal: 2, freqMhz: 400, dtS: 0 },
    { session: 'A', ordinal: 3, freqMhz: 1400, dtS: 600 },
    { session: 'B', ordinal: 0, freqMhz: 1400, dtS: GAP_SECONDS },
    { session: 'C', ordinal: 0, freqMhz: 1400, dtS: GAP_SECONDS + ENDPOINT_OFFSET_SECONDS },
  ],
};

export const GAPS: GapDef[] = [
  { index: 0, afterSession: 'A', beforeSession: 'B' },
  { index: 1, afterSession: 'B', beforeSession: 'C' },
];

export const VERSION_BASELINE = 'v1-baseline';
export const VERSION_WITH_ENDPOINT = 'v2-with-endpoint';

/**
 * 物理真值：望远镜在 tObs 记录到的整周 N 与包裹相位 w 满足
 *   N + w = phase0 + f0*(tObs - DMDelay(freq,DM) - tRef) + 0.5*f1*...^2
 * 生成后 N 以 bigint 固化（序列化为字符串），运行期不再由浮点取模反推大计数。
 */
export function generateToas(
  includeEndpoint: boolean,
): { toas: ToaInput[]; versionId: string } {
  const spec = FIXTURE_SPEC;
  const tRefS = Number(spec.tRefNs) / Number(NS_PER_SEC);
  const entries = spec.freqs.filter(
    (entry) => includeEndpoint || entry.session !== 'C',
  );

  const toas: ToaInput[] = entries.map((entry) => {
    const tObsNs = secondsToNs(tRefS + entry.dtS);
    const delayS = dmDelaySeconds(entry.freqMhz, spec.dmTrue);
    const baryS = entry.dtS - delayS;
    const phaseCycles =
      spec.phase0Cycles +
      spec.f0Nominal * baryS +
      0.5 * spec.f1True * baryS * baryS;
    const nCycles = BigInt(Math.floor(phaseCycles + 1e-12));
    const wrapped = phaseCycles - Number(nCycles);
    return {
      code: `${entry.session}${entry.ordinal + 1}-${entry.freqMhz}`,
      session: entry.session,
      ordinal: entry.ordinal,
      tNs: tObsNs,
      freqMhz: entry.freqMhz,
      nCycles,
      wrapped: Number(wrapped.toFixed(12)),
      sigmaS: 1e-6,
      versionId: includeEndpoint ? VERSION_WITH_ENDPOINT : VERSION_BASELINE,
    };
  });

  return {
    toas,
    versionId: includeEndpoint ? VERSION_WITH_ENDPOINT : VERSION_BASELINE,
  };
}
