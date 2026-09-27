export type HttpStatus = 200 | 201 | 202 | 204 | 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500;

export interface ApiErrorShape {
  error: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface BlogRecord {
  id: string;
  title: string;
  slug: string;
  content: string;
  meta_title: string | null;
  meta_description: string | null;
  published: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
  image_media_id?: string | null;
  image_url?: string | null;
  image_alt?: string | null;
}

export interface EventRecord {
  id: string;
  title: string;
  slug: string;
  description: string;
  event_date: string;
  ends_at: string | null;
  location: string;
  published: boolean;
  capacity: number | null;
  registration_url: string | null;
  meta_title: string | null;
  meta_description: string | null;
  created_at: string;
  updated_at: string;
  image_media_id?: string | null;
  image_url?: string | null;
  image_alt?: string | null;
}

export interface ContactInquiryInput {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export interface NewsletterSubscriptionInput {
  email: string;
  source?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name?: string;
  role: 'member' | 'admin' | 'editor';
}
