const isProduction = process.env.NODE_ENV === 'production';

const redact = (input: unknown): unknown => {
  if (typeof input !== 'string') return input;
  return input.replace(/(Authorization:\s*)(.+)/gi, '$1[REDACTED]').replace(/(password=)([^&\s]+)/gi, '$1[REDACTED]');
};

export const logger = {
  info: (...args: unknown[]) => write('info', args),
  warn: (...args: unknown[]) => write('warn', args),
  error: (...args: unknown[]) => write('error', args),
};

function write(level: 'info' | 'warn' | 'error', args: unknown[]) {
  const redacted = args.map(redact);
  if (isProduction) {
    const [message, fields] = redacted;
    console[level](JSON.stringify({
      level,
      message: String(message),
      ...(fields && typeof fields === 'object' ? fields : {}),
    }));
    return;
  }

  console[level](`[${level.toUpperCase()}]`, ...redacted);
}
