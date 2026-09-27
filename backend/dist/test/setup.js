process.env.NODE_ENV = 'test';
const databaseMode = process.env.BACKEND_TEST_DATABASE_MODE ?? 'unavailable';
if (databaseMode === 'unavailable') {
    process.env.POSTGRES_HOST = '127.0.0.1';
    process.env.POSTGRES_PORT = '59999';
}
else if (databaseMode !== 'available') {
    throw new Error('BACKEND_TEST_DATABASE_MODE must be either unavailable or available.');
}
export {};
