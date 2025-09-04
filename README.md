# ILETSB Records Retention Inventory

![Records Retention System](https://via.placeholder.com/1200x300?text=ILETSB+Records+Retention+System)

[![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat-square&logo=html5&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/Guide/HTML/HTML5)
[![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat-square&logo=css3&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/CSS)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-square&logo=javascript&logoColor=black)](https://developer.mozilla.org/en-US/docs/Web/JavaScript)
[![IndexedDB](https://img.shields.io/badge/IndexedDB-4B32C3?style=flat-square&logo=datacamp&logoColor=white)](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)

A powerful offline web application for managing records retention schedules and series for the Illinois Law Enforcement Training and Standards Board (ILETSB).

## Overview

This app is designed to help ILETSB manage their records inventory with detailed schedules and series items. It's built as a **static HTML/JS/CSS app** that works entirely offline using **IndexedDB** for data storage, ensuring security and accessibility without network dependency.

### Key Features

- **Three-Pane Interface**: Intuitive layout for schedules, series, and details.
- **Advanced Filtering**: Search and filter by tags, retention policies, or date ranges.
- **Data Management**: Import/export JSON data and track changes with an audit log.
- **Offline First**: Fully functional without internet; data persists in the browser.
- **Modern UI**: Clean, accessible design with light/dark mode support and ARIA attributes.
- **Performance**: Optimized with debounced search inputs and virtual scrolling for thousands of records.

## Technical Highlights

- **IndexedDB with Dexie.js**: Efficient local storage with proper indexing for fast queries.
- **Data Integrity**: Enforces relational constraints (schedule-to-series) and field validation per spec.
- **Retention Model**: Structured retention objects (trigger, stages, disposition) alongside human-readable text.
- **Schedule-First Design**: All data is organized around schedule numbers with proper foreign key relationships.

## Installation

1. Clone this repository:
   ```bash
   git clone https://github.com/dcatlin7921/iletsb-records-retention-system.git
   ```
2. Navigate to the project directory:
   ```bash
   cd iletsb-records-retention-system
   ```
3. Open `index.html` in a modern browser to run the app locally.

## Usage

- Use the **Admin menu** to import existing data or create new schedules and series items.
- Filter by schedule number, division, or other criteria in the left pane.
- View series items in the middle pane and edit details on the right.
- Export your data at any time to preserve changes.

## Contributing

Contributions are welcome! If you'd like to contribute to this project, please follow these steps:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature/YourFeature`).
3. Make your changes and commit them (`git commit -m 'Add some feature'`).
4. Push to the branch (`git push origin feature/YourFeature`).
5. Open a pull request.

Please ensure your code adheres to the existing style and includes appropriate comments.

## Feedback

I built this to solve a real-world problem of managing complex records retention data in a secure, offline environment. I'm particularly proud of the data model adherence and the smooth UX despite the offline constraint.

I'd love feedback on the code, architecture, or potential improvements. If you're interested in offline web apps or records management solutions, let's discuss! Open an issue or reach out directly.

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.