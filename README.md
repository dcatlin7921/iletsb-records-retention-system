# ILETSB Records Retention Inventory

A comprehensive offline-first web application for managing Illinois Law Enforcement Training & Standards Board (ILETSB) records retention inventory that maps to approved Record Retention Schedules.

## Features

- **Offline-First Design**: Works completely offline using IndexedDB for local storage
- **Three-Pane Interface**: Search/filters, results list, and detail editor
- **JSON Backup/Restore**: Export and import all data as JSON files
- **Advanced Search & Filtering**: Search across multiple fields with real-time results
- **Accessibility Compliant**: Full keyboard navigation and screen reader support
- **Audit Trail**: Complete logging of all create/update/delete operations
- **Data Validation**: Comprehensive form validation with helpful error messages

## Data Model Summary

### Object Stores

#### 1. Schedules
- **Purpose**: Track record retention schedules and their approval status
- **Key Fields**: 
  - `application_number` (e.g., "19-022") - External identifier for linkage
  - `application_title` - Human-readable title
  - `approval_status` - draft|pending|approved|superseded
  - `approval_date` - When schedule was approved
  - `retention_statement_global` - Overall retention policy
  - `source_pdf_name`, `source_pdf_url` - Reference documents
- **Indexes**: application_number, approval_status, approval_date

#### 2. Series Items
- **Purpose**: Individual record series within schedules
- **Key Fields**:
  - `application_number` - Links to parent schedule
  - `item_number` - Series identifier (e.g., "100.01")
  - `record_series_title` - Name of the record series
  - `retention_text` - Detailed retention instructions
  - `retention_term` - Number of years (if not permanent)
  - `retention_is_permanent` - Boolean flag for permanent records
  - `volume_paper_cuft`, `volume_electronic_bytes` - Storage volume metrics
  - `division`, `contact`, `location` - Organizational information
- **Indexes**: application_number, item_number, division, retention_is_permanent, retention_term, record_series_title

#### 3. Audit Events
- **Purpose**: Track all user actions for accountability
- **Fields**: entity (schedule|series), entity_id, action, actor, timestamp, payload

## How to Use Import/Export

### Export Data
1. Click the "Export JSON" button in the top navigation
2. Browser will download a complete backup file named `iletsb-records-backup-YYYY-MM-DD.json`
3. File contains all schedules, series items, and audit events

### Import Data
1. Click "Import JSON" button and select a valid backup file
2. System validates the file format and shows import summary
3. Data is upserted based on `(application_number, item_number)` combinations
4. Existing records are updated; new records are created with fresh internal keys
5. Import process is logged in audit trail

### JSON Format Structure
```json
{
  "exported_at": "2025-09-02T11:00:00-05:00",
  "version": 1,
  "agency": {
    "name": "Illinois Law Enforcement Training and Standards Board",
    "abbrev": "ILETSB"
  },
  "schedules": [...],
  "series_items": [...],
  "audit_events": [...]
}
```

## Getting Started

### Basic Usage
1. Open `index.html` in Chrome or Edge browser
2. Application initializes with sample data for demonstration
3. Use "New Schedule" to create retention schedules
4. Use "New Series Item" to add record series to schedules
5. Use search and filters to find specific records
6. Click any result to view/edit in the detail pane

### Creating Records
1. **New Schedule**: Creates a schedule record where you can later assign the official application number
2. **New Series Item**: Select an existing application number or enter a new one to create associated record series

### Search and Filtering
- **Free Text Search**: Searches across record titles, descriptions, and retention text
- **Application Number**: Filter by specific schedule
- **Division**: Filter by organizational division
- **Retention Type**: Filter permanent vs. time-limited records
- **Date Ranges**: Filter by approval dates or coverage dates
- **Combined Filters**: All filters work together with AND logic

## Key Limitations

### Technical Constraints
- **Browser Compatibility**: Requires Chrome or Edge (latest versions)
- **Storage Limit**: Subject to browser IndexedDB quotas (typically 1GB+)
- **Single User**: Designed for single-user operation, no collaboration features
- **No Server Sync**: Pure offline application, no network synchronization

### Data Constraints
- **Agency Fixed**: Application is specifically for ILETSB only
- **No Multi-tenancy**: Cannot manage records for multiple agencies
- **Simple Relationships**: Division/Contact/Location stored as text fields, not normalized

### Functional Limitations
- **PDF Storage**: Can reference PDF files but doesn't store actual file content
- **No Version Control**: Updates overwrite previous versions (except via audit log)
- **Limited Reporting**: No built-in report generation beyond export

## How to Reset Database

### Complete Reset
1. Open browser Developer Tools (F12)
2. Go to Application/Storage tab
3. Find IndexedDB → ILETSBRecords
4. Right-click and "Delete database"
5. Refresh the page to reinitialize with sample data

### Selective Reset
- Use the import function with an empty or minimal JSON file
- Delete individual records using the detail editor
- Use browser's IndexedDB inspector to manually remove specific records

## Advanced Features

### Form Validation
- **Date Formats**: Accepts YYYY or full ISO dates (YYYY-MM-DD)
- **Mutual Exclusivity**: Permanent retention and term years cannot both be set
- **Numeric Formatting**: Automatically strips commas from numbers
- **Required Fields**: Validates essential fields before saving

### Accessibility Features
- **Keyboard Navigation**: Full Tab/Shift+Tab support
- **Shortcuts**: Enter to save, Escape to cancel
- **Screen Readers**: Proper ARIA labels and descriptions
- **Focus Management**: Visual focus indicators throughout interface

### Performance Optimizations
- **Virtual Scrolling**: Handles 1000+ records efficiently
- **Indexed Queries**: Uses IndexedDB indexes for fast filtering
- **Debounced Search**: 300ms delay prevents excessive queries
- **Lazy Loading**: Detail forms only load when item is selected

## Data Privacy and Security

- **Local Only**: All data stored locally in browser, never transmitted
- **No Analytics**: No tracking or external analytics
- **Audit Trail**: Complete record of all user actions
- **Data Integrity**: Validation prevents corrupt data entry

## Troubleshooting

### Common Issues
1. **Application Won't Load**: Clear browser cache and refresh
2. **Import Fails**: Verify JSON file format matches export structure
3. **Search Not Working**: Check that IndexedDB is supported and enabled
4. **Performance Issues**: Close other browser tabs, clear browser data

### Browser Requirements
- JavaScript enabled
- IndexedDB support
- Local file access (for import/export)
- Minimum 1920×1080 screen resolution recommended

## File Structure

```
iletsb-records-inventory/
├── index.html          # Main application file
├── style.css           # Application styles
├── app.js              # Core application logic
├── README.md           # This documentation
└── sample-data.json    # Sample data for testing
```

## Version History

- **v1.0** (2025-09-02): Initial release with full feature set
  - Three-pane interface
  - IndexedDB storage
  - JSON import/export
  - Comprehensive search and filtering
  - Audit trail
  - Accessibility compliance