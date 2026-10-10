/**
 * Render terminates public traffic behind its managed proxy and forwards the
 * client address in X-Forwarded-For. Trust one hop only on Render; local and
 * other deployments must explicitly configure their own trusted proxy policy.
 */
export function getTrustedProxyHops(renderMarker = process.env.RENDER): number | false {
  return renderMarker === 'true' ? 1 : false;
}
