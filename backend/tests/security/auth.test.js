const request = require('supertest');
const app = require('../../src/server');
const { resetAllModels } = require('../helpers/models/index');
const { seedAdmin, adminJwt } = require('../helpers/seed');

beforeEach(() => resetAllModels());

describe('Admin auth', () => {
  test('rejects login with wrong password', async () => {
    await seedAdmin();
    const res = await request(app).post('/api/auth/login').send({ email: 'TEST_admin@example.test', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid/i);
  });

  test('accepts correct credentials and returns a working JWT', async () => {
    await seedAdmin();
    const res = await request(app).post('/api/auth/login').send({ email: 'TEST_admin@example.test', password: 'TEST_Password_123!' });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${res.body.token}`);
    expect(me.status).toBe(200);
    expect(me.body.email).toBe('test_admin@example.test');
  });

  test('rate-limits repeated failed logins (max 10 per 15 min per IP)', async () => {
    await seedAdmin();
    let last;
    for (let i = 0; i < 11; i++) {
      last = await request(app).post('/api/auth/login').send({ email: 'TEST_admin@example.test', password: 'wrong' });
    }
    expect(last.status).toBe(429);
  });

  test('protected route rejects missing token', async () => {
    const res = await request(app).get('/api/dashboard');
    expect(res.status).toBe(401);
  });

  test('protected route rejects garbage JWT', async () => {
    const res = await request(app).get('/api/dashboard').set('Authorization', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  test('requireAdmin also accepts a valid JWT via ?token= query param (documented download-link support)', async () => {
    const res = await request(app).get(`/api/audit?token=${adminJwt()}`);
    expect(res.status).toBe(200);
  });
});
