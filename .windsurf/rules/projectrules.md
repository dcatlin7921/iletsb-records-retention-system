---
trigger: always_on
---

# RULES.md — ILETSB Records Inventory (Essential Rules)

## 1) App & Storage
- Offline static app (HTML/JS/CSS). **No network calls.**
- Use **IndexedDB** (Dexie recommended).

## 2) Data Model (relationships)
- **Data is stored in a single `series` table** containing all record series with optional **Schedule** assignment fields.
- **For user convenience, the UI may present a "Schedule View" that allows for editing schedule-related fields (`approval_status`, `approval_date`, etc.) in one place. Actions taken in this view MUST apply the changes to all series records sharing the same `schedule_number` within a single database transaction.**
- AuditEvents reference: `entity = "series"`, `entity_id` = target `_id`.

## 3) Keys & Uniqueness
- `_id` is internal, auto-increment. Never trust imported `_id`s.
- `schedule_number` (e.g., `25-012`) **is not globally unique**; treat it as a normal field.
- Series unique by **`[schedule_number + item_number]`** when both are present.
- Series without schedule assignment can exist independently.

## 4) Canonical Field Rules
- **Dates:** `dates_covered_start` is **optional** (ISO `YYYY` | `YYYY-MM` | `YYYY-MM-DD`).
- **Coverage end:** `dates_covered_end` may be a literal string such as `"present"`; **do not** derive `open_ended` and **do not** null it.
- **Approval status (lowercase enum):** `draft | pending | approved | superseded` (optional).
- Arrays are **arrays** (not semicolon strings): `tags[]`, `media_types[]`, `omb_or_statute_refs[]`, `related_series[]`.
- Numbers non-negative; bytes are integers.

## 5) Retention
- **The primary field for retention is `retention_text`.**
- **To support data entry, the following optional, structured fields may also be captured: `retention_term` (number) and `retention_trigger` (string).**
- **The application MUST NOT derive a retention status (e.g. "permanent") from these fields for display or filtering.**

## 6) Validation (save + import)
- Require: `record_series_title` only.
- `schedule_number` (when present) must match `^\d{2}-\d{3}`.
- `item_number` (when present) should match `^\d+([A-Za-z]|\.\d+)?`.

## 7) Import / Export
- **Export:** include `series`, `audit_events`, metadata. No separate schedules array. The export should be a full dump of the database.
- **Import (upsert):**
  1) Upsert series by **`[schedule_number + item_number]`** when both present.
  2) For series without schedule assignment, use other natural keys or create new.
  3) Remap `audit_events.entity_id` after inserts using natural keys in payload.
  4) Normalize arrays (split on commas/semicolons/newlines). **Do not** synthesize `open_ended` and do not rewrite `"present"`.
- **Legacy imports:** if a record uses `application_number`, map it to `schedule_number` during import.
- **Post-import counters:** display **`N schedules, M series`**, where schedules = **unique non-blank `schedule_number`** values.

## 8) UI Guardrails
- When assigning **Schedule Number** to a series, validate `schedule_number` format.
- Tags input (and other list-like text inputs) → split to arrays for storage.
- **The UI must not contain logic or flags derived from retention fields (e.g., "Permanent," "Time-Limited"). Retain and display entered data as-is.**
- **The form shall include a "Clone Record" button. When clicked, this button will populate a new, unsaved form with the data from the currently selected record. It does not clear any fields and does not save the record automatically.**

## 9) Audit & Timestamps
- On create/update/delete, write AuditEvent with: `entity = "series"`, `entity_id`, `action`, `actor`, `at`, and **`payload` as an object**.
- Set `created_at` once; update `updated_at` on every save.

## 10) Errors & Transactions
- Show clear errors for: duplicate `[schedule_number+item_number]`, bad enums/dates.
- Wrap multi-row imports and any schedule-wide bulk updates in a **transaction**.

## 11) Minimal Indexes
```ts
series:       '++_id, [schedule_number+item_number], record_series_title, division, schedule_number, dates_covered_start, *tags'
audit_events: '++_id, [entity+entity_id+at], entity, action, at'