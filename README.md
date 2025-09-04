ILETSB Records Retention Inventory

An offline-first web app for managing ILETSB’s records-series inventory and assembling those series into approved Records Retention Schedules. The app lets you draft, edit, and perfect series; export them to schedule packages; then sync approvals (application numbers & item numbers) back into the database.

Features

Offline-First: Works entirely in the browser via IndexedDB

Three-Pane UI: Filters/search • Results list • Detail editor

JSON Backup/Restore: Full export/import

Advanced Filters: Division, permanence, dates, tags, free text

Accessibility: Keyboard navigation, screen-reader labels

Audit Trail: Create/update/delete events

Data Validation: Guardrails with clear messages

What this database is (purpose)

This is a working inventory of record series for ILETSB. Staff use it to collect, edit, and refine every series (title, description, dates, retention, media, volume, contacts, notes). When ready, selected series are exported into an official Records Retention Schedule. After approval, the schedule’s application number (e.g., 25-012) and the official item numbers are synced back so the inventory reflects the approved record.

Data Model (summary)
Schedules (1) ────< (many) SeriesItems
         \
          \───< AuditEvents   (also used for SeriesItems)


A Schedule is the approved rulebook (e.g., application “25-012”).

A SeriesItem is one approved row (item “1”, “2”, …) on that schedule.

AuditEvents capture who changed what and when.

See full field reference in Record Retention DB Schema (v2) below.

Getting Started

Open index.html in a Chromium-based browser (Chrome/Edge).

The app initializes IndexedDB and (optionally) loads sample data.

Create a Schedule (draft is fine; application number can be added after approval).

Add Series Items by selecting an existing schedule from the UI (don’t free-type schedule numbers).

Use filters/search to find items; click a result to view/edit details.

Important: Series are linked by schedule_id (the schedule’s internal _id). You should not create series by free-typing a schedule number—pick the schedule from the list so the relationship stays correct.

Import / Export
Export

Click Export JSON.

A file like iletsb-records-backup-YYYY-MM-DD.json downloads.

It includes schedules, series_items, and audit_events.

Export format

{
  "exported_at": "2025-09-02T11:00:00-05:00",
  "version": 2,
  "agency": {
    "name": "Illinois Law Enforcement Training and Standards Board",
    "abbrev": "ILETSB"
  },
  "schedules": [...],
  "series_items": [...],
  "audit_events": [...]
}

Import (how upserts work)

Click Import JSON and choose a valid backup.

The app validates the file and shows a summary.

Schedules

If application_number exists, we upsert by application_number.

If it’s a draft (no application_number), we create a new schedule.

Series Items

The importer first builds a map of old ⇒ new schedule_id by matching schedule application_number (or newly created IDs for drafts).

Then it upserts series by the composite key [schedule_id + item_number].

If a conflict exists (same item_number for the same schedule), the record is updated.

Audit Events

Imported as additional history entries (internal _ids are regenerated).

Notes

Internal numeric _ids are not portable across machines; the importer ignores incoming _id and creates fresh ones.

For drafts with no application_number, the importer treats them as new schedules unless you enable an optional “merge by title” mode (if/when implemented).

Search & Filtering

Free Text: Titles, descriptions, retention text

Schedule: Pick a schedule (shows drafts & approved)

Division: Filter by organizational division

Retention: Permanent vs time-limited

Dates: Approval dates (schedules) and coverage dates (series)

Tags: Multi-select (schedule tags)

Key Limitations

Technical

Chromium browser required (Chrome/Edge latest)

IndexedDB storage quotas apply (~1GB+, browser-dependent)

Single-user, no live sync

Data

Agency is ILETSB-specific (no multi-tenancy)

Division/Contact/Location are simple text fields (not normalized)

Functional

PDF content is referenced, not stored

No version branching (history via audit log only)

Reporting is limited to exports for now

Resetting the Database

Complete reset

DevTools → Application/Storage

IndexedDB → ILETSBRecords → Delete database

Refresh the page

Selective reset

Import a minimal JSON file, or

Delete individual records in the UI

Advanced Details
Validation (high-level)

approval_status is a lowercase enum: draft | submitted | approved | superseded | denied.

application_number matches ^\d{2}-\d{3}$ when present (drafts may be null).

item_number supports integers (extend to sub-items later if needed).

Coverage dates are ISO; for ongoing series, set dates_covered_end = null and open_ended = true.

Structured retention is required:

trigger enum (e.g., end_of_fiscal_year, calendar_year_end, case_closed)

stages[] like { where: "office" | "records_center" | "system", years: number }

final_disposition is one of destroy | transfer_archives | permanent

retention_is_permanent can be derived but is kept for fast filters

Arrays only (no semicolon strings) for tags, media_types, omb_or_statute_refs, related_series.

Performance

Indexed queries (Dexie/IndexedDB)

Debounced search (≈300ms)

Virtualized lists for 1k+ rows

Privacy/Security

Local only—no network calls

No analytics or trackers

Full audit trail kept locally

File Structure
iletsb-records-inventory/
├── index.html          # App shell
├── style.css           # Styles
├── app.js              # Core logic (DB, import/export, audit, UI glue)
├── README.md           # This document
└── sample-data.json    # Optional sample dataset


(If you split UI into separate modules like app-ui.js, update this tree accordingly.)

Record Retention DB Schema (v2)

Dexie definition

db.version(2).stores({
  schedules: '++_id, application_number, approval_status, approval_date, *tags',
  series_items: '++_id, schedule_id, [schedule_id+item_number], division, record_series_title, retention_is_permanent',
  audit_events: '++_id, [entity+entity_id+at], entity, action, at'
});

schedules

PK: ++_id

Unique: application_number (when present)

Indexes: approval_status, approval_date, tags (multiEntry)

Fields:
_id, application_number (nullable for drafts), application_title, approving_body, approval_status, approval_date, retention_statement_global, notes, source_pdf_name, source_pdf_url, source_pdf_page_count, tags[], created_at, updated_at.

series_items

PK: ++_id

FK: schedule_id → schedules._id

Composite unique: [schedule_id + item_number]

Indexes: schedule_id, division, record_series_title, retention_is_permanent

Fields:
_id, schedule_id, application_number (optional display), item_number, record_series_title, description, dates_covered_start, dates_covered_end|null, open_ended, arrangement, division, contact, location,
retention { trigger, stages[], final_disposition }, retention_text, retention_is_permanent,
volume_paper_cuft, volume_electronic_bytes, annual_accum_paper_cuft, annual_accum_electronic_bytes,
media_types[], electronic_records_standard, number_size_files, index_or_finding_aids,
omb_or_statute_refs[], related_series[],
audit_hold_required, litigation_hold_required,
representative_name, representative_title, representative_phone,
records_officer_name, records_officer_phone, series_notes,
created_at, updated_at.

audit_events

PK: ++_id

Compound index: [entity + entity_id + at]

Fields:
_id, entity ("schedule" | "series"), entity_id, action ("create" | "update" | "delete"), actor, at, payload (JSON string).

Version History

v2.0 (2025-09-04)

Real FK series_items.schedule_id

Composite unique [schedule_id + item_number]

Removed duplicate fields (schedule_number, series_number)

Structured retention object; retention_text kept for humans

tags is multiEntry; list-type fields are arrays

Importer upserts schedules by application_number and series by [schedule_id + item_number]

v1.0 (2025-09-02)

Initial release (three-pane UI, IndexedDB, JSON import/export, search, audit, accessibility)

Common Queries (examples)

Get all series for a schedule

const schedule = await db.schedules.get({ application_number: '25-012' });
const series = await db.series_items.where('schedule_id').equals(schedule._id).toArray();


Insert a series with uniqueness check

await db.series_items.add({
  schedule_id,
  item_number: '1',
  record_series_title: 'Officer Training Rosters',
  /* ... */
}); // throws if [schedule_id + item_number] exists


Fetch audit history (ordered)

const history = await db.audit_events
  .where('[entity+entity_id+at]')
  .between(['series', id, Dexie.minKey], ['series', id, Dexie.maxKey])
  .toArray();