import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { GAPS, FIXTURE_SPEC, type FixtureSpec } from './gen.js';
import type { FixtureBundle } from '../store.js';
import type { ToaInput } from '../types.js';

interface SnapshotToa {
  code: string;
  session: ToaInput['session'];
  ordinal: number;
  tNs: string;
  freqMhz: number;
  nCycles: string;
  wrapped: number;
  sigmaS: number;
  versionId: string;
}

interface Snapshot {
  format: string;
  fixtureVersion: number;
  spec: {
    tRefNs: string;
    f0NominalHz: number;
    f1TrueHzS: number;
    dmTrue: number;
    phase0Cycles: number;
    gapS: number;
    endpointOffsetS: number;
  };
  versions: { versionId: string; label: string; toas: SnapshotToa[] }[];
}

export function loadFixtureBundle(
  snapshotPath: string | URL = fileURLToPath(new URL('./fixture.json', import.meta.url)),
): FixtureBundle & { spec: FixtureSpec; snapshot: Snapshot } {
  const raw = readFileSync(snapshotPath, 'utf8');
  const snapshot = JSON.parse(raw) as Snapshot;
  if (snapshot.format !== 'pulse-clock-visa-fixture') {
    throw new Error('fixture 快照格式不正确');
  }
  const spec: FixtureSpec = {
    ...FIXTURE_SPEC,
    tRefNs: BigInt(snapshot.spec.tRefNs),
    f0Nominal: snapshot.spec.f0NominalHz,
    f1True: snapshot.spec.f1TrueHzS,
    dmTrue: snapshot.spec.dmTrue,
    phase0Cycles: snapshot.spec.phase0Cycles,
    gapS: snapshot.spec.gapS,
    endpointOffsetS: snapshot.spec.endpointOffsetS,
  };
  const bundle: FixtureBundle = {
    versions: snapshot.versions.map((version) => ({
      versionId: version.versionId,
      label: version.label,
      toas: version.toas.map((toa) => ({
        code: toa.code,
        session: toa.session,
        ordinal: toa.ordinal,
        tNs: BigInt(toa.tNs),
        freqMhz: toa.freqMhz,
        nCycles: BigInt(toa.nCycles),
        wrapped: toa.wrapped,
        sigmaS: toa.sigmaS,
        versionId: toa.versionId,
      })),
    })),
    gaps: GAPS,
    spec,
  };
  return { ...bundle, spec, snapshot };
}
