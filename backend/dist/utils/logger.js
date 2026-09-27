const isProduction = process.env.NODE_ENV === 'production';
const redact = (input) => {
    if (typeof input !== 'string')
        return input;
    return input.replace(/(Authorization:\s*)(.+)/gi, '$1[REDACTED]').replace(/(password=)([^&\s]+)/gi, '$1[REDACTED]');
};
export const logger = {
    info: (...args) => write('info', args),
    warn: (...args) => write('warn', args),
    error: (...args) => write('error', args),
};
function write(level, args) {
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
