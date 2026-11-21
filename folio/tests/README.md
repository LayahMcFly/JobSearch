# Folio tests

Run from the repo root (needs Node and Playwright with Chromium; poppler's `pdftotext`/`pdfinfo` for the print tests):

    node folio/tests/folio.test.cjs
    FOLIO_OLD=/path/to/folio-v1.0.0/index.html node folio/tests/folio.test.cjs   # also runs the v1.0.0 data and backup compatibility test
    ONLY=contrast node folio/tests/folio.test.cjs                                 # run tests whose name contains "contrast"

`folio/tests/last-run.json` holds the last result list.

Form-service replies in these tests are simulated. They prove how Folio reads a reply, not that a real
Formspree or Web3Forms account delivers anything.
