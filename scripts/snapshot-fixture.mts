import { writeFileSync } from 'node:fs';
import { generateToas, FIXTURE_SPEC, GAPS } from '../src/core/fixtures/gen.ts';

const serialize = (includeEndpoint: boolean) => {
  const { toas, versionId } = generateToas(includeEndpoint);
  return {
    versionId,
    label: includeEndpoint ? '含末端望次 C（可区分）' : '回退末端望次 C（两方案并列）',
    toas: toas.map((t) => ({
      code: t.code,
      session: t.session,
      ordinal: t.ordinal,
      tNs: t.tNs.toString(),
      freqMhz: t.freqMhz,
      nCycles: t.nCycles.toString(),
      wrapped: t.wrapped,
      sigmaS: t.sigmaS,
      versionId: t.versionId,
    })),
  };
};

const snapshot = {
  format: 'pulse-clock-visa-fixture',
  fixtureVersion: 1,
  spec: {
    tRefNs: FIXTURE_SPEC.tRefNs.toString(),
    f0NominalHz: FIXTURE_SPEC.f0Nominal,
    f1TrueHzS: FIXTURE_SPEC.f1True,
    dmTrue: FIXTURE_SPEC.dmTrue,
    phase0Cycles: FIXTURE_SPEC.phase0Cycles,
    gapS: FIXTURE_SPEC.gapS,
    endpointOffsetS: FIXTURE_SPEC.endpointOffsetS,
  },
  gaps: GAPS,
  versions: [serialize(false), serialize(true)],
};

writeFileSync(
  new URL('../src/core/fixtures/fixture.json', import.meta.url),
  JSON.stringify(snapshot, null, 2) + '\n',
);
console.log('fixture snapshot written:', snapshot.versions.map((v) => `${v.versionId}(${v.toas.length})`).join(', '));
