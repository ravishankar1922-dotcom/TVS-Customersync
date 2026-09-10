const { seedLegacyDataIntoLot } = require('../../src/scripts/seed-legacy-data-into-lot');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;

beforeEach(() => resetAllModels());

// Proves the migration LOGIC is correct against the same in-memory fake
// models the rest of the suite uses (same sandbox limitation as
// migrate-legacy-lots.js — see that script's header and this one's own).
describe('seedLegacyDataIntoLot() — moves the global/pre-Lot sample data into one Lot', () => {
  async function seedGlobalLedger() {
    await fakeModels.Customer.create({ customer_id: 'TEST_C001', customer_name: 'TEST Customer One', pan: 'ABCDE1234F' });
    await fakeModels.Customer.create({ customer_id: 'TEST_C002', customer_name: 'TEST Customer Two', pan: 'ABCDE1235F' });
    await fakeModels.LedgerEntry.create({
      customer_id: 'TEST_C001', lot_id: null,
      transactions: [
        { document_number: 'INV1', document_type: 'INVOICE', document_date: '2026-01-01', amount: 1000, status: 'OPEN' },
        { document_number: 'INV2', document_type: 'INVOICE', document_date: '2026-01-02', amount: 500, status: 'CLEARED' }, // excluded from balance
      ],
    });
    await fakeModels.LedgerEntry.create({
      customer_id: 'TEST_C002', lot_id: null,
      transactions: [{ document_number: 'INV3', document_type: 'INVOICE', document_date: '2026-01-03', amount: 2000, status: 'OPEN' }],
    });
  }

  test('creates one Lot and moves every global LedgerEntry into it', async () => {
    await seedGlobalLedger();
    const result = await seedLegacyDataIntoLot(fakeModels, { log: () => {} });

    expect(result.created).toBe(true);
    expect(result.population_count).toBe(2);
    expect(result.total_balance).toBe(3000); // only OPEN transactions counted

    const lots = await fakeModels.Lot.find({ is_legacy_data_seed: true }).lean();
    expect(lots.length).toBe(1);
    expect(lots[0].lot_number).toMatch(/^LOT-LEGACY-DATA-\d{3}$/);
    expect(lots[0].status).toBe('ACTIVE');
    expect(lots[0].remarks).toMatch(/pre-Lot sample\/test data/i);

    // Ledger rows re-pointed at the new Lot, not duplicated
    const ledgers = await fakeModels.LedgerEntry.find().lean();
    expect(ledgers.length).toBe(2);
    ledgers.forEach(l => expect(l.lot_id).toBe(lots[0]._id));

    // Population built with names resolved from the Customer master
    const pop = await fakeModels.LotPopulation.find({ lot_id: lots[0]._id }).lean();
    expect(pop.map(p => p.customer_id).sort()).toEqual(['TEST_C001', 'TEST_C002']);
    const c1 = pop.find(p => p.customer_id === 'TEST_C001');
    expect(c1.customer_name).toBe('TEST Customer One');
    expect(c1.opening_balance).toBe(1000);
  });

  test('is a no-op when there is no un-lotted LedgerEntry data', async () => {
    const result = await seedLegacyDataIntoLot(fakeModels, { log: () => {} });
    expect(result.created).toBe(false);
    const lots = await fakeModels.Lot.find().lean();
    expect(lots.length).toBe(0);
  });

  test('never touches a LedgerEntry that already belongs to a real Lot', async () => {
    const realLot = await fakeModels.Lot.create({ lot_number: 'LOT-2026-03-001', period_year: 2026, period_month: 3, period_label: 'March 2026', status: 'ACTIVE' });
    await fakeModels.LedgerEntry.create({ customer_id: 'TEST_REAL', lot_id: realLot._id, transactions: [{ document_number: 'X', amount: 500, status: 'OPEN' }] });
    await seedGlobalLedger();

    await seedLegacyDataIntoLot(fakeModels, { log: () => {} });

    const realLedger = await fakeModels.LedgerEntry.findOne({ customer_id: 'TEST_REAL' });
    expect(realLedger.lot_id).toBe(realLot._id); // unchanged
    const legacyPop = await fakeModels.LotPopulation.find({ lot_id: realLot._id }).lean();
    expect(legacyPop.length).toBe(0); // legacy data never leaked into the real Lot
  });

  test('dry-run makes no writes at all', async () => {
    await seedGlobalLedger();
    const result = await seedLegacyDataIntoLot(fakeModels, { dryRun: true, log: () => {} });
    expect(result.dryRun).toBe(true);
    expect(result.population_count).toBe(2);
    const lots = await fakeModels.Lot.find().lean();
    expect(lots.length).toBe(0);
    const ledger = await fakeModels.LedgerEntry.findOne({ customer_id: 'TEST_C001' });
    expect(ledger.lot_id).toBeNull();
  });

  test('is idempotent — re-running after a successful run finds nothing left to move', async () => {
    await seedGlobalLedger();
    await seedLegacyDataIntoLot(fakeModels, { log: () => {} });
    const second = await seedLegacyDataIntoLot(fakeModels, { log: () => {} });
    expect(second.created).toBe(false);
    const lots = await fakeModels.Lot.find({ is_legacy_data_seed: true }).lean();
    expect(lots.length).toBe(1); // no duplicate created
  });
});
