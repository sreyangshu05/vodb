import test from 'node:test';
import assert from 'node:assert/strict';
import { contactSchema, eventPayloadSchema, eventUpdateSchema } from '../lib/validators.js';

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

test('event capacity respects the PostgreSQL signed INTEGER boundary and rejects wrong shapes', () => {
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, capacity: 0 }).success, true);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, capacity: 2_147_483_647 }).success, true);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, capacity: 2_147_483_648 }).success, false);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, capacity: -1 }).success, false);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, capacity: 1.5 }).success, false);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, capacity: '10' }).success, false);
  assert.equal(eventPayloadSchema.safeParse({ ...validEvent, capacity: null }).success, true);
});

test('contact validation handles empty, null, wrong-type, maximum-length, and Unicode inputs', () => {
  const base = {
    name: 'N'.repeat(100),
    email: 'reader@example.com',
    subject: 'S'.repeat(200),
    message: 'M'.repeat(3000),
  };

  assert.equal(contactSchema.safeParse(base).success, true);
  assert.equal(contactSchema.safeParse({ ...base, name: '   ' }).success, false);
  assert.equal(contactSchema.safeParse({ ...base, subject: '' }).success, false);
  assert.equal(contactSchema.safeParse({ ...base, message: null }).success, false);
  assert.equal(contactSchema.safeParse({ ...base, email: ['reader@example.com'] }).success, false);
  assert.equal(contactSchema.safeParse({ ...base, name: 'N'.repeat(101) }).success, false);
  assert.equal(contactSchema.safeParse({ ...base, subject: 'S'.repeat(201) }).success, false);
  assert.equal(contactSchema.safeParse({ ...base, message: 'M'.repeat(3001) }).success, false);

  const unicode = contactSchema.safeParse({
    name: 'আনিরুদ্ধ 🌿',
    email: 'reader@example.com',
    subject: 'শুভেচ্ছা 👋',
    message: 'বাংলা text with emoji 🌊',
  });
  assert.equal(unicode.success, true);
});
