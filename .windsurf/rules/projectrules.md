---
trigger: always_on
---

# RULES.md — ILETSB Records Inventory (Essential Rules)

## 1) App & Storage
- Offline static app (HTML/JS/CSS). **No network calls.**
- Use **IndexedDB** (Dexie recommended).

## 2) Data Model (relationships)
- **One Schedule → many SeriesItems.**
- SeriesItems **must** store `schedule_id` → `schedules._id` (numeric FK).
- AuditEvents reference either: `entity ∈ {"schedule","series"}`, `entity_id` = target `_id`.

## 3) Keys & Uniqueness
- `_id` is internal, auto-increment. Never trust imported `_id`s.
- Each schedule has a stable **`schedule_uid` (UUID)** — unique, exported, and used for import matching.
- `application_number` (e.g., `25-012`) **is not globally unique**; treat it as a normal field.
- SeriesItems unique per schedule by **`[schedule_id + item_number]`**.

## 4) Canonical Field Rules
- **Dates:** `dates_covered_start` is **required** (ISO `YYYY` | `YYYY-MM` | `YYYY-MM-DD`).
- **Open end:** If end is blank/“present” → store `dates_covered_end = null` and `open_ended = true`.
- **Approval status (lowercase enum):** `draft | pending | approved | superseded`.
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
- Require: `schedule_id`, `item_number`, `record_series_title`, `dates_covered_start`.
- `application_number` (when present) matches `^\d{2}-\d{3}$`.
- `item_number` matches `^\d+([A-Za-z]|\.\d+)?$` (supports sub-items like `100.01`).
- Block save if FK `schedule_id` is missing.

## 7) Import / Export
- **Export:** include `schedules`, `series_items`, `audit_events`, metadata, and **`schedule_uid`**. Ignore `_id` portability.
- **Import (upsert):**
  1) Match/insert schedules by **`schedule_uid`** (not `application_number`).
  2) Build `schedule_uid → schedule._id` map; set each series’ `schedule_id` before insert.
  3) Upsert series by **`[schedule_id + item_number]`**.
  4) Remap `audit_events.entity_id` after inserts using natural keys in payload.
  5) Normalize fields (dates, arrays, open_ended) as in these rules.

## 8) UI Guardrails
- When creating a series, **select** a schedule (don’t free-type numbers). Bind to `schedule_id`.
- Retention editor must capture **trigger + stages + final_disposition** (with a “Permanent” quick toggle).
- Tags input → split to `tags[]`.

## 9) Audit & Timestamps
- On create/update/delete, write AuditEvent with: `entity`, `entity_id`, `action`, `actor`, `at`, and **`payload` as an object**.
- Set `created_at` once; update `updated_at` on every save.

## 10) Errors & Transactions
- Show clear errors for: duplicate `[schedule_id+item_number]`, bad enums/dates, missing FK.
- Wrap multi-row imports in a **transaction**.

## 11) Minimal Indexes
```ts
schedules:    '++_id, &schedule_uid, application_number, approval_status, approval_date, *tags'
series_items: '++_id, schedule_id, [schedule_id+item_number], record_series_title, division, retention_is_permanent, dates_covered_start'
audit_events: '++_id, [entity+entity_id+at], entity, action, at'
