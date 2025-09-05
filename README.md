# ILETSB Records Retention System

A modern, offline-first web application for managing records retention schedules and series for the Illinois Law Enforcement Training and Standards Board.

## Features

- **Unified Series Management**: Single table design for all record series with optional schedule assignment
- **Offline-First**: Works completely offline using IndexedDB for data storage
- **Powerful Search & Filter**: Advanced search across all fields with comprehensive filtering capabilities
- **Data Import/Export**: Easy import/export of records in JSON format
- **Audit Trail**: Complete history of all changes with timestamps and user attribution

## Data Model

The system uses a simplified data model where all records are stored in a single `series` table with the following key features:

- **Unique Identification**: Each record is uniquely identified by `[schedule_number + item_number]` when both are present
- **Flexible Date Handling**: Supports various date formats (YYYY, YYYY-MM, YYYY-MM-DD) with open-ended date ranges
- **Comprehensive Metadata**: Includes fields for retention information, approval status, media types, and more
- **Tagging System**: Flexible tagging for categorization and organization

## Getting Started

1. Clone this repository
2. Open `index.html` in a modern web browser
3. The application will automatically initialize the database

## Usage

### Adding Records
1. Click "Add New Series" 
2. Fill in the required fields (Record Series Title is mandatory)
3. Optionally assign to a schedule and add additional metadata
4. Save your changes

### Searching and Filtering
- Use the search bar to find records by any text
- Apply filters to narrow down by schedule, date range, approval status, etc.
- Sort results by any column

### Import/Export
- Export your entire database for backup or migration
- Import data from previously exported files
- The system handles merging of existing records based on natural keys

## Data Structure

### Series Fields
- `_id`: Internal auto-incrementing ID
- `record_series_title` (required)
- `schedule_number`: Format: ##-### (e.g., 25-012)
- `item_number`: Format: Number with optional letter or decimal (e.g., 1, 2A, 3.1)
- `dates_covered_start`: Optional start date
- `dates_covered_end`: End date or "present"
- `approval_status`: One of: draft, pending, approved, superseded
- `retention_text`: Free-form retention description
- `media_types[]`: Array of media types
- `tags[]`: Array of tags
- `division`: Owning division/department
- `created_at`, `updated_at`: Timestamps
- `description`: Detailed description of the series
- `ui_extras`: Additional UI-specific data

## Browser Support

The application is designed to work in all modern browsers that support:
- IndexedDB
- ES6+ JavaScript
- CSS Grid/Flexbox

## License

[Specify License Here]

## Contact

[Your Contact Information]