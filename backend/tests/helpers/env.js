// Loaded by Jest before any test file / app module. Deliberately uses
// TEST_-prefixed / obviously-fake values everywhere — this suite must never
// be able to reach or resemble production config. `server.js` only calls
// startup() (which calls connectDB()) when run as the main module, and
// tests instead `require('../src/server')` for its exported `app`, so no
// real Mongo connection is ever attempted during this suite.
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'TEST_jwt_secret_do_not_use_in_prod';
process.env.HMAC_SECRET = 'TEST_hmac_secret_do_not_use_in_prod';
process.env.ADMIN_EMAIL = 'TEST_admin@example.test';
process.env.ADMIN_PASSWORD = 'TEST_Password_123!';
process.env.CYCLE_ID = 'TEST-CYCLE-2026';
process.env.COMPANY = 'TEST_CO';
process.env.AS_OF_DATE = '31-Mar-2026';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017/TEST_balancesync_unused';
// SMTP intentionally left unset -> mailer.isConfigured() === false, so
// email-sending code paths run for real but no network send is attempted.
delete process.env.SMTP_HOST;
