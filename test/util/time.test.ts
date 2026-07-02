import { describe, it, expect } from 'vitest';
import { parseDueToMs, formatBrtDateTime, formatBrtShort, relativeDue } from '../../src/util/time.js';

describe('parseDueToMs', () => {
  it('treats ISO without tz as BRT (UTC-3)', () => {
    expect(new Date(parseDueToMs('2026-06-22T14:00')!).toISOString()).toBe('2026-06-22T17:00:00.000Z');
    expect(new Date(parseDueToMs('2026-06-22T14:00:00')!).toISOString()).toBe('2026-06-22T17:00:00.000Z');
  });

  it('accepts a space between date and time', () => {
    expect(new Date(parseDueToMs('2026-06-22 09:30')!).toISOString()).toBe('2026-06-22T12:30:00.000Z');
  });

  it('treats date-only as end of day BRT (23:59)', () => {
    expect(new Date(parseDueToMs('2026-06-22')!).toISOString()).toBe('2026-06-23T02:59:00.000Z');
  });

  it('respects explicit timezone', () => {
    expect(new Date(parseDueToMs('2026-06-22T14:00:00Z')!).toISOString()).toBe('2026-06-22T14:00:00.000Z');
    expect(new Date(parseDueToMs('2026-06-22T14:00:00-03:00')!).toISOString()).toBe('2026-06-22T17:00:00.000Z');
  });

  it('returns null for garbage', () => {
    expect(parseDueToMs('amanhã')).toBeNull();
    expect(parseDueToMs('')).toBeNull();
  });

  it('accepts components without zero-pad (treated as BRT)', () => {
    // 2026-06-02 09:00 BRT == 12:00 UTC
    expect(new Date(parseDueToMs('2026-6-2 9:00')!).toISOString()).toBe('2026-06-02T12:00:00.000Z');
    expect(new Date(parseDueToMs('2026-6-2T9:00:00')!).toISOString()).toBe('2026-06-02T12:00:00.000Z');
  });

  it('handles multiple spaces between date and time (no UTC fallback)', () => {
    expect(new Date(parseDueToMs('2026-06-22  14:00')!).toISOString()).toBe('2026-06-22T17:00:00.000Z');
  });

  it('removes the UTC fallback: unsupported formats return null (not 3h off)', () => {
    // "June 22, 2026" used to Date.parse as UTC midnight — now rejected outright.
    expect(parseDueToMs('June 22, 2026')).toBeNull();
    expect(parseDueToMs('22/06/2026')).toBeNull();
    expect(parseDueToMs('next friday')).toBeNull();
  });
});

describe('formatBrt', () => {
  it('formats in BRT', () => {
    const ms = Date.parse('2026-06-22T17:00:00.000Z'); // 14:00 BRT
    expect(formatBrtDateTime(ms)).toBe('22/06/2026 14:00');
    expect(formatBrtShort(ms)).toBe('22/06 14:00');
  });
});

describe('relativeDue', () => {
  const now = Date.parse('2026-06-22T12:00:00.000Z');
  it('future', () => {
    expect(relativeDue(now + 2 * 3600_000, now)).toBe('vence em 2h');
    expect(relativeDue(now + 35 * 60_000, now)).toBe('vence em 35min');
    expect(relativeDue(now + 2 * 24 * 3600_000, now)).toBe('vence em 2d');
  });
  it('past', () => {
    expect(relativeDue(now - 1 * 24 * 3600_000, now)).toBe('vencida há 1d');
  });
});
