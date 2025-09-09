# Records Retention Inventory Dashboard

A modern, offline-first web application for managing records retention schedules and series. This system is designed for high performance, ease of use, and complete functionality without requiring a network connection.

## Key Features

-   **Unified Series Management**: A simplified, single-table design for all record series with optional schedule assignments, reflecting the core business logic.
-   **Offline-First Architecture**: The application works completely offline. All data is stored locally in the browser using IndexedDB, ensuring data availability and performance regardless of network status.
-   **Powerful Search & Filtering**: A rebuilt, high-performance search engine that leverages IndexedDB indexes. It supports multi-term text search across all relevant fields and provides comprehensive filtering by date ranges, approval status, tags, and more.
-   **Modern UI/UX**: A completely redesigned user interface with a clean, modern aesthetic, including both light and dark modes for user comfort.
-   **Data Portability**: Easy import and export of the entire database in JSON format, facilitating backups, migrations, and data sharing.
-   **Comprehensive Audit Trail**: Automatically logs all create, update, and delete actions, providing a complete history of changes with timestamps.
-   **Data Integrity & Validation**: Built-in validation rules ensure data quality upon saving and importing records.

## Technical Stack

-   **Frontend**: Vanilla HTML5, CSS3, and JavaScript (ES6+). No external frameworks are used, ensuring a lightweight and fast application.
-   **Database**: IndexedDB via the native browser API for robust, offline client-side storage.
-   **Styling**: Modern CSS with custom properties (variables) for theming, supporting both light and dark modes based on user preference.

## Getting Started

The application is designed to run directly in the browser with no build step required.

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/dcatlin7921/iletsb-records-retention-system.git
    ```
2.  **Navigate to the directory:**
    ```bash
    cd iletsb-records-retention-system
    ```
3.  **Open `index.html`:**
    Open the `index.html` file in a modern web browser (e.g., Chrome, Firefox, Edge, Safari). The application will automatically initialize the database on first launch.

## Usage Guide

### Navigating the Interface

The application is divided into three main panes:
1.  **Search & Filters (Left)**: Contains all controls for searching and filtering records. This pane can be collapsed to maximize space.
2.  **Results List (Center)**: Displays the list of records matching the current search and filter criteria.
3.  **Detail/Editor (Right)**: Shows the full details of a selected record and serves as the form for creating or editing records.

### Managing Records

-   **Create a New Record**: Click the "Admin" button in the top-right, then select "New Series Item". Fill out the form in the right-hand pane and click "Save Series Item".
-   **Edit a Record**: Select a record from the results list. Its details will appear in the right-hand pane. Make your changes and click "Save Series Item".
-   **Delete a Record**: Select a record, and the "Delete" button will appear at the bottom of the form. Deletion requires confirmation.

### Import & Export

-   **Export Data**: Click "Admin" -> "Export JSON" to download a complete backup of the database.
-   **Import Data**: Click "Admin" -> "Import JSON". The system intelligently handles "upserting" records, meaning it will update existing records (based on `schedule_number` + `item_number`) or create new ones as needed.

## Data Model

The core of the application is the `series` table in IndexedDB. Below are some key fields:

| Field                 | Type           | Description                                                                 |
| --------------------- | -------------- | --------------------------------------------------------------------------- |
| `_id`                 | `number`       | Internal auto-incrementing primary key.                                     |
| `record_series_title` | `string`       | **Required.** The official title of the record series.                      |
| `schedule_number`     | `string`       | Optional. Format: `##-###` (e.g., `25-012`).                                |
| `item_number`         | `string`       | Optional. Format: Number with optional letter/decimal (e.g., `1`, `2A`, `3.1`). |
| `approval_status`     | `string`       | Enum: `draft`, `pending`, `approved`, `superseded`.                         |
| `retention_text`      | `string`       | Free-form text describing the retention policy.                             |
| `dates_covered_start` | `string`       | Optional start date (YYYY, YYYY-MM, or YYYY-MM-DD).                         |
| `dates_covered_end`   | `string`       | End date or the literal string `"present"`.                                 |
| `media_types`         | `string[]`     | An array of media types (e.g., "paper", "electronic").                      |
| `tags`                | `string[]`     | An array of user-defined tags for categorization.                           |
| `created_at`          | `string`       | ISO 8601 timestamp for when the record was created.                         |
| `updated_at`          | `string`       | ISO 8601 timestamp for the last update.                                     |

**Note**: A record is considered unique based on the combination of `schedule_number` and `item_number`. Records without a schedule assignment can exist independently.

## Development

This project uses standard web technologies. There are no dependencies to install.

-   **Code Style**: Follow the existing code patterns in `app.js` and `style.css`.
-   **Validation**: All data validation rules are defined in the `RULES.md` file and implemented in the import and save logic.
-   **Error Handling**: A global error handler logs issues to the browser's console and stores them in `localStorage` for debugging.

## Development History

This project began as a proof-of-concept in Perplexity Labs, where an initial version was generated from a simple prompt and an example PDF of a records schedule. The initial prototype demonstrated the viability of an offline-first, browser-based records management system.

Following the successful proof-of-concept, the project was migrated to the Windsurf development environment for more advanced coding and refinement. The application has since been co-developed using a combination of AI coding assistants, including models from OpenAI (GPT series), Google (Gemini series), and Anthropic (Claude series), as well as specialized software engineering models.

The project is under active development, with the data schema and application features continuously evolving to meet organizational needs.

## Browser Support

The application is designed for modern web browsers that support:
-   IndexedDB API
-   ES6+ JavaScript features
-   CSS Custom Properties, Grid, and Flexbox

## License

Proprietary