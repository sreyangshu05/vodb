import { createHmac } from 'node:crypto';

export function hashOneTimeCode(code: string, secret: string): string {
  return createHmac('sha256', secret).update(code, 'utf8').digest('hex');
}
