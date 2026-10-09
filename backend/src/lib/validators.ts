import { z } from 'zod';

export const emailSchema = z.string().trim().email().max(320);

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  subject: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(3000),
  website: z.string().max(200).optional(),
});

export const newsletterSchema = z.object({
  email: emailSchema,
  source: z.string().trim().max(80).optional(),
  website: z.string().max(200).optional(),
});

export const newsletterTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{32,128}$/);
export const newsletterDeliveryWebhookSchema = z.object({
  eventId: z.string().trim().min(1).max(200),
  occurredAt: z.string().datetime({ offset: true }),
  event: z.enum(['delivered', 'bounce', 'complaint']),
  email: emailSchema,
});

export const blogPayloadSchema = z.object({
  title: z.string().trim().min(1).max(240),
  slug: z.string().trim().min(1).max(260),
  content: z.string().trim().min(1),
  metaTitle: z.string().trim().max(240).nullable().optional(),
  metaDescription: z.string().trim().max(320).nullable().optional(),
  published: z.boolean().default(false),
  imageMediaId: z.string().uuid().nullable().optional(),
});

const eventPayloadBaseSchema = z.object({
  title: z.string().trim().min(1).max(240),
  slug: z.string().trim().min(1).max(260),
  description: z.string().trim().min(1),
  eventDate: z.string().refine((value) => z.string().datetime({ offset: true }).safeParse(value).success || isCalendarDate(value)),
  endsAt: z.string().refine((value) => z.string().datetime({ offset: true }).safeParse(value).success || isCalendarDate(value)).nullable().optional(),
  allDay: z.boolean().default(false),
  location: z.string().trim().min(1).max(300),
  published: z.boolean().default(false),
  capacity: z.number().int().nonnegative().nullable().optional(),
  registrationUrl: z.string().url().max(2048).nullable().optional(),
  metaTitle: z.string().trim().max(240).nullable().optional(),
  metaDescription: z.string().trim().max(320).nullable().optional(),
  imageMediaId: z.string().uuid().nullable().optional(),
});

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function normalizeCalendarDate(value: string): string {
  return isCalendarDate(value) ? `${value}T00:00:00.000Z` : value;
}

function validateEventRange(
  payload: { eventDate?: string; endsAt?: string | null; allDay?: boolean },
  context: z.RefinementCtx,
) {
  if (!payload.allDay && payload.eventDate && isCalendarDate(payload.eventDate)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eventDate'],
      message: 'Date-only event dates require allDay to be true.',
    });
  }
  if (!payload.allDay && payload.endsAt && isCalendarDate(payload.endsAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'Date-only event end dates require allDay to be true.',
    });
  }

  const isUtcMidnight = (value: string) => {
    const date = new Date(value);
    return date.getUTCHours() === 0 && date.getUTCMinutes() === 0 &&
      date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  };

  if (payload.allDay && payload.eventDate && !isUtcMidnight(payload.eventDate)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['eventDate'],
      message: 'All-day event dates must be UTC calendar-date anchors.',
    });
  }
  if (payload.allDay && payload.endsAt && !isUtcMidnight(payload.endsAt)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'All-day event end dates must be UTC calendar-date anchors.',
    });
  }
  if (payload.eventDate && payload.endsAt &&
      new Date(payload.endsAt).getTime() < new Date(payload.eventDate).getTime()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['endsAt'],
      message: 'Event end time must be on or after its start time.',
    });
  }
}

export const eventPayloadSchema = eventPayloadBaseSchema.superRefine(validateEventRange)
  .transform((payload) => ({
    ...payload,
    eventDate: normalizeCalendarDate(payload.eventDate),
    endsAt: payload.endsAt == null ? payload.endsAt : normalizeCalendarDate(payload.endsAt),
  }));

export const blogUpdateSchema = blogPayloadSchema.omit({ published: true }).partial();
export const eventUpdateSchema = eventPayloadBaseSchema
  .omit({ published: true })
  .partial()
  .superRefine(validateEventRange)
  .transform((payload) => ({
    ...payload,
    eventDate: payload.eventDate ? normalizeCalendarDate(payload.eventDate) : undefined,
    endsAt: payload.endsAt == null ? payload.endsAt : normalizeCalendarDate(payload.endsAt),
  }));
