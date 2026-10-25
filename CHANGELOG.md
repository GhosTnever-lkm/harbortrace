# Changelog

## 0.1.4 - 2026-10-25

- Redact credential-like values in HAR `request.queryString` fields as well as the request URL.
- Preserve unrelated query parameters and metadata in the scrubbed HAR export.

## 0.1.3 - 2026-10-24

- Detect camelCase and separated secret names such as `clientSecret`, `refreshToken`, and `sessionId` in scrubbed HAR exports.
- Add regression coverage confirming common credential names are removed while unrelated names remain visible.

## 0.1.2 - 2026-10-15

- Remove embedded username and password credentials from request and redirect URLs in scrubbed HAR exports.

## 0.1.1 - 2026-10-13

- Avoid argument-limit crashes when analyzing HAR files with large request counts or many hosts.
- Include the preview image in the downloadable release archive so its README renders offline.

## 0.1.0 - 2026-10-10

- First public release: local HAR import, searchable request waterfall, status/latency/size filters, host breakdown, two-capture comparison, CSV export and scrubbed HAR export.
- Added responsive interface and sample capture.
- Added automated tests for parsing, filters, aggregation, comparison, redaction, CSV and formatting.
