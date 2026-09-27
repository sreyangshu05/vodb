import { promisify } from 'node:util';
import { randomBytes, scrypt as scryptCallback } from 'node:crypto';

const scrypt = promisify(scryptCallback);
const input = process.stdin;

if (!input.isTTY || typeof input.setRawMode !== 'function') {
  throw new Error('Run this command from an interactive terminal so the password can be entered without echo.');
}

let password = '';
process.stdout.write('Admin password (input hidden): ');
input.setRawMode(true);
input.setEncoding('utf8');
input.resume();

input.on('data', async (chunk) => {
  for (const character of chunk) {
    if (character === '\u0003') {
      process.stdout.write('\nCancelled.\n');
      input.setRawMode(false);
      input.pause();
      process.exitCode = 1;
      return;
    }
    if (character === '\r' || character === '\n') {
      if (password.length < 12) {
        process.stdout.write('\nUse an admin password of at least 12 characters: ');
        password = '';
        continue;
      }

      input.setRawMode(false);
      input.pause();
      process.stdout.write('\n');
      const salt = randomBytes(16);
      const derivedKey = await scrypt(password, salt, 64);
      process.stdout.write(`ADMIN_PASSWORD_HASH=scrypt$${salt.toString('base64')}$${derivedKey.toString('base64')}\n`);
      password = '';
      return;
    }
    if (character === '\u007f' || character === '\b') {
      password = password.slice(0, -1);
      continue;
    }
    password += character;
  }
});
