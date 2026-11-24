# Changelog

## 0.2.0

- Breaking: `captureContent` is removed. If `captureContent: false` or `ZOROVAL_CAPTURE_CONTENT` (env or Worker binding) is set to off, tracing stays off until you remove it. Use `redact` to clean content before it is sent.
- New: built-in redaction, off by default. `zoroval.init({ redact: "basic" })` replaces card numbers, emails, phone numbers, Aadhaar, PAN and API keys with labels. `redact: ["basic", fn]` runs it before your own function.
- `zoroval.status()` reports `redact` in place of `captureContent`.
