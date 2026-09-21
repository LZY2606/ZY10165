import { createHash } from 'node:crypto';
import type { ClockEvent, ToaView } from './types.js';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(',')}}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hashToas(toas: ToaView[]): string {
  return sha256(
    stableStringify(
      toas.map((toa) => ({
        code: toa.code,
        tNs: toa.tNs.toString(),
        freqMhz: toa.freqMhz,
        nCycles: toa.nCycles.toString(),
        wrapped: toa.wrapped,
        active: toa.active,
        version: toa.versionId,
      })),
    ),
  );
}

export function hashClockEvents(events: ClockEvent[]): string {
  return sha256(
    stableStringify(
      events
        .slice()
        .sort((a, b) => a.seq - b.seq)
        .map((event) => ({
          seq: event.seq,
          atNs: event.atNs.toString(),
          jumpNs: event.jumpNs.toString(),
          label: event.label,
        })),
    ),
  );
}

export function branchInputSignature(opts: {
  baseVersion: string;
  gapOffsets: Record<string, number>;
  excluded: string[];
  clockHash: string;
  toaHash: string;
}): string {
  return sha256(stableStringify(opts));
}
