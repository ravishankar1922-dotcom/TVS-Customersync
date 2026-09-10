const request = require('supertest');
const XLSX = require('xlsx');
const app = require('../../src/server');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;
const { adminJwt } = require('../helpers/seed');

beforeEach(() => resetAllModels());

// Sept 2026: "Where is the provision to upload customer master?" — a JSON
// API endpoint already existed (POST /api/customers|vendors/import-json)
// but there was no file-upload support and no admin UI. These tests cover
// the new POST /api/customers/import and /api/vendors/import file-upload
// endpoints (Excel/CSV or JSON, auto-detected, flexible header matching).

function buildXlsx(headers, rows) {
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

describe('POST /api/customers/import — file upload (Excel/CSV/JSON)', () => {
  test('Excel upload with human-friendly headers upserts the customer master', async () => {
    const buf = buildXlsx(
      ['Customer Code', 'Customer Name', 'Email Address', 'PAN Number'],
      [['CUST0100', 'Acme Motors', 'acme@example.test', 'abcde1234f']]
    );
    const res = await request(app).post('/api/customers/import').set('Authorization', `Bearer ${adminJwt()}`)
      .field('mode', 'replace').attach('master_file', buf, 'customers.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.upserted).toBe(1);

    const c = await fakeModels.Customer.findOne({ customer_id: 'CUST0100' });
    expect(c.customer_name).toBe('Acme Motors');
    expect(c.pan).toBe('ABCDE1234F'); // uppercased
  });

  test('JSON upload works the same as the file-based path (array of customer objects)', async () => {
    const buf = Buffer.from(JSON.stringify([{ customer_id: 'CUST0200', customer_name: 'Test Traders', pan: 'ABCDE1234F', email: 'x@example.test' }]), 'utf8');
    const res = await request(app).post('/api/customers/import').set('Authorization', `Bearer ${adminJwt()}`)
      .attach('master_file', buf, 'customers.json');
    expect(res.status).toBe(200);
    expect(res.body.upserted).toBe(1);
  });

  test('dryRun previews matched vs new without writing anything', async () => {
    await fakeModels.Customer.create({ customer_id: 'CUST0300', customer_name: 'Existing Co', pan: 'ABCDE1234F' });
    const buf = buildXlsx(['customer_id', 'customer_name', 'pan'], [['CUST0300', 'Existing Co Updated', 'ABCDE1234F'], ['CUST0301', 'New Co', 'ABCDE1234F']]);
    const res = await request(app).post('/api/customers/import').set('Authorization', `Bearer ${adminJwt()}`)
      .field('dryRun', 'true').attach('master_file', buf, 'customers.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.dryRun).toBe(true);
    expect(res.body.matched).toBe(1);
    expect(res.body.new).toBe(1);

    const stillOld = await fakeModels.Customer.findOne({ customer_id: 'CUST0300' });
    expect(stillOld.customer_name).toBe('Existing Co'); // unchanged — dry run wrote nothing
    expect(await fakeModels.Customer.findOne({ customer_id: 'CUST0301' })).toBeNull();
  });

  test('append mode never touches an existing customer_id', async () => {
    await fakeModels.Customer.create({ customer_id: 'CUST0400', customer_name: 'Original Name', pan: 'ABCDE1234F' });
    const buf = buildXlsx(['customer_id', 'customer_name', 'pan'], [['CUST0400', 'Overwritten?', 'ABCDE1234F'], ['CUST0401', 'Brand New', 'ABCDE1234F']]);
    const res = await request(app).post('/api/customers/import').set('Authorization', `Bearer ${adminJwt()}`)
      .field('mode', 'append').attach('master_file', buf, 'customers.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.upserted).toBe(1);
    expect(res.body.appendedSkipped).toBe(1);

    const existing = await fakeModels.Customer.findOne({ customer_id: 'CUST0400' });
    expect(existing.customer_name).toBe('Original Name');
  });

  test('rows missing a PAN are skipped, not silently defaulted (PAN gates portal login)', async () => {
    const buf = buildXlsx(['customer_id', 'customer_name', 'pan'], [['CUST0500', 'No Pan Co', '']]);
    const res = await request(app).post('/api/customers/import').set('Authorization', `Bearer ${adminJwt()}`).attach('master_file', buf, 'customers.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.upserted).toBe(0);
    expect(res.body.skipped).toBe(1);
    expect(await fakeModels.Customer.findOne({ customer_id: 'CUST0500' })).toBeNull();
  });

  test('400 when no file is attached', async () => {
    const res = await request(app).post('/api/customers/import').set('Authorization', `Bearer ${adminJwt()}`);
    expect(res.status).toBe(400);
  });

  test('requires admin auth', async () => {
    const buf = buildXlsx(['customer_id', 'customer_name', 'pan'], [['CUST0600', 'X', 'ABCDE1234F']]);
    const res = await request(app).post('/api/customers/import').attach('master_file', buf, 'customers.xlsx');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/vendors/import — file upload (Excel/CSV/JSON)', () => {
  test('Excel upload with human-friendly headers upserts the vendor master', async () => {
    const buf = buildXlsx(['Vendor Code', 'Vendor Name', 'PAN Number'], [['VEND0001', 'Steel Supplies Co', 'ABCDE1234F']]);
    const res = await request(app).post('/api/vendors/import').set('Authorization', `Bearer ${adminJwt()}`).attach('master_file', buf, 'vendors.xlsx');
    expect(res.status).toBe(200);
    expect(res.body.upserted).toBe(1);
    const v = await fakeModels.Vendor.findOne({ vendor_id: 'VEND0001' });
    expect(v.vendor_name).toBe('Steel Supplies Co');
  });

  test('a row missing vendor id/name/pan is rejected with a clear error, nothing written', async () => {
    const buf = buildXlsx(['vendor_id', 'vendor_name'], [['VEND0002', 'No PAN Co']]);
    const res = await request(app).post('/api/vendors/import').set('Authorization', `Bearer ${adminJwt()}`).attach('master_file', buf, 'vendors.xlsx');
    expect(res.status).toBe(400);
    expect(await fakeModels.Vendor.findOne({ vendor_id: 'VEND0002' })).toBeNull();
  });

  test('requires admin auth', async () => {
    const buf = buildXlsx(['vendor_id', 'vendor_name', 'pan'], [['VEND0003', 'X', 'ABCDE1234F']]);
    const res = await request(app).post('/api/vendors/import').attach('master_file', buf, 'vendors.xlsx');
    expect(res.status).toBe(401);
  });
});
