# Cypress fixtures — not yet generated

The specs in `cypress/e2e/` reference fixture ledger files
(`sample_ledger.xlsx`, `sample_ledger_v2.xlsx`, `sample_vendor_ledger.xlsx`)
that do not exist in this repository yet, because these specs were authored
but never executed in the delivery sandbox (see `cypress.config.js`'s header
comment for why).

Before running the suite for real, generate them with a short script using
the `xlsx` package already in `backend/package.json`, matching the column
shape `backend/src/routes/ledger.js` expects: `customer_id, document_number,
document_type, document_date, amount, status`. For example:

```js
const XLSX = require('xlsx');
const rows = [
  ['customer_id','document_number','document_type','document_date','amount','status'],
  ['TEST_C001','INV001','INVOICE','2026-03-01',10000,'OPEN'],
  ['TEST_C002','INV002','INVOICE','2026-03-02',5000,'OPEN'],
];
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Ledger');
XLSX.writeFile(wb, 'sample_ledger.xlsx');
```

`sample_vendor_ledger.xlsx` should use vendor IDs seeded in the target
environment's Vendor master (see `POST /api/vendors/import-json`).
