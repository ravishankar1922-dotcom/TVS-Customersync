module.exports = {
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/tests/**/*.test.js'],
  setupFiles: ['<rootDir>/tests/helpers/env.js'],
  // Redirect every `require('.../models/<Name>')` anywhere in the real
  // source tree to the shared in-memory fake for that collection (see
  // tests/helpers/fakeModel.js for why a real MongoDB isn't used here).
  // Route/middleware/business-logic code itself is NOT mocked — it runs
  // unmodified against these fakes.
  moduleNameMapper: {
    '(.*)models/Customer$': '<rootDir>/tests/helpers/models/Customer.js',
    '(.*)models/LedgerEntry$': '<rootDir>/tests/helpers/models/LedgerEntry.js',
    '(.*)models/TokenRecord$': '<rootDir>/tests/helpers/models/TokenRecord.js',
    '(.*)models/Confirmation$': '<rootDir>/tests/helpers/models/Confirmation.js',
    '(.*)models/EmailLog$': '<rootDir>/tests/helpers/models/EmailLog.js',
    '(.*)models/AuditLog$': '<rootDir>/tests/helpers/models/AuditLog.js',
    '(.*)models/Admin$': '<rootDir>/tests/helpers/models/Admin.js',
    '(.*)models/ImportHistory$': '<rootDir>/tests/helpers/models/ImportHistory.js',
    '(.*)models/LedgerImportStaging$': '<rootDir>/tests/helpers/models/LedgerImportStaging.js',
    '(.*)models/Lot$': '<rootDir>/tests/helpers/models/Lot.js',
    '(.*)models/LotPopulation$': '<rootDir>/tests/helpers/models/LotPopulation.js',
    '(.*)models/SubmissionVersion$': '<rootDir>/tests/helpers/models/SubmissionVersion.js',
    '(.*)models/Vendor$': '<rootDir>/tests/helpers/models/Vendor.js',
  },
  verbose: true,
  testTimeout: 15000,
};
