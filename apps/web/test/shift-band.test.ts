import {describe,expect,it} from 'vitest';
import {shiftBandLabel,shiftBandOfDay} from '../src/shift-band';

// The business timezone is America/Los_Angeles (UTC-7 in September), so the ISO instants
// below read 08:00 / 13:00 / 18:00 / 22:00 local.
describe('shift bands',()=>{
 it('names the part of day the assigned run covers',()=>{
  expect(shiftBandOfDay('2026-09-14T15:00:00.000Z','America/Los_Angeles')).toBe('Morning');
  expect(shiftBandOfDay('2026-09-14T20:00:00.000Z','America/Los_Angeles')).toBe('Afternoon');
  expect(shiftBandOfDay('2026-09-15T01:00:00.000Z','America/Los_Angeles')).toBe('Evening');
  expect(shiftBandOfDay('2026-09-15T05:00:00.000Z','America/Los_Angeles')).toBe('Night');
  expect(shiftBandLabel('2026-09-15T05:00:00.000Z','America/Los_Angeles')).toBe('Night shift');
 });
 it('is the business timezone that decides, not the browser or UTC',()=>{
  expect(shiftBandOfDay('2026-09-14T15:00:00.000Z','UTC')).toBe('Afternoon');
  expect(shiftBandOfDay('2026-09-14T15:00:00.000Z','America/Los_Angeles')).toBe('Morning');
 });
 it('falls back to morning for an unreadable instant rather than showing nothing',()=>{
  expect(shiftBandOfDay('not-a-time','America/Los_Angeles')).toBe('Morning');
 });
});
