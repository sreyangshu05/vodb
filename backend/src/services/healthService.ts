import { db } from '../lib/db.js';
import { checkAiProvider } from './knowledgeService.js';
import { checkMailService } from './mailService.js';

export async function getHealthStatus() {
  const [database, email, ai] = await Promise.all([
    db.healthcheck().then(() => 'ready' as const, () => 'unavailable' as const),
    checkMailService(),
    checkAiProvider(),
  ]);
  const dependencies = { database, email, ai };
  const ok = Object.values(dependencies).every((status) => status !== 'unavailable');

  return {
    ok,
    service: 'voice-of-digi-bengal-backend',
    dependencies,
  };
}
