import test from 'node:test';
import assert from 'node:assert/strict';
import { eventPayloadSchema, eventUpdateSchema } from '../lib/validators.js';

const validEvent = {
  title: 'Community gathering',
  slug: 'community-gathering',
  description: 'A community event.',
  eventDate: '2026-11-01T10:00:00+05:30',
  location: 'Kolkata',
};

test('event dates require valid offset-aware timestamps', () => {
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, eventDate: 'not-a-date' }).success, false);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, eventDate: '2026-02-30T10:00:00Z' }).success, false);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, eventDate: '2026-11-01T10:00:00' }).success, false);
});

test('all-day events accept validated date-only inputs and normalize them as UTC calendar dates', () => {
  const parsed = eventPayloadSchema.safeParse({
    ...validEvent,
    eventDate: '2026-03-08',
    endsAt: '2026-03-09',
    allDay: true,
  });
  assert.equal(parsed.success, true);
  if (parsed.success) {
    assert.equal(parsed.data.eventDate, '2026-03-08T00:00:00.000Z');
    assert.equal(parsed.data.endsAt, '2026-03-09T00:00:00.000Z');
  }

  assert.equal(eventPayloadSchema.safeParse({
    ...validEvent,
    eventDate: '2026-02-30',
    allDay: true,
  }).success, false);
  assert.equal(eventPayloadSchema.safeParse({
    ...validEvent,
    eventDate: '2026-03-08',
  }).success, false);
  assert.equal(eventPayloadSchema.safeParse({
    ...validEvent,
    eventDate: '2026-03-08T09:00:00-05:00',
    allDay: true,
  }).success, false);
  assert.equal(eventPayloadSchema.safeParse({
    ...validEvent,
    eventDate: '2026-03-09',
    endsAt: '2026-03-08',
    allDay: true,
  }).success, false);
  const partial = eventUpdateSchema.safeParse({ eventDate: '2026-03-08', allDay: true });
  assert.equal(partial.success, true);
  if (partial.success) assert.equal(partial.data.eventDate, '2026-03-08T00:00:00.000Z');
});

test('event end cannot precede its start on create or when both values are updated', () => {
  assert.equal(eventPayloadSchema.safeParse({
    ...validEvent,
    endsAt: '2026-11-01T09:59:00+05:30',
  }).success, false);
  assert.equal(eventUpdateSchema.safeParse({
    eventDate: '2026-11-01T10:00:00Z',
    endsAt: '2026-11-01T09:59:00Z',
  }).success, false);
  assert.equal(eventUpdateSchema.safeParse({
    endsAt: '2026-11-01T09:59:00Z',
  }).success, true);
});
