process.env.NODE_ENV = 'test';

const databaseMode = process.env.BACKEND_TEST_DATABASE_MODE ?? 'unavailable';
process.env.BACKEND_TEST_DATABASE_MODE = databaseMode;

if (databaseMode === 'unavailable') {
  process.env.POSTGRES_HOST = '127.0.0.1';
  process.env.POSTGRES_PORT = '59999';
  delete process.env.DATABASE_URL;
  delete process.env.DIRECT_DATABASE_URL;
  delete process.env.ADMIN_PASSWORD_HASH;
  process.env.ADMIN_EMAIL = 'admin@voiceofdigi.org';
  process.env.ADMIN_EMAILS = '';
  process.env.ADMIN_PASSWORD = 'admin123';
} else if (databaseMode !== 'available') {
  throw new Error('BACKEND_TEST_DATABASE_MODE must be either unavailable or available.');
}
