const { FakeModel } = require('../fakeModel');

const models = {
  Customer: new FakeModel('Customer'),
  LedgerEntry: new FakeModel('LedgerEntry'),
  TokenRecord: new FakeModel('TokenRecord'),
  Confirmation: new FakeModel('Confirmation'),
  EmailLog: new FakeModel('EmailLog'),
  AuditLog: new FakeModel('AuditLog'),
  Admin: new FakeModel('Admin'),
  ImportHistory: new FakeModel('ImportHistory'),
  LedgerImportStaging: new FakeModel('LedgerImportStaging'),
  Lot: new FakeModel('Lot'),
  LotPopulation: new FakeModel('LotPopulation'),
  SubmissionVersion: new FakeModel('SubmissionVersion'),
  Vendor: new FakeModel('Vendor'),
};

function resetAllModels() { Object.values(models).forEach(m => m.reset()); }

module.exports = { ...models, resetAllModels };
