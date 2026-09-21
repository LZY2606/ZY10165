export type SessionCode = 'A' | 'B' | 'C';

export interface ToaInput {
  code: string;
  session: SessionCode;
  ordinal: number;
  tNs: bigint;
  freqMhz: number;
  nCycles: bigint;
  wrapped: number;
  sigmaS: number;
  versionId: string;
}

export interface ToaView extends ToaInput {
  active: boolean;
}

export interface GapDef {
  index: number;
  afterSession: SessionCode;
  beforeSession: SessionCode;
}

export interface ClockEvent {
  seq: number;
  branchId: string;
  atNs: bigint;
  jumpNs: bigint;
  label: string;
}

export interface FitParams {
  phi0S: number;
  f0Hz: number;
  f1HzS: number;
  dm: number;
}

export interface PointResidual {
  toaCode: string;
  session: SessionCode;
  tNs: string;
  freqMhz: number;
  nCyclesEffective: string;
  wrapped: number;
  excluded: boolean;
  residualS: number;
  clockAppliedNs: string;
}

export interface FitSummary {
  params: FitParams;
  rmsS: number;
  chi2: number;
  maxAbsS: number;
  dof: number;
  points: PointResidual[];
  inputHash: string;
  fittedAt: string;
}

export interface BranchRecord {
  id: string;
  label: string;
  baseVersion: string;
  parentId: string | null;
  gapOffsets: Record<string, number>;
  excluded: string[];
  clockEvents: ClockEvent[];
  note: string;
  createdAt: string;
  fit: FitSummary | null;
  underidentifiedWith: string[];
  inputHash: string;
}

export interface DatasetVersionRecord {
  id: string;
  label: string;
  note: string;
  toas: ToaView[];
}

export interface OperationRecord {
  seq: number;
  ts: string;
  kind: string;
  branchId: string | null;
  payload: unknown;
  datasetVersion: string;
  inputHash: string | null;
}
