# BAM Check

Scan a food's barcode; see its fat against a daily budget. Built for bile acid
malabsorption (BAM), where dietary fat is the main lever. A static web app
(PWA) - no build step, no backend, no account. All personal data stays in the
phone's `localStorage`; only the barcode number is sent to look a food up.

## Run it

```
node tools/serve.mjs 5173      # then open http://localhost:5173
node --test tests/*.test.mjs   # 45 logic tests, no dependencies
node tools/make-icons.mjs      # regenerate icons/
```

The camera needs HTTPS (localhost is exempt). To use it on an iPhone the site
must be served over HTTPS, then "Add to Home Screen".

## How it decides

`lib/score.js` is the only place that says green / amber / red. Rules:

* **No daily fat budget entered = numbers only, no colour.** The targets must
  come from her doctor/dietitian; nothing is hardcoded.
* Green needs a known fat number, and every check she has switched on must
  have actually run. Missing/doubtful data is grey or amber, never green.
* Fat per portion is judged as a share of the daily budget (default: green up
  to 10%, amber up to 25%, adjustable) **and** against what is left today.
* Words on her *avoid* list force red; *watch* words force at least amber.
* Numbers she types in from the pack (when the databases have no fat figure, or
  the wrong one) are saved per barcode on the phone and count as label data.
* Never green: unverified community data (Open Food Facts entries nobody has
  ticked as checked), records whose own quality checks flag the nutrition
  numbers, disagreeing databases, ingredient lists in another language when
  she has word lists, and a child-size serving until she sets her own portion.

## Data

* USDA FoodData Central (branded, manufacturer label data). Needs an API key;
  paste it in Settings. The shared `DEMO_KEY` allows only a few lookups an hour.
  USDA is searched, not looked up directly, and it stores the SAME barcode in
  five spellings (measured on 750 records: 12 digits 77%, 14 digits 11%, 13
  digits 9%, 11 digits 2% = a UPC-A with its check digit dropped, 8 digits 1%).
  `lib/gtin.js` builds every spelling and `pickUsdaMatch` only accepts
  leading-zero variants (plus the exact check-digit-less form), never anything
  looser. Searching only the 14-digit form found about 1 record in 10.
* Open Food Facts (crowd-sourced). Trust comes from its `checked` flag. Note the
  placeholder barcode 012345678905 is filed under changing junk products.

## Layout

`app.js` UI · `lib/gtin.js` barcode validation/normalising (UPC-E, check digits)
· `lib/lookup.js` sources, sanity checks, merge · `lib/score.js` verdict ·
`lib/scanner.js` camera + photo decoding + ZXing WebAssembly (`vendor/`) ·
`lib/manual.js` typed-in label numbers · `lib/store.js` on-device storage · `sw.js` offline app shell · `tests/` unit tests + fixtures.

Not medical advice.
