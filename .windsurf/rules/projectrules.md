---
trigger: always_on
---

---
trigger: always_on
---

# RULES.md — ILETSB Records Inventory (Essential Rules)

## 1) App & Storage
- Offline static app (HTML/JS/CSS). **No network calls.**
- Use **IndexedDB** (Dexie recommended).

## 2) Data Model (relationships)
- **Single `series` table** containing all record series with optional schedule assignment fields.
- AuditEvents reference: `entity = "series"`, `entity_id` = target `_id`.

## 3) Keys & Uniqueness
- `_id` is internal, auto-increment. Never trust imported `_id`s.
- `application_number` (e.g., `25-012`) **is not globally unique**; treat it as a normal field.
- Series unique by **`[application_number + item_number]`** when both are present.
- Series without schedule assignment can exist independently.

## 4) Canonical Field Rules
- **Dates:** `dates_covered_start` is **optional** (ISO `YYYY` | `YYYY-MM` | `YYYY-MM-DD`).
- **Open end:** If end is blank/"present" → store `dates_covered_end = null` and `open_ended = true`.
- **Approval status (lowercase enum):** `draft | pending | approved | superseded` (optional).
- Arrays are **arrays** (not semicolon strings): `tags[]`, `media_types[]`, `omb_or_statute_refs[]`, `related_series[]`.
- Numbers non-negative; bytes are integers.

## 5) Retention (machine + human)
- Keep both:
  - `retention` object:
    - `trigger`: `"end_of_fiscal_year" | "calendar_year_end" | "case_closed" | "superseded" | "event_based"`
    - `stages`: `[ { where: "office"|"records_center"|"system", years: number } ]`
    - `final_disposition`: `"destroy" | "transfer_archives" | "permanent"`
  - `retention_text` (human wording).
- Derive/store `retention_is_permanent = (final_disposition === "permanent")`.

## 6) Validation (save + import)
- Require: `record_series_title` only.
- `application_number` (when present) matches `^\d{2}-\d{3}$`.
- `item_number` (when present) matches `^\d+([A-Za-z]|\.\d+)?$` (supports sub-items like `100.01`).

## 7) Import / Export
- **Export:** include `series`, `audit_events`, metadata. No separate schedules array.
- **Import (upsert):**
  1) Upsert series by **`[application_number + item_number]`** when both present.
  2) For series without schedule assignment, use other natural keys or create new.
  3) Remap `audit_events.entity_id` after inserts using natural keys in payload.
  4) Normalize fields (dates, arrays, open_ended) as in these rules.

## 8) UI Guardrails
- When assigning schedule info to a series, validate `application_number` format.
- Retention editor must capture **trigger + stages + final_disposition** (with a "Permanent" quick toggle).
- Tags input → split to `tags[]`.

## 9) Audit & Timestamps
- On create/update/delete, write AuditEvent with: `entity = "series"`, `entity_id`, `action`, `actor`, `at`, and **`payload` as an object**.
- Set `created_at` once; update `updated_at` on every save.

## 10) Errors & Transactions
- Show clear errors for: duplicate `[application_number+item_number]`, bad enums/dates.
- Wrap multi-row imports in a **transaction**.

## 11) Minimal Indexes
```ts
series:       '++_id, [application_number+item_number], record_series_title, division, retention_is_permanent, dates_covered_start, application_number, *tags'
audit_events: '++_id, [entity+entity_id+at], entity, action, at'