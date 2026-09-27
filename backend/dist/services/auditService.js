import { db } from '../lib/db.js';
import { logger } from '../utils/logger.js';
const AUDIT_WRITE_ATTEMPTS = 3;
const AUDIT_RETRY_DELAY_MS = 100;
let auditWriteFailureCount = 0;
let lastAuditWriteFailureAt = null;
let pendingAuditWrites = 0;
function isUuid(value) {
    return !!value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
export async function recordAuditEvent(event) {
    pendingAuditWrites += 1;
    const values = [
        isUuid(event.actorId) ? event.actorId : null,
        event.action,
        event.resourceType,
        event.resourceId ?? null,
        event.metadata ?? null,
        event.requestId ?? null,
    ];
    try {
        for (let attempt = 1; attempt <= AUDIT_WRITE_ATTEMPTS; attempt += 1) {
            try {
                await db.query(`INSERT INTO audit_events (actor_id, action, resource_type, resource_id, metadata, request_id)
           VALUES ($1, $2, $3, $4, $5, $6)`, values);
                return;
            }
            catch (error) {
                if (attempt === AUDIT_WRITE_ATTEMPTS) {
                    auditWriteFailureCount += 1;
                    lastAuditWriteFailureAt = new Date().toISOString();
                    logger.error('audit_event_write_failed', {
                        requestId: event.requestId,
                        action: event.action,
                        resourceType: event.resourceType,
                        resourceId: event.resourceId,
                        attempts: attempt,
                        failureCount: auditWriteFailureCount,
                        message: error instanceof Error ? error.message : 'unknown error',
                    });
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, AUDIT_RETRY_DELAY_MS * attempt));
            }
        }
    }
    finally {
        pendingAuditWrites = Math.max(0, pendingAuditWrites - 1);
    }
}
export async function waitForAuditWrites(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (pendingAuditWrites > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return pendingAuditWrites === 0;
}
export function auditWriteStats() {
    return {
        failureCount: auditWriteFailureCount,
        lastFailureAt: lastAuditWriteFailureAt,
        pendingWrites: pendingAuditWrites,
    };
}
