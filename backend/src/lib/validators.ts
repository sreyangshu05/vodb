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

export const eventPayloadSchema = z.object({
  title: z.string().trim().min(1).max(240),
  slug: z.string().trim().min(1).max(260),
  description: z.string().trim().min(1),
  eventDate: z.string().datetime({ offset: true }).or(z.string()),
  endsAt: z.string().datetime({ offset: true }).nullable().optional(),
  location: z.string().trim().min(1).max(300),
  published: z.boolean().default(false),
  capacity: z.number().int().nonnegative().nullable().optional(),
  registrationUrl: z.string().url().max(2048).nullable().optional(),
  metaTitle: z.string().trim().max(240).nullable().optional(),
  metaDescription: z.string().trim().max(320).nullable().optional(),
  imageMediaId: z.string().uuid().nullable().optional(),
});

export const blogUpdateSchema = blogPayloadSchema.omit({ published: true }).partial();
export const eventUpdateSchema = eventPayloadSchema.omit({ published: true }).partial();
