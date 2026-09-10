const te = require('../../src/utils/tokenEngine');

describe('tokenEngine (real module, no DB, no mocks)', () => {
  test('round-trips a valid token', () => {
    const t = te.generateToken('TEST_C001', 'TEST-CYCLE', 'TEST_CO', 72);
    const v = te.validateToken(t.token);
    expect(v.valid).toBe(true);
    expect(v.payload.customer_id).toBe('TEST_C001');
    expect(v.payload.cycle_id).toBe('TEST-CYCLE');
  });

  test('detects any single-character tampering of the payload', () => {
    const t = te.generateToken('TEST_C001', 'TEST-CYCLE', 'TEST_CO', 72);
    const [encoded, sig] = t.token.split('.');
    const tamperedEncoded = encoded.slice(0, -1) + (encoded.slice(-1) === 'a' ? 'b' : 'a');
    const v = te.validateToken(`${tamperedEncoded}.${sig}`);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('INVALID_SIGNATURE');
  });

  test('detects a forged signature even if the payload claims a fake customer_id', () => {
    const forged = Buffer.from(JSON.stringify({ token_id: 'x', customer_id: 'TEST_ANYONE', cycle_id: 'c', expires_at: Date.now() + 100000 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
    const v = te.validateToken(`${forged}.0000000000000000000000000000000000000000000000000000000000000000`);
    expect(v.valid).toBe(false);
    expect(v.reason).toBe('INVALID_SIGNATURE');
  });

  test('rejects malformed token shapes without throwing', () => {
    for (const bad of [null, undefined, '', 'onlyonepart', 'a.b.c', 42, {}]) {
      expect(() => te.validateToken(bad)).not.toThrow();
      expect(te.validateToken(bad).valid).toBe(false);
    }
  });

  test('portal URL embeds the token and uses configured FRONTEND_URL', () => {
    const t = te.generateToken('TEST_C001', 'TEST-CYCLE', 'TEST_CO', 72);
    const url = te.buildPortalUrl(t.token);
    expect(url).toContain('http://localhost:3000/portal?t=');
    expect(decodeURIComponent(url.split('t=')[1])).toBe(t.token);
  });

  test('every generated token_id is unique across many generations', () => {
    const ids = new Set();
    for (let i = 0; i < 500; i++) ids.add(te.generateToken('TEST_C001', 'c', 'co', 1).token_id);
    expect(ids.size).toBe(500);
  });

  // ── Phase 2: Lot/business_type binding (BalanceSync_Lot_Architecture_Plan.md) ──
  describe('lot_id / business_type binding', () => {
    test('a Lot-scoped token embeds lot_id and business_type in the signed payload', () => {
      const t = te.generateToken('TEST_C001', 'LOT-2026-03-001', 'TEST_CO', 72, { lot_id: '507f1f77bcf86cd799439011', business_type: 'VENDOR' });
      const v = te.validateToken(t.token);
      expect(v.valid).toBe(true);
      expect(v.payload.lot_id).toBe('507f1f77bcf86cd799439011');
      expect(v.payload.business_type).toBe('VENDOR');
    });

    test('omitting extra leaves lot_id/business_type null (legacy tokens unaffected)', () => {
      const t = te.generateToken('TEST_C001', 'TEST-CYCLE', 'TEST_CO', 72);
      const v = te.validateToken(t.token);
      expect(v.payload.lot_id).toBeNull();
      expect(v.payload.business_type).toBeNull();
    });

    test('tampering with the lot_id (e.g. swapping in another Lot) is caught by the SAME signature check — non-manipulable via the URL', () => {
      const t = te.generateToken('TEST_C001', 'LOT-2026-03-001', 'TEST_CO', 72, { lot_id: 'AAAAAAAAAAAAAAAAAAAAAAAA', business_type: 'CUSTOMER' });
      const [encoded, sig] = t.token.split('.');
      const decoded = JSON.parse(Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
      decoded.lot_id = 'BBBBBBBBBBBBBBBBBBBBBBBB'; // attacker tries to point the link at a different Lot
      const forgedEncoded = Buffer.from(JSON.stringify(decoded)).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const v = te.validateToken(`${forgedEncoded}.${sig}`);
      expect(v.valid).toBe(false);
      expect(v.reason).toBe('INVALID_SIGNATURE');
    });
  });
});
