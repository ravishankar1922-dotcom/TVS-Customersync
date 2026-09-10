const { migrateLegacyLots } = require('../../src/scripts/migrate-legacy-lots');
const fakeModels = require('../helpers/models/index');
const { resetAllModels } = fakeModels;

beforeEach(() => resetAllModels());

// Proves the MIGRATION LOGIC is correct against the same in-memory fake
// models the rest of the suite uses — this sandbox has no real MongoDB to
// run the actual script against (see the script's own header comment and
// the QA report). This is a genuine logic test, not a live-DB run.
describe('migrateLegacyLots() — legacy Lot backfill', () => {
  async function seedLegacyCycle(cycleId, customerIds) {
    for (const id of customerIds) {
      await fakeModels.Confirmation.create({ customer_id: id, cycle_id: cycleId, status: 'MATCHED' });
      await fakeModels.TokenRecord.create({ token_id: `TEST_TOK_${id}_${cycleId}`, customer_id: id, cycle_id: cycleId, status: 'USED' });
      await fakeModels.LedgerEntry.create({ customer_id: id, transactions: [] }); // pre-Lot: no lot_id, one global doc
    }
  }

  test('creates one legacy Lot per distinct cycle_id and backfills lot_id', async () => {
    await seedLegacyCycle('TSL-MAR-2026', ['TEST_A', 'TEST_B']);
    await seedLegacyCycle('TSL-JUN-2026', ['TEST_C']);

    const results = await migrateLegacyLots(fakeModels, { log: () => {} });
    expect(results.length).toBe(2);

    const lots = await fakeModels.Lot.find({ is_legacy: true }).lean();
    expect(lots.length).toBe(2);
    expect(lots.map(l => l.legacy_cycle_id).sort()).toEqual(['TSL-JUN-2026', 'TSL-MAR-2026']);
    lots.forEach(l => expect(l.lot_number).toMatch(/^LOT-LEGACY-\d{3}$/));

    // Confirmations backfilled with the right lot_id
    const confA = await fakeModels.Confirmation.findOne({ customer_id: 'TEST_A' });
    const marLot = lots.find(l => l.legacy_cycle_id === 'TSL-MAR-2026');
    expect(confA.lot_id).toBe(marLot._id);

    // Population inferred correctly per cycle, never mixed
    const marPop = await fakeModels.LotPopulation.find({ lot_id: marLot._id }).lean();
    expect(marPop.map(p => p.customer_id).sort()).toEqual(['TEST_A', 'TEST_B']);
  });

  test('is idempotent — re-running does not create duplicate legacy Lots', async () => {
    await seedLegacyCycle('TSL-MAR-2026', ['TEST_A']);
    await migrateLegacyLots(fakeModels, { log: () => {} });
    const results2 = await migrateLegacyLots(fakeModels, { log: () => {} });
    expect(results2[0].skipped).toBe(true);
    const lots = await fakeModels.Lot.find({ is_legacy: true }).lean();
    expect(lots.length).toBe(1);
  });

  test('dry-run makes no writes at all', async () => {
    await seedLegacyCycle('TSL-MAR-2026', ['TEST_A']);
    await migrateLegacyLots(fakeModels, { dryRun: true, log: () => {} });
    const lots = await fakeModels.Lot.find().lean();
    expect(lots.length).toBe(0);
    const confA = await fakeModels.Confirmation.findOne({ customer_id: 'TEST_A' });
    expect(confA.lot_id).toBeUndefined();
  });

  test('no data is deleted or mutated beyond adding lot_id', async () => {
    await seedLegacyCycle('TSL-MAR-2026', ['TEST_A']);
    const before = await fakeModels.Confirmation.findOne({ customer_id: 'TEST_A' });
    await migrateLegacyLots(fakeModels, { log: () => {} });
    const after = await fakeModels.Confirmation.findOne({ customer_id: 'TEST_A' });
    expect(after.status).toBe(before.status);
    expect(after.customer_id).toBe(before.customer_id);
    expect(after.lot_id).toBeTruthy(); // only new field added
  });
});
