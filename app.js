// ILETSB Records Retention Inventory Application
// IndexedDB-based offline records management system

/**
 * Application constants
 */
const APP_CONSTANTS = {
    DB_NAME: 'ILETSBRecords',
    DB_VERSION: 2,
    VIRTUAL_SCROLL_ITEM_HEIGHT: 80,
    VIRTUAL_SCROLL_BUFFER: 5,
    SEARCH_DEBOUNCE_MS: 300,
    COMPLETENESS_THRESHOLDS: {
        EXCELLENT: 90,
        GOOD: 75,
        FAIR: 60
    },
    ERROR_TYPES: {
        DATABASE: 'DATABASE_ERROR',
        VALIDATION: 'VALIDATION_ERROR',
        IMPORT: 'IMPORT_ERROR',
        EXPORT: 'EXPORT_ERROR',
        NETWORK: 'NETWORK_ERROR'
    },
    APPROVAL_STATUS: {
        DRAFT: 'draft',
        PENDING: 'pending',
        APPROVED: 'approved',
        SUPERCEDED: 'superseded'
    }
};

/**
 * Error handling utility
 */
class ErrorHandler {
    static log(error, context = '', type = APP_CONSTANTS.ERROR_TYPES.DATABASE) {
        const errorInfo = {
            timestamp: new Date().toISOString(),
            type,
            context,
            message: error && error.message ? error.message : (error || 'Unknown error'),
            stack: error && error.stack ? error.stack : undefined
        };
        
        // Store error in localStorage for debugging
        try {
            const errors = JSON.parse(localStorage.getItem('iletsb_errors') || '[]');
            errors.push(errorInfo);
            // Keep only last 50 errors
            if (errors.length > 50) errors.splice(0, errors.length - 50);
            localStorage.setItem('iletsb_errors', JSON.stringify(errors));
        } catch (e) {
            // Fallback if localStorage is full
        }
        
        // Only log to console in development
        if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
            console.error(`[${type}] ${context}:`, error);
        }
        
        return errorInfo;
    }
    
    static getStoredErrors() {
        try {
            return JSON.parse(localStorage.getItem('iletsb_errors') || '[]');
        } catch {
            return [];
        }
    }
    
    static clearStoredErrors() {
        localStorage.removeItem('iletsb_errors');
    }
}

/**
 * Input sanitization utility
 */
class InputSanitizer {
    static sanitizeText(input) {
        if (typeof input !== 'string') return input;
        return input
            .replace(/[<>"'&]/g, (match) => {
                const entities = {
                    '<': '&lt;',
                    '>': '&gt;',
                    '"': '&quot;',
                    "'": '&#x27;',
                    '&': '&amp;'
                };
                return entities[match];
            })
            .trim();
    }
    
    static sanitizeNumber(input) {
        const num = parseFloat(input);
        return isNaN(num) ? 0 : num;
    }
    
    static sanitizeDate(input) {
        if (!input) return '';
        const date = new Date(input);
        return isNaN(date.getTime()) ? '' : input;
    }
}

/**
 * Safe DOM manipulation utility
 */
class DOMHelper {
    static clearElement(element) {
        if (!element) return;
        while (element.firstChild) {
            element.removeChild(element.firstChild);
        }
    }
    
    static createOption(value, text) {
        const option = document.createElement('option');
        option.value = InputSanitizer.sanitizeText(value);
        option.textContent = InputSanitizer.sanitizeText(text);
        return option;
    }
    
    static setTextContent(element, text) {
        if (!element) return;
        element.textContent = InputSanitizer.sanitizeText(text);
    }
}

class ILETSBApp {
    constructor() {
        this.db = null;
        this.dbName = APP_CONSTANTS.DB_NAME;
        this.dbVersion = 3; // Increment for merged model
        this.currentSchedule = null;
        this.currentSeriesItem = null;
        this.searchTimeout = null;
        this.schedules = [];
        this.seriesItems = [];
        this.filteredItems = [];
        this.selectedItemId = null;
        
        this.init();
    }

    async init() {
        try {
            await this.initDatabase();
            await this.loadSampleData();
            this.initEventListeners();
            this.restoreSearchPaneState();
            this.updateUI();
            this.setStatus('Ready');
        } catch (error) {
            ErrorHandler.log(error, 'App initialization');
            this.setStatus('Error initializing application: ' + error.message, 'error');
        }
    }

    // Database Management
    async initDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, this.dbVersion);

            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                this.db = request.result;
                resolve();
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                const oldVersion = event.oldVersion;

                // Migration to merged series model (v3)
                if (oldVersion < 3) {
                    // Remove old schedules table if it exists
                    if (db.objectStoreNames.contains('schedules')) {
                        db.deleteObjectStore('schedules');
                    }
                    
                    // Rename series_items to series and update schema
                    if (db.objectStoreNames.contains('series_items')) {
                        db.deleteObjectStore('series_items');
                    }
                }

                // Create new merged series object store
                if (!db.objectStoreNames.contains('series')) {
                    const seriesStore = db.createObjectStore('series', { keyPath: '_id', autoIncrement: true });
                    seriesStore.createIndex('application_number_item_number', ['application_number', 'item_number'], { unique: false });
                    seriesStore.createIndex('record_series_title', 'record_series_title', { unique: false });
                    seriesStore.createIndex('division', 'division', { unique: false });
                    seriesStore.createIndex('retention_is_permanent', 'retention_is_permanent', { unique: false });
                    seriesStore.createIndex('dates_covered_start', 'dates_covered_start', { unique: false });
                    seriesStore.createIndex('application_number', 'application_number', { unique: false });
                    seriesStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });
                }

                // Legacy migration support for older versions
                if (oldVersion > 0 && oldVersion < 3) {
                    // Create schedules object store for migration
                    if (!db.objectStoreNames.contains('schedules')) {
                        const scheduleStore = db.createObjectStore('schedules', { autoIncrement: true });
                        scheduleStore.createIndex('schedule_number', 'schedule_number', { unique: true });
                        scheduleStore.createIndex('approval_status', 'approval_status', { unique: false });
                        scheduleStore.createIndex('approval_date', 'approval_date', { unique: false });
                    }

                    // Create series_items object store for migration
                    if (!db.objectStoreNames.contains('series_items')) {
                        const seriesStore = db.createObjectStore('series_items', { autoIncrement: true });
                        seriesStore.createIndex('schedule_id', 'schedule_id', { unique: false });
                        seriesStore.createIndex('schedule_item', ['schedule_id', 'item_number'], { unique: true });
                        seriesStore.createIndex('division', 'division', { unique: false });
                        seriesStore.createIndex('record_series_title', 'record_series_title', { unique: false });
                    }
                }

                // Create audit_events object store
                if (!db.objectStoreNames.contains('audit_events')) {
                    const auditStore = db.createObjectStore('audit_events', { autoIncrement: true });
                    auditStore.createIndex('entity_action_date', ['entity', 'entity_id', 'at'], { unique: false });
                    auditStore.createIndex('entity', 'entity', { unique: false });
                    auditStore.createIndex('action', 'action', { unique: false });
                    auditStore.createIndex('at', 'at', { unique: false });
                } else if (oldVersion < 2) {
                    // Migration for existing audit_events store
                    const transaction = event.target.transaction;
                    const auditStore = transaction.objectStore('audit_events');
                    
                    // Add new compound index
                    try { auditStore.createIndex('entity_action_date', ['entity', 'entity_id', 'at'], { unique: false }); } catch (e) {}
                }
            };
        });
    }

    async loadSampleData() {
        // Sample data loading has been disabled to prevent automatic data population
        // If you need sample data, use the import functionality instead
        return;
    }

    

    // Database Operations
    async getAllSchedules() {
        // Legacy method - now returns unique schedule info from series
        const series = await this.getAllSeries();
        const scheduleMap = new Map();
        
        series.forEach(item => {
            if (item.application_number) {
                const key = item.application_number;
                if (!scheduleMap.has(key)) {
                    scheduleMap.set(key, {
                        _id: `sched_${key}`,
                        schedule_number: item.application_number,
                        application_number: item.application_number,
                        approval_status: item.approval_status,
                        approval_date: item.approval_date,
                        division: item.division,
                        notes: item.notes,
                        tags: item.tags || []
                    });
                }
            }
        });
        
        return Array.from(scheduleMap.values());
    }

    async getAllSeriesItems() {
        // Legacy method - now returns all series
        return this.getAllSeries();
    }

    async getAllSeries() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async saveSchedule(schedule, isUpdate = false) {
        // Legacy method - now updates all series with matching application_number
        const series = await this.getAllSeries();
        const matchingSeries = series.filter(s => s.application_number === schedule.schedule_number);
        
        const promises = matchingSeries.map(seriesItem => {
            // Update schedule fields on the series item
            seriesItem.application_number = schedule.schedule_number;
            seriesItem.approval_status = schedule.approval_status;
            seriesItem.approval_date = schedule.approval_date;
            seriesItem.division = schedule.division || seriesItem.division;
            seriesItem.notes = schedule.notes;
            seriesItem.tags = schedule.tags || seriesItem.tags;
            
            return this.saveSeries(seriesItem, true);
        });
        
        await Promise.all(promises);
        return schedule;
    }

    async saveSeriesItem(item, isUpdate = false) {
        // Legacy method - now calls saveSeries
        return this.saveSeries(item, isUpdate);
    }

    async saveSeries(item, isUpdate = false) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readwrite');
            const store = transaction.objectStore('series');
            
            const now = new Date().toISOString();
            if (!isUpdate) {
                item.created_at = now;
            }
            item.updated_at = now;
            
            const request = isUpdate ? store.put(item) : store.add(item);
            
            request.onsuccess = () => {
                const id = request.result;
                item._id = id;
                this.logAuditEvent('series', id, isUpdate ? 'update' : 'create', { 
                    application_number: item.application_number,
                    item_number: item.item_number,
                    record_series_title: item.record_series_title
                });
                resolve(item);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSchedule(id) {
        // Legacy method - now removes schedule assignment from all matching series
        const series = await this.getAllSeries();
        const scheduleNumber = id.replace('sched_', '');
        const matchingSeries = series.filter(s => s.application_number === scheduleNumber);
        
        const promises = matchingSeries.map(seriesItem => {
            // Remove schedule assignment fields
            delete seriesItem.application_number;
            delete seriesItem.approval_status;
            delete seriesItem.approval_date;
            
            return this.saveSeries(seriesItem, true);
        });
        
        await Promise.all(promises);
        this.logAuditEvent('series', id, 'schedule_unassigned', { schedule_number: scheduleNumber });
    }

    async deleteSeriesItem(id) {
        // Legacy method - now calls deleteSeries
        return this.deleteSeries(id);
    }

    async deleteSeries(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readwrite');
            const store = transaction.objectStore('series');
            const request = store.delete(id);
            
            request.onsuccess = () => {
                this.logAuditEvent('series', id, 'delete', {});
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async logAuditEvent(entity, entityId, action, payload) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['audit_events'], 'readwrite');
            const store = transaction.objectStore('audit_events');
            
            const event = {
                entity,
                entity_id: entityId,
                action,
                actor: 'local-user',
                at: new Date().toISOString(),
                payload: JSON.stringify(payload)
            };
            
            const request = store.add(event);
            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }

    // Search and Filtering
    async searchSeriesItems(filters = {}) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const request = store.getAll();
            
            request.onsuccess = () => {
                let items = request.result || [];
                
                // Apply filters
                if (filters.searchText) {
                    const searchLower = filters.searchText.toLowerCase();
                    items = items.filter(item => 
                        (item.record_series_title && item.record_series_title.toLowerCase().includes(searchLower)) ||
                        (item.description && item.description.toLowerCase().includes(searchLower)) ||
                        (item.retention_text && item.retention_text.toLowerCase().includes(searchLower))
                    );
                }
                
                if (filters.scheduleNumber) {
                    items = items.filter(item => item.application_number === filters.scheduleNumber);
                }
                
                if (filters.division) {
                    items = items.filter(item => item.division === filters.division);
                }
                
                if (filters.approvalStatus) {
                    items = items.filter(item => item.approval_status === filters.approvalStatus);
                }
                
                resolve(items);
            };
            request.onerror = () => reject(request.error);
        });
    }

    // UI Event Handlers
    initEventListeners() {
        // Top navigation
        const newScheduleBtn = document.getElementById('newScheduleBtn');
        if (newScheduleBtn) {
            newScheduleBtn.addEventListener('click', () => this.createNewSchedule());
        }
        document.getElementById('newSeriesBtn').addEventListener('click', () => this.createNewSeriesItem());
        document.getElementById('exportBtn').addEventListener('click', () => this.exportData());
        document.getElementById('importBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('importFile').click();
        });
        document.getElementById('importFile').addEventListener('change', (e) => this.importData(e));
        document.getElementById('importCsvBtn').addEventListener('click', (e) => {
            e.preventDefault();
            document.getElementById('importCsvFile').click();
        });
        document.getElementById('importCsvFile').addEventListener('change', (e) => this.handleCsvFile(e));
        document.getElementById('csvImportConfirmBtn').addEventListener('click', () => this.processCsvImport());
        document.getElementById('csvImportCancelBtn').addEventListener('click', () => this.hideCsvModal());
        document.getElementById('printReportBtn').addEventListener('click', () => this.printReport());
        document.getElementById('exportFilteredBtn').addEventListener('click', () => this.exportFilteredData());

        // Search and filters
        document.getElementById('searchInput').addEventListener('input', (e) => this.debounceSearch(e.target.value));
        document.getElementById('scheduleFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('divisionFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('statusFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('approvalDateStart').addEventListener('change', () => this.applyFilters());
        document.getElementById('approvalDateEnd').addEventListener('change', () => this.applyFilters());
        document.getElementById('coverageDateStart').addEventListener('input', () => this.debounceSearch());
        document.getElementById('coverageDateEnd').addEventListener('input', () => this.debounceSearch());
        document.getElementById('clearFiltersBtn').addEventListener('click', () => this.clearFilters());
        document.getElementById('sortBy').addEventListener('change', () => this.applyFilters());

        // Search pane toggle
        document.getElementById('searchToggleBtn').addEventListener('click', () => this.toggleSearchPane());

        // Tab navigation
        this.setupTabNavigation();

        // Forms
        document.getElementById('scheduleForm').addEventListener('submit', (e) => this.handleScheduleSubmit(e));
        const seriesForm = document.getElementById('seriesForm');
        console.log('Setting up seriesForm event listener, form found:', !!seriesForm);
        if (seriesForm) {
            seriesForm.addEventListener('submit', (e) => this.handleSeriesSubmit(e));
            console.log('seriesForm submit event listener attached');
        } else {
            console.error('seriesForm element not found during event listener setup');
        }
        
        document.getElementById('cancelScheduleBtn').addEventListener('click', () => this.cancelScheduleEdit());
        document.getElementById('cancelSeriesBtn').addEventListener('click', () => this.cancelSeriesEdit());
        document.getElementById('deleteScheduleBtn').addEventListener('click', () => this.confirmDeleteSchedule());
        document.getElementById('deleteSeriesBtn').addEventListener('click', () => this.confirmDeleteSeriesItem());

        // Modal
        document.getElementById('confirmBtn').addEventListener('click', () => this.handleConfirm());
        document.getElementById('cancelBtn').addEventListener('click', () => this.hideModal());

        // Status chips
        document.querySelectorAll('.chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                const value = e.target.dataset.value;
                const select = e.target.closest('.form-group').querySelector('select');
                if (select) {
                    select.value = value;
                    this.updateChipSelection(e.target.parentElement, value);
                }
            });
        });

        // Volume information unit buttons
        document.querySelectorAll('.converter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const unit = e.target.dataset.unit;
                const input = e.target.closest('.form-group').querySelector('input[type="text"]');
                if (input) {
                    const currentValue = input.value.trim();
                    input.value = currentValue ? `${currentValue} ${unit}` : unit;
                }
            });
        });

        // Enhanced form validation
        document.querySelectorAll('.form-control').forEach(input => {
            input.addEventListener('blur', (e) => this.validateField(e.target));
            input.addEventListener('input', (e) => this.clearFieldError(e.target));
        });

        // Combined keyboard handling (shortcuts + navigation)
        document.addEventListener('keydown', (e) => {
            // Handle keyboard shortcuts first
            if (e.key === 'Escape') {
                this.handleEscapeKey();
            } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                this.handleSaveShortcut();
            } else {
                // Handle general keyboard navigation
                this.handleKeydown(e);
            }
        });

        // Admin menu wiring
        this.setupAdminMenu();

        // Import status modal wiring
        this.setupImportStatusModal();

        // Global click handler for closing dropdowns
        document.addEventListener('click', (e) => this.handleGlobalClick(e));
    }

    debounceSearch(searchText) {
        clearTimeout(this.searchTimeout);
        this.searchTimeout = setTimeout(() => {
            this.applyFilters();
        }, 300);
    }

    // Performance optimized data loading
    async loadDataOptimized() {
        // Use IndexedDB cursors to avoid loading everything into memory
        this.schedules = [];
        this.seriesItems = [];
        
        // Load schedules and series data sequentially to avoid race conditions
        await this.loadSchedulesWithCursor();
        this.seriesItems = await this.getAllSeries(); // Load actual series data for UI
        
        // Load series items count only for UI updates
        this.totalSeriesCount = await this.getSeriesItemsCount();
        
        this.populateFilterDropdowns();
        await this.renderResults();
        this.updateResultsSummary();
        this.updateRecordCount();
    }

    async loadSchedulesWithCursor(limit = null, offset = 0) {
        // In merged model, schedules are derived from series data
        try {
            this.schedules = await this.getAllSchedules();
            return Promise.resolve();
        } catch (error) {
            return Promise.reject(error);
        }
    }

    async loadSchedulesWithCursorOld(limit = null, offset = 0) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['schedules'], 'readonly');
            const store = transaction.objectStore('schedules');
            const request = store.openCursor();
            
            let count = 0;
            let skipped = 0;
            const results = [];
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (skipped < offset) {
                        skipped++;
                        cursor.continue();
                        return;
                    }
                    
                    if (limit && count >= limit) {
                        resolve(results);
                        return;
                    }
                    
                    results.push({ ...cursor.value, _id: cursor.key });
                    count++;
                    cursor.continue();
                } else {
                    resolve(results);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async getSeriesItemsCount() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const request = store.count();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async applyFilters() {
        const searchInput = document.getElementById('searchInput');
        const scheduleFilter = document.getElementById('scheduleFilter');
        const divisionFilter = document.getElementById('divisionFilter');
        const statusFilter = document.getElementById('statusFilter');

        // Check if elements exist before accessing values
        if (!searchInput || !scheduleFilter || !divisionFilter || !statusFilter) {
            ErrorHandler.log(new Error('Filter elements not found'), 'Apply filters', APP_CONSTANTS.ERROR_TYPES.VALIDATION);
            return;
        }

        const filters = {
            searchText: searchInput.value.trim(),
            scheduleNumber: scheduleFilter.value,
            division: divisionFilter.value,
            approvalStatus: statusFilter.value
        };

        try {
            this.filteredItems = await this.searchSeriesItems(filters);
            this.sortResults();
            this.renderResults();
            this.updateResultsSummary();
        } catch (error) {
            ErrorHandler.log(error, 'Apply filters');
            this.setStatus('Error applying filters: ' + error.message, 'error');
        }
    }

    sortResults() {
        const sortByElement = document.getElementById('sortBy');
        if (!sortByElement) return;
        
        const sortBy = sortByElement.value;
        this.filteredItems.sort((a, b) => {
            const aVal = a[sortBy] || '';
            const bVal = b[sortBy] || '';
            return aVal.toString().localeCompare(bVal.toString());
        });
    }

    clearFilters() {
        const elements = [
            'searchInput', 'scheduleFilter', 'divisionFilter', 
            'statusFilter', 'retentionCategoryFilter',
            'approvalDateStart', 'approvalDateEnd', 'coverageDateStart', 'coverageDateEnd'
        ];
        
        elements.forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = false;
                } else {
                    element.value = '';
                }
            }
        });
        
        this.applyFilters();
    }

    async updateUI() {
        try {
            // Load data sequentially to avoid race conditions
            this.schedules = await this.getAllSchedules();
            this.seriesItems = await this.getAllSeries(); // Use getAllSeries for merged model
            this.filteredItems = [...this.seriesItems];
            
            // Wait for data to be fully loaded before updating UI
            await this.populateFilterDropdowns();
            
            // Keep the Series form schedule dropdown in sync with schedules
            if (typeof this.populateSeriesScheduleDropdown === 'function') {
                this.populateSeriesScheduleDropdown();
            }
            
            // Render results after all data is loaded
            await this.renderResults();
            this.updateResultsSummary();
            this.updateRecordCount();
        } catch (error) {
            ErrorHandler.log(error, 'UI update');
        }
    }

    populateFilterDropdowns() {
        // Schedule numbers - use application_number from merged model
        const scheduleNumbers = [...new Set(this.seriesItems.map(s => s.application_number).filter(n => n))];
        const scheduleSelect = document.getElementById('scheduleFilter');
        if (scheduleSelect) {
            DOMHelper.clearElement(scheduleSelect);
            scheduleSelect.appendChild(DOMHelper.createOption('', 'All Schedules'));
            scheduleNumbers.forEach(num => {
                scheduleSelect.appendChild(DOMHelper.createOption(num, num));
            });
        }

        // Divisions
        const divisions = [...new Set(this.seriesItems.map(s => s.division).filter(d => d))];
        const divSelect = document.getElementById('divisionFilter');
        if (divSelect) {
            DOMHelper.clearElement(divSelect);
            divSelect.appendChild(DOMHelper.createOption('', 'All Divisions'));
            divisions.forEach(div => {
                divSelect.appendChild(DOMHelper.createOption(div, div));
            });
        }
    }

    // Populate the Series form Schedule Number dropdown with existing schedules
    populateSeriesScheduleDropdown() {
        const select = document.getElementById('seriesScheduleNum');
        if (!select) return;

        // Preserve current selection (schedule_id as string)
        const currentValue = select.value;

        // Build sorted list by schedule_number for display
        const schedules = (this.schedules || [])
            .filter(s => s && s._id != null && s.schedule_number)
            .sort((a, b) => String(a.schedule_number).localeCompare(String(b.schedule_number)));

        DOMHelper.clearElement(select);
        select.appendChild(DOMHelper.createOption('', 'Select a schedule…'));

        schedules.forEach(s => {
            // value = internal schedule_id, label = schedule_number
            const opt = DOMHelper.createOption(String(s._id), s.schedule_number);
            opt.setAttribute('data-schedule-number', s.schedule_number);
            select.appendChild(opt);
        });

        // Try to restore previous selection if still available
        if (currentValue) {
            select.value = currentValue;
        }
    }

    // Helper: get a Set of all schedule numbers for quick membership checks
    getScheduleNumberSet() {
        const set = new Set();
        (this.schedules || []).forEach(s => {
            if (s.schedule_number) set.add(s.schedule_number);
        });
        return set;
    }

    // Normalize existing records so both legacy and canonical fields are in sync
    async normalizeExistingData() {
        // Normalize schedules
        for (const sched of this.schedules) {
            const desired = sched.schedule_number || sched.application_number || '';
            if (!desired) continue;
            const needsUpdate = (sched.schedule_number !== desired) || ('application_number' in sched);
            if (needsUpdate) {
                sched.schedule_number = desired;
                if ('application_number' in sched) delete sched.application_number;
                try { await this.saveSchedule(sched, true); } catch (e) { ErrorHandler.log(e, 'Normalize schedule'); }
            }
        }

        // Normalize series items
        for (const si of this.seriesItems) {
            const seriesNum = si.item_number || si.series_number || '';
            const needsUpdate = ('application_number' in si) || ('schedule_number' in si) || (si.item_number !== seriesNum) || ('series_number' in si);
            if (needsUpdate) {
                if (seriesNum) { si.item_number = seriesNum; }
                // Remove application_number field from series items
                if ('application_number' in si) delete si.application_number;
                if ('schedule_number' in si) delete si.schedule_number;
                if ('series_number' in si) delete si.series_number;
                try { await this.saveSeriesItem(si, true); } catch (e) { ErrorHandler.log(e, 'Normalize series'); }
            }
        }
    }

    async renderResults() {
        const resultsList = document.getElementById('resultsList');
        const emptyState = document.getElementById('emptyState');
        
        if (!resultsList || !emptyState) return;
        
        // Initialize virtual scrolling if not already done
        if (!this.virtualScroller) {
            this.initVirtualScrolling();
        }
        
        // Get filtered count using IndexedDB cursors
        const filteredCount = await this.getFilteredItemsCount();
        
        if (filteredCount === 0) {
            DOMHelper.clearElement(resultsList);
            resultsList.appendChild(emptyState);
            return;
        }

        emptyState.style.display = 'none';
        
        // Render virtual viewport
        await this.renderVirtualViewport();
    }

    initVirtualScrolling() {
        const resultsList = document.getElementById('resultsList');
        if (!resultsList) return;

        this.virtualScroller = {
            itemHeight: 60, // Height of each result row in pixels
            viewportHeight: 0,
            scrollTop: 0,
            totalItems: 0,
            visibleStart: 0,
            visibleEnd: 0,
            buffer: 5 // Extra items to render for smooth scrolling
        };

        // Set up scroll container
        resultsList.style.position = 'relative';
        resultsList.style.overflow = 'auto';
        resultsList.style.height = '100%';

        // Add scroll listener with throttling
        let scrollTimeout;
        resultsList.addEventListener('scroll', () => {
            if (scrollTimeout) clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
                this.handleVirtualScroll();
            }, 16); // ~60fps
        });

        // Calculate viewport height
        this.virtualScroller.viewportHeight = resultsList.clientHeight;
    }

    async handleVirtualScroll() {
        const resultsList = document.getElementById('resultsList');
        if (!resultsList || !this.virtualScroller) return;

        this.virtualScroller.scrollTop = resultsList.scrollTop;
        await this.renderVirtualViewport();
    }

    async renderVirtualViewport() {
        const resultsList = document.getElementById('resultsList');
        if (!resultsList || !this.virtualScroller) return;

        const { itemHeight, viewportHeight, scrollTop, buffer } = this.virtualScroller;
        
        // Calculate visible range
        const visibleStart = Math.max(0, Math.floor(scrollTop / itemHeight) - buffer);
        const visibleCount = Math.ceil(viewportHeight / itemHeight) + (buffer * 2);
        const visibleEnd = Math.min(await this.getFilteredItemsCount(), visibleStart + visibleCount);

        // Only re-render if range changed significantly
        if (Math.abs(visibleStart - this.virtualScroller.visibleStart) < 2 && 
            Math.abs(visibleEnd - this.virtualScroller.visibleEnd) < 2) {
            return;
        }

        this.virtualScroller.visibleStart = visibleStart;
        this.virtualScroller.visibleEnd = visibleEnd;

        // Get items for visible range using cursor
        const visibleItems = await this.getFilteredItemsRange(visibleStart, visibleEnd - visibleStart);
        
        // Calculate total height and create spacers
        const totalItems = await this.getFilteredItemsCount();
        const totalHeight = totalItems * itemHeight;
        const offsetY = visibleStart * itemHeight;

        // Clear and rebuild viewport
        DOMHelper.clearElement(resultsList);

        // Top spacer
        if (offsetY > 0) {
            const topSpacer = document.createElement('div');
            topSpacer.style.height = `${offsetY}px`;
            topSpacer.className = 'virtual-spacer';
            resultsList.appendChild(topSpacer);
        }

        // Visible items
        visibleItems.forEach((item, index) => {
            const row = this.createResultRow(item, visibleStart + index);
            resultsList.appendChild(row);
        });

        // Bottom spacer
        const bottomSpacerHeight = totalHeight - offsetY - (visibleItems.length * itemHeight);
        if (bottomSpacerHeight > 0) {
            const bottomSpacer = document.createElement('div');
            bottomSpacer.style.height = `${bottomSpacerHeight}px`;
            bottomSpacer.className = 'virtual-spacer';
            resultsList.appendChild(bottomSpacer);
        }
    }

    async getFilteredItemsCount() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const request = store.openCursor();
            
            let count = 0;
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (this.matchesCurrentFilters(cursor.value)) {
                        count++;
                    }
                    cursor.continue();
                } else {
                    resolve(count);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    async getFilteredItemsRange(offset, limit) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const request = store.openCursor();
            
            const items = [];
            let currentIndex = 0;
            let foundItems = 0;
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (currentIndex >= offset && foundItems < limit) {
                        items.push({ ...cursor.value, _id: cursor.key });
                        foundItems++;
                    }
                    currentIndex++;
                    
                    if (foundItems >= limit) {
                        resolve(items);
                        return;
                    }
                } else {
                    resolve(items);
                }
            };
            
            request.onerror = () => reject(request.error);
        });
    }

    matchesCurrentFilters(item) {
        // Apply current search and filter criteria
        const searchTerm = document.getElementById('searchInput')?.value.toLowerCase() || '';
        const applicationFilter = document.getElementById('applicationFilter')?.value || '';
        const divisionFilter = document.getElementById('divisionFilter')?.value || '';
        const statusFilter = document.getElementById('statusFilter')?.value || '';
        const approvalDateStart = document.getElementById('approvalDateStart')?.value || '';
        const approvalDateEnd = document.getElementById('approvalDateEnd')?.value || '';
        const coverageDateStart = document.getElementById('coverageDateStart')?.value || '';
        const coverageDateEnd = document.getElementById('coverageDateEnd')?.value || '';

        // Enhanced search term filter - search across more fields
        if (searchTerm) {
            const searchFields = [
                item.record_series_title,
                item.description,
                item.retention_text,
                // Schedule number displayed via join, not stored on series item
                item.item_number,
                item.division,
                item.contact,
                item.location,
                item.arrangement,
                item.media_types,
                item.series_notes,
                item.representative_name,
                item.records_officer_name
            ].join(' ').toLowerCase();
            
            if (!searchFields.includes(searchTerm)) {
                return false;
            }
        }

        // Schedule number filter
        if (applicationFilter) {
            const schedule = this.schedules.find(s => s.schedule_number === applicationFilter);
            if (!schedule || item.schedule_id !== schedule._id) {
                return false;
            }
        }

        // Division filter
        if (divisionFilter && item.division !== divisionFilter) {
            return false;
        }

        // Status filter
        if (statusFilter) {
            const schedule = this.schedules.find(s => s._id === item.schedule_id);
            const approvalStatus = schedule ? (schedule.approval_status || 'Unapproved') : 'Unapproved';
            if (approvalStatus !== statusFilter) return false;
        }

        // Approval date range filter (uses schedule.approval_date)
        if (approvalDateStart || approvalDateEnd) {
            const schedule = this.schedules.find(s => s._id === item.schedule_id);
            if (!schedule || !schedule.approval_date) {
                // If date filter is set but no approval date exists, exclude
                return false;
            }
            const approvalYear = this.extractYear(schedule.approval_date);
            if (approvalDateStart) {
                const filterStartYear = parseInt(approvalDateStart);
                if (approvalYear && approvalYear < filterStartYear) {
                    return false;
                }
            }
            if (approvalDateEnd) {
                const filterEndYear = parseInt(approvalDateEnd);
                if (approvalYear && approvalYear > filterEndYear) {
                    return false;
                }
            }
        }

        // Coverage date range filter
        if (coverageDateStart || coverageDateEnd) {
            const startYear = this.extractYear(item.dates_covered_start);
            const endYear = this.extractYear(item.dates_covered_end);
            
            if (coverageDateStart) {
                const filterStartYear = parseInt(coverageDateStart);
                if (startYear && startYear < filterStartYear) {
                    return false;
                }
            }
            
            if (coverageDateEnd) {
                const filterEndYear = parseInt(coverageDateEnd);
                if (endYear && endYear > filterEndYear) {
                    return false;
                }
            }
        }

        return true;
    }

    getRetentionCategory(item) {
        if (item.retention_term && item.retention_term > 0) {
            return 'time-limited';
        } else {
            return 'unknown';
        }
    }

    extractYear(dateString) {
        if (!dateString) return null;
        if (dateString.toLowerCase() === 'present') return new Date().getFullYear();
        
        // Try to extract year from various formats
        const yearMatch = dateString.match(/(\d{4})/);
        return yearMatch ? parseInt(yearMatch[1]) : null;
    }

    createResultRow(item, index) {
        const row = document.createElement('div');
        row.className = 'result-item';
        row.dataset.itemId = item._id;
        row.tabIndex = 0;

        // Column 1: Schedule #
        const colApp = document.createElement('div');
        colApp.className = 'col-app-num';
        // Display application_number directly from merged model
        DOMHelper.setTextContent(colApp, item.application_number || 'N/A');

        // Column 2: Item #
        const colItem = document.createElement('div');
        colItem.className = 'col-item-num';
        DOMHelper.setTextContent(colItem, item.item_number || 'N/A');

        // Column 3: Title
        const colTitle = document.createElement('div');
        colTitle.className = 'col-title';
        DOMHelper.setTextContent(colTitle, item.record_series_title || 'Untitled');

        // Column 4: Division
        const colDivision = document.createElement('div');
        colDivision.className = 'col-division';
        DOMHelper.setTextContent(colDivision, item.division || '—');

        row.appendChild(colApp);
        row.appendChild(colItem);
        row.appendChild(colTitle);
        row.appendChild(colDivision);

        // Selection handlers
        row.addEventListener('click', (e) => {
            e.stopPropagation();
            this.selectSeriesItem(item);
        });
        row.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.selectSeriesItem(item);
            }
        });

        return row;
    }

    updateResultsSummary() {
        const summary = document.getElementById('resultsSummary');
        if (!summary) return;
        
        const countElement = summary.querySelector('.count');
        if (countElement) {
            const count = this.filteredItems.length;
            countElement.textContent = `${count} record${count !== 1 ? 's' : ''} found`;
        }
    }

    updateRecordCount() {
        const recordCountElement = document.getElementById('recordCount');
        if (recordCountElement) {
            // Count unique schedule numbers (check both old and new field names for compatibility)
            const uniqueScheduleNumbers = [...new Set(this.schedules.map(s => s.schedule_number).filter(n => n))];
            const scheduleCount = uniqueScheduleNumbers.length;
            const seriesCount = this.seriesItems.length;
            recordCountElement.textContent = 
                `${scheduleCount} schedule${scheduleCount !== 1 ? 's' : ''}, ${seriesCount} series item${seriesCount !== 1 ? 's' : ''}`;
        }
    }

    // Unified Detail Pane Management
    displayDetails(schedule, seriesItem) {
        // Prevent multiple rapid calls
        if (this.displayDetailsTimeout) {
            clearTimeout(this.displayDetailsTimeout);
        }
        this.displayDetailsTimeout = setTimeout(() => {
            this._displayDetailsInternal(schedule, seriesItem);
        }, 10);
    }

    _displayDetailsInternal(schedule, seriesItem) {
        console.log('displayDetails called. Hiding noSelectionMessage.');
        const noSelectionMessage = document.getElementById('noSelectionMessage');
        const tabNavigation = document.getElementById('tabNavigation');
        const seriesTabPanel = document.getElementById('seriesTabPanel');
        const scheduleTabPanel = document.getElementById('scheduleTabPanel');
        
        // Hide no selection message
        if (noSelectionMessage) {
            noSelectionMessage.classList.add('hidden');
            console.log('noSelectionMessage classList after hide:', noSelectionMessage.classList);
        }
        
        // Show tab navigation
        if (tabNavigation) {
            tabNavigation.classList.remove('hidden');
        }
        
        // Determine which tab to show based on what data we have
        let showSeriesTab = false;
        let showScheduleTab = false;
        
        if (seriesItem !== null) {
            showSeriesTab = true;
            if (seriesItem && Object.keys(seriesItem).length > 0) {
                // Ensure the dropdown has options before setting its value
                this.populateSeriesScheduleDropdown();
                this.populateSeriesForm(seriesItem);
            } else {
                const seriesForm = document.getElementById('seriesForm');
                if (seriesForm) seriesForm.reset();
                // Refresh dropdown for new/empty form
                this.populateSeriesScheduleDropdown();
            }
        }
        
        if (schedule !== null) {
            showScheduleTab = true;
            if (schedule && Object.keys(schedule).length > 0) {
                this.populateScheduleForm(schedule);
            } else {
                const scheduleForm = document.getElementById('scheduleForm');
                if (scheduleForm) scheduleForm.reset();
            }
        }
        
        // Default to series tab if both are available, schedule tab if only schedule
        if (showSeriesTab) {
            this.switchToTab('series');
        } else if (showScheduleTab) {
            this.switchToTab('schedule');
        }
    }
    
    // Tab Navigation Methods
    setupTabNavigation() {
        const seriesTab = document.getElementById('seriesTab');
        const scheduleTab = document.getElementById('scheduleTab');
        
        if (seriesTab) {
            seriesTab.addEventListener('click', () => this.switchToTab('series'));
            seriesTab.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.switchToTab('series');
                }
            });
        }
        
        if (scheduleTab) {
            scheduleTab.addEventListener('click', () => this.switchToTab('schedule'));
            scheduleTab.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    this.switchToTab('schedule');
                }
            });
        }
    }
    
    switchToTab(tabName) {
        const seriesTab = document.getElementById('seriesTab');
        const scheduleTab = document.getElementById('scheduleTab');
        const seriesTabPanel = document.getElementById('seriesTabPanel');
        const scheduleTabPanel = document.getElementById('scheduleTabPanel');
        
        // Update tab buttons
        if (seriesTab && scheduleTab) {
            seriesTab.classList.toggle('active', tabName === 'series');
            scheduleTab.classList.toggle('active', tabName === 'schedule');
            
            // Update ARIA attributes
            seriesTab.setAttribute('aria-selected', tabName === 'series');
            scheduleTab.setAttribute('aria-selected', tabName === 'schedule');
            seriesTab.setAttribute('tabindex', tabName === 'series' ? '0' : '-1');
            scheduleTab.setAttribute('tabindex', tabName === 'schedule' ? '0' : '-1');
        }
        
        // Update tab panels
        if (seriesTabPanel && scheduleTabPanel) {
            seriesTabPanel.classList.toggle('hidden', tabName !== 'series');
            scheduleTabPanel.classList.toggle('hidden', tabName !== 'schedule');
        }
        
        // Store current tab for persistence
        this.currentTab = tabName;
    }

    hideDetails() {
        const noSelectionMessage = document.getElementById('noSelectionMessage');
        const tabNavigation = document.getElementById('tabNavigation');
        const seriesTabPanel = document.getElementById('seriesTabPanel');
        const scheduleTabPanel = document.getElementById('scheduleTabPanel');
        
        // Show no selection message
        console.log('hideDetails called. Showing noSelectionMessage.');
        if (noSelectionMessage) {
            noSelectionMessage.classList.remove('hidden');
            console.log('noSelectionMessage classList after show:', noSelectionMessage.classList);
        }
        
        // Hide tab navigation and panels
        if (tabNavigation) tabNavigation.classList.add('hidden');
        if (seriesTabPanel) seriesTabPanel.classList.add('hidden');
        if (scheduleTabPanel) scheduleTabPanel.classList.add('hidden');
        
        // Reset forms
        const scheduleForm = document.getElementById('scheduleForm');
        const seriesForm = document.getElementById('seriesForm');
        if (scheduleForm) scheduleForm.reset();
        if (seriesForm) seriesForm.reset();
    }

    // Record Selection and Editing
    selectSeriesItem(item) {
        // Clear previous selection
        document.querySelectorAll('.result-item').forEach(row => row.classList.remove('selected'));
        
        // Select new item
        const row = document.querySelector(`[data-item-id="${item._id}"]`);
        if (row) row.classList.add('selected');
        
        this.selectedItemId = item._id;
        this.currentSeriesItem = item;
        
        // Find the related schedule for this series item
        let relatedSchedule = null;
        if (item.schedule_id) {
            relatedSchedule = this.schedules.find(s => s._id === item.schedule_id);
        }
        
        // Display both schedule and series details
        this.displayDetails(relatedSchedule, item);
        
        const deleteSeriesBtn = document.getElementById('deleteSeriesBtn');
        if (deleteSeriesBtn) deleteSeriesBtn.classList.remove('hidden');
    }

    populateSeriesForm(item) {
        // Ensure schedule dropdown options exist, then set value below
        this.populateSeriesScheduleDropdown();

        const fields = {
            'seriesScheduleNum': (item.schedule_id != null ? String(item.schedule_id) : ''),
            'itemNumber': item.item_number || '',
            'seriesTitle': item.record_series_title || '',
            'seriesDescription': item.description || '',
            'datesStart': item.dates_covered_start || '',
            'datesEnd': item.dates_covered_end || '',
            'seriesDivision': item.division || '',
            'seriesContact': item.contact || '',
            'seriesLocation': item.location || '',
            'retentionText': item.retention_text || '',
            'retentionTrigger': item.retention_trigger || '',
            'volumePaper': item.volume_paper_cuft || '',
            'volumeElectronic': item.volume_electronic_bytes || '',
            'annualPaper': item.annual_accum_paper_cuft || '',
            'annualElectronic': item.annual_accum_electronic_bytes || '',
            'arrangement': item.arrangement || '',
            'mediaTypes': item.media_types || '',
            'electronicStandard': item.electronic_records_standard || '',
            'numberSizeFiles': item.number_size_files || '',
            'indexFindingAids': item.index_or_finding_aids || '',
            'ombStatuteRefs': item.omb_or_statute_refs || '',
            'relatedSeries': item.related_series || '',
            'representativeName': item.representative_name || '',
            'representativeTitle': item.representative_title || '',
            'representativePhone': item.representative_phone || '',
            'recordsOfficerName': item.records_officer_name || '',
            'recordsOfficerPhone': item.records_officer_phone || '',
            'seriesNotes': item.series_notes || ''
        };

        // Set text and number inputs
        Object.keys(fields).forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.value = fields[id];
            }
        });

        // Set checkboxes
        const auditHoldCheckbox = document.getElementById('auditHold');
        const litigationHoldCheckbox = document.getElementById('litigationHold');

        if (auditHoldCheckbox) auditHoldCheckbox.checked = item.audit_hold_required || false;
        if (litigationHoldCheckbox) litigationHoldCheckbox.checked = item.litigation_hold_required || false;

        // Toggle retention term visibility
        const retentionTermGroup = document.getElementById('retentionTermGroup');
        if (retentionTermGroup) {
            retentionTermGroup.style.display = 'none';
        }
    }

    populateScheduleForm(schedule) {
        const fields = {
            'scheduleNum': schedule.schedule_number || '',
            'approvalStatus': schedule.approval_status || 'draft',
            'approvalDate': schedule.approval_date || '',
            'scheduleDivision': schedule.division || '',
            'scheduleNotes': schedule.notes || '',
            'scheduleTags': schedule.tags ? schedule.tags.join(', ') : ''
        };

        // Set text inputs and selects
        Object.keys(fields).forEach(id => {
            const element = document.getElementById(id);
            if (element) {
                element.value = fields[id];
            }
        });

        // Update status chips to reflect current selection
        const statusSelect = document.getElementById('approvalStatus');
        if (statusSelect) {
            const chipContainer = statusSelect.parentElement.querySelector('.status-chips');
            if (chipContainer) {
                this.updateChipSelection(chipContainer, statusSelect.value);
            }
        }
    }

    createNewSchedule() {
        this.currentSchedule = null;
        
        // Show only schedule section for new schedule creation
        this.displayDetails({}, null);
        
        const scheduleForm = document.getElementById('scheduleForm');
        if (scheduleForm) scheduleForm.reset();
        
        const deleteScheduleBtn = document.getElementById('deleteScheduleBtn');
        const scheduleAppNumInput = document.getElementById('scheduleAppNum');
        
        if (deleteScheduleBtn) deleteScheduleBtn.classList.add('hidden');
        if (scheduleAppNumInput) scheduleAppNumInput.focus();
    }

    createNewSeriesItem() {
        console.log('createNewSeriesItem called');
        this.currentSeriesItem = null;
        
        // Show only series section for new series item creation
        this.displayDetails(null, {});
        
        const seriesForm = document.getElementById('seriesForm');
        console.log('seriesForm element found:', !!seriesForm);
        if (seriesForm) seriesForm.reset();
        
        const deleteSeriesBtn = document.getElementById('deleteSeriesBtn');
        const seriesScheduleNumInput = document.getElementById('seriesScheduleNum');
        
        if (deleteSeriesBtn) deleteSeriesBtn.classList.add('hidden');
        // Populate the schedule dropdown and focus it
        this.populateSeriesScheduleDropdown();
        if (seriesScheduleNumInput) seriesScheduleNumInput.focus();
    }

    async handleScheduleSubmit(e) {
        e.preventDefault();
        
        const schedule = {
            schedule_number: document.getElementById('scheduleNum').value,
            approval_status: document.getElementById('approvalStatus').value.toLowerCase(),
            approval_date: document.getElementById('approvalDate').value,
            division: document.getElementById('scheduleDivision').value,
            notes: document.getElementById('scheduleNotes').value,
            tags: document.getElementById('scheduleTags').value 
                ? document.getElementById('scheduleTags').value.split(',').map(t => t.trim()).filter(t => t) 
                : []
        };

        try {
            if (this.currentSchedule) {
                schedule._id = this.currentSchedule._id;
                schedule.version = (this.currentSchedule.version || 1) + 1;
                await this.saveSchedule(schedule, true);
            } else {
                await this.saveSchedule(schedule);
            }
            
            this.setStatus('Schedule saved successfully', 'success');
            await this.updateUI();
            this.cancelScheduleEdit();
        } catch (error) {
            ErrorHandler.log(error, 'Schedule save', APP_CONSTANTS.ERROR_TYPES.DATABASE);
            this.setStatus('Error saving schedule: ' + error.message, 'error');
        }
    }

    async handleSeriesSubmit(e) {
        e.preventDefault();
        console.log('handleSeriesSubmit called');
        
        // Validation
        const seriesScheduleNumEl = document.getElementById('seriesScheduleNum');
        const itemNumberEl = document.getElementById('itemNumber');
        const seriesTitleEl = document.getElementById('seriesTitle');
        
        console.log('Field elements found:', {
            seriesScheduleNum: !!seriesScheduleNumEl,
            itemNumber: !!itemNumberEl,
            seriesTitle: !!seriesTitleEl
        });
        
        if (!seriesScheduleNumEl) {
            console.error('seriesScheduleNum element not found');
            this.setStatus('Form error: Schedule Number field not found', 'error');
            return;
        }
        
        if (!itemNumberEl) {
            console.error('itemNumber element not found');
            this.setStatus('Form error: Item Number field not found', 'error');
            return;
        }
        
        if (!seriesTitleEl) {
            console.error('seriesTitle element not found');
            this.setStatus('Form error: Series Title field not found', 'error');
            return;
        }
        
        if (!seriesScheduleNumEl.value.trim()) {
            this.setStatus('Schedule is required', 'error');
            return;
        }
        // Relationship validation: ensure selected schedule exists by internal id
        const selectedScheduleIdStr = seriesScheduleNumEl.value.trim();
        const selectedScheduleId = Number.isNaN(Number(selectedScheduleIdStr)) ? selectedScheduleIdStr : parseInt(selectedScheduleIdStr, 10);
        const relatedSchedule = (this.schedules || []).find(s => String(s._id) === String(selectedScheduleId));
        if (!relatedSchedule) {
            this.setStatus('Selected Schedule does not exist. Please choose a valid schedule.', 'error');
            return;
        }
        
        if (!itemNumberEl.value.trim()) {
            this.setStatus('Item Number is required', 'error');
            return;
        }
        
        if (!seriesTitleEl.value.trim()) {
            this.setStatus('Record Series Title is required', 'error');
            return;
        }

        // We already validated and resolved relatedSchedule above using schedule_id
        // relatedSchedule contains the selected schedule object

        const item = {
            // No application_number field on series items
            schedule_id: relatedSchedule._id,
            item_number: document.getElementById('itemNumber').value,
            record_series_title: document.getElementById('seriesTitle').value,
            description: document.getElementById('seriesDescription').value,
            dates_covered_start: document.getElementById('datesStart').value,
            dates_covered_end: document.getElementById('datesEnd').value,
            arrangement: document.getElementById('arrangement').value,
            volume_paper_cuft: parseFloat(document.getElementById('volumePaper').value) || 0,
            volume_electronic_bytes: parseFloat(document.getElementById('volumeElectronic').value) || 0,
            annual_accum_paper_cuft: parseFloat(document.getElementById('annualPaper').value) || 0,
            annual_accum_electronic_bytes: parseFloat(document.getElementById('annualElectronic').value) || 0,
            retention_text: document.getElementById('retentionText').value,
            retention_trigger: document.getElementById('retentionTrigger').value,
            division: document.getElementById('seriesDivision').value,
            contact: document.getElementById('seriesContact').value,
            location: document.getElementById('seriesLocation').value,
            representative_name: document.getElementById('representativeName').value,
            representative_title: document.getElementById('representativeTitle').value,
            representative_phone: document.getElementById('representativePhone').value,
            records_officer_name: document.getElementById('recordsOfficerName').value,
            records_officer_phone: document.getElementById('recordsOfficerPhone').value,
            media_types: document.getElementById('mediaTypes').value,
            electronic_records_standard: document.getElementById('electronicStandard').value,
            number_size_files: document.getElementById('numberSizeFiles').value,
            index_or_finding_aids: document.getElementById('indexFindingAids').value,
            omb_or_statute_refs: document.getElementById('ombStatuteRefs').value,
            related_series: document.getElementById('relatedSeries').value,
            series_notes: document.getElementById('seriesNotes').value,
            updated_at: new Date().toISOString()
        };

        if (this.currentSeriesItem) {
            item._id = this.currentSeriesItem._id;
        } else {
            item.created_at = new Date().toISOString();
        }

        try {
            // Check for duplicate item numbers within the same schedule
            const duplicate = await this.checkDuplicateItemNumber(
                item.schedule_id, 
                item.item_number, 
                this.currentSeriesItem?._id
            );
            
            if (duplicate) {
                const proceed = await this.showConfirmModal(
                    'Duplicate Item Number',
                    `Item number "${item.item_number}" already exists for this schedule. Do you want to continue anyway?`
                );
                if (!proceed) return;
            }

            if (this.currentSeriesItem) {
                await this.saveSeriesItem(item, true);
            } else {
                await this.saveSeriesItem(item);
            }
            
            this.setStatus('Series item saved successfully', 'success');
            await this.updateUI();
            this.cancelSeriesEdit();
            // Force refresh after form is closed
            setTimeout(() => this.applyFilters(), 100);
        } catch (error) {
            ErrorHandler.log(error, 'Series save', APP_CONSTANTS.ERROR_TYPES.DATABASE);
            this.setStatus('Error saving series item: ' + error.message, 'error');
        }
    }

    cancelScheduleEdit() {
        this.currentSchedule = null;
        this.hideDetails();
    }

    cancelSeriesEdit() {
        this.currentSeriesItem = null;
        this.selectedItemId = null;
        
        document.querySelectorAll('.result-item').forEach(row => row.classList.remove('selected'));
        this.hideDetails();
    }

    clearSelectionAndHideDetails() {
        console.log('clearSelectionAndHideDetails called');
        document.querySelectorAll('.result-item.selected').forEach(row => row.classList.remove('selected'));
        this.selectedItemId = null;
        this.hideDetails();
    }

    // Import/Export
    async exportData() {
        try {
            const seriesItems = await this.getAllSeries();
            const auditEvents = await this.getAllAuditEvents();
            
            // Clean up export data for merged model
            const cleanSeries = seriesItems.map(item => {
                const cleanItem = {
                    record_series_title: item.record_series_title,
                    description: item.description,
                    dates_covered_start: item.dates_covered_start,
                    dates_covered_end: item.dates_covered_end,
                    open_ended: item.open_ended,
                    division: item.division,
                    contact: item.contact,
                    location: item.location,
                    retention_text: item.retention_text,
                    retention: item.retention,
                    retention_is_permanent: item.retention_is_permanent,
                    volume_paper_cuft: item.volume_paper_cuft,
                    volume_electronic_bytes: item.volume_electronic_bytes,
                    annual_accum_paper_cuft: item.annual_accum_paper_cuft,
                    annual_accum_electronic_bytes: item.annual_accum_electronic_bytes,
                    arrangement: item.arrangement,
                    media_types: item.media_types || [],
                    electronic_records_standard: item.electronic_records_standard,
                    number_size_files: item.number_size_files,
                    index_or_finding_aids: item.index_or_finding_aids,
                    omb_or_statute_refs: item.omb_or_statute_refs || [],
                    related_series: item.related_series || [],
                    series_notes: item.series_notes,
                    representative_name: item.representative_name,
                    representative_title: item.representative_title,
                    representative_phone: item.representative_phone,
                    records_officer_name: item.records_officer_name,
                    records_officer_phone: item.records_officer_phone,
                    tags: item.tags || []
                };
                
                // Include schedule assignment fields if present
                if (item.application_number) {
                    cleanItem.application_number = item.application_number;
                }
                if (item.item_number) {
                    cleanItem.item_number = item.item_number;
                }
                if (item.approval_status) {
                    cleanItem.approval_status = item.approval_status;
                }
                if (item.approval_date) {
                    cleanItem.approval_date = item.approval_date;
                }
                if (item.notes) {
                    cleanItem.notes = item.notes;
                }
                
                return cleanItem;
            });
            
            const exportData = {
                exported_at: new Date().toISOString(),
                version: 1,
                agency: {
                    name: "Illinois Law Enforcement Training and Standards Board",
                    abbrev: "ILETSB"
                },
                series: cleanSeries,
                audit_events: []
            };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `iletsb-records-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            await this.logAuditEvent('system', null, 'export', { recordCount: seriesItems.length });
            this.setStatus('Data exported successfully', 'success');
        } catch (error) {
            ErrorHandler.log(error, 'Data export', APP_CONSTANTS.ERROR_TYPES.EXPORT);
            this.setStatus('Error exporting data: ' + error.message, 'error');
        }
    }

    async importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Initialize status modal
        this.showImportStatus();
        this.clearImportLog();
        this.updateImportStatus('Starting import...');
        this.updateImportCounts(0, 0);
        this.logImportMessage(`Importing file: ${file.name}`);

        try {
            const text = await file.text();
            const data = JSON.parse(text);
            
            this.logImportMessage('Validating file structure...');
            const validation = this.validateImportData(data);
            if (!validation.valid) {
                throw new Error(`Invalid file format: ${validation.errors.join(', ')}`);
            }

            const results = {
                series: { created: 0, updated: 0, skipped: 0, errors: [] },
                auditEvents: { created: 0, updated: 0, skipped: 0, errors: [] }
            };

            // Import series (merged model)
            const seriesArray = data.series || data.series_items || [];
            this.logImportMessage(`Processing ${seriesArray.length} series items...`);
            
            for (const item of seriesArray) {
                try {
                    const identifier = `${item.application_number || 'unassigned'}-${item.item_number || 'no-item'}`;
                    this.logImportMessage(`Importing series ${identifier}: ${item.record_series_title}...`);
                    
                    const result = await this.upsertSeries(item);
                    results.series[result.action]++;
                    this.logImportMessage(`Series ${identifier} ${result.action} successfully`);
                } catch (error) {
                    const identifier = `${item.application_number || 'unassigned'}-${item.item_number || 'no-item'}`;
                    results.series.errors.push(`Series ${identifier}: ${error.message}`);
                    results.series.skipped++;
                    this.logImportMessage(`Error importing series: ${error.message}`);
                }
                this.updateImportCounts(results.series.created + results.series.updated, 0);
            }

            // Show final results
            const totalSeries = results.series.created + results.series.updated;
            const hasErrors = results.series.errors.length > 0;
            
            if (hasErrors) {
                this.updateImportStatus(`Import completed with ${results.series.errors.length} errors`);
            } else {
                this.updateImportStatus('Import completed successfully');
            }
            
            this.logImportMessage(`Final results: ${totalSeries} series items processed`);
            this.updateImportCounts(totalSeries, 0);
            
            await this.logAuditEvent('system', null, 'import', results);
            this.showImportSummary(results);
            await this.updateUI();
        } catch (error) {
            ErrorHandler.log(error, 'Data import', APP_CONSTANTS.ERROR_TYPES.IMPORT);
            this.updateImportStatus('Import failed');
            this.logImportMessage(`Error: ${error.message}`);
            this.setStatus('Error importing data: ' + error.message, 'error');
        }
    }

    validateImportData(data) {
        const errors = [];
        const validStatuses = ['draft', 'pending', 'approved', 'superseded'];
        
        // Validate basic structure - support both new and legacy formats
        const seriesArray = data.series || data.series_items;
        if (!seriesArray || !Array.isArray(seriesArray)) {
            errors.push('Missing or invalid series array (expected "series" or "series_items")');
        }
        
        // Validate series items
        if (seriesArray) {
            seriesArray.forEach((item, i) => {
                if (!item.record_series_title) {
                    errors.push(`Series item ${i}: Missing record_series_title (required)`);
                }
                
                // Validate application_number format if present
                if (item.application_number && !/^\d{2}-\d{3}$/.test(item.application_number)) {
                    errors.push(`Series item ${i}: Invalid application_number format (expected XX-XXX)`);
                }
                
                // Validate item_number format if present
                if (item.item_number && !/^\d+([A-Za-z]|\.\d+)?$/.test(item.item_number)) {
                    errors.push(`Series item ${i}: Invalid item_number format`);
                }
                
                // Validate approval_status if present
                if (item.approval_status && !validStatuses.includes(item.approval_status)) {
                    errors.push(`Series item ${i}: Invalid approval_status (must be one of: ${validStatuses.join(', ')})`);
                }
                
                // Validate tags array if present
                if (item.tags && !Array.isArray(item.tags)) {
                    errors.push(`Series item ${i}: tags must be an array`);
                }
                
                // Validate dates_covered_start format if present
                if (item.dates_covered_start && !/^\d{4}(-\d{2}(-\d{2})?)?$/.test(item.dates_covered_start)) {
                    errors.push(`Series item ${i}: Invalid dates_covered_start format (expected YYYY, YYYY-MM, or YYYY-MM-DD)`);
                }
                
                // Validate arrays
                if (item.media_types && !Array.isArray(item.media_types)) {
                    errors.push(`Series item ${i}: media_types must be an array`);
                }
                
                if (item.omb_or_statute_refs && !Array.isArray(item.omb_or_statute_refs)) {
                    errors.push(`Series item ${i}: omb_or_statute_refs must be an array`);
                }
                
                if (item.related_series && !Array.isArray(item.related_series)) {
                    errors.push(`Series item ${i}: related_series must be an array`);
                }
            });
        }
        
        return {
            valid: errors.length === 0,
            errors
        };
    }

    async upsertSeries(item) {
        // Normalize the item data
        const normalizedItem = this.normalizeSeriesItem(item);
        
        // Check for existing series by natural key
        let existingSeries = null;
        if (normalizedItem.application_number && normalizedItem.item_number) {
            const allSeries = await this.getAllSeries();
            existingSeries = allSeries.find(s => 
                s.application_number === normalizedItem.application_number && 
                s.item_number === normalizedItem.item_number
            );
        }
        
        if (existingSeries) {
            // Update existing series
            const updatedItem = { ...existingSeries, ...normalizedItem };
            const result = await this.saveSeries(updatedItem, true);
            return { action: 'updated', series: result };
        } else {
            // Create new series
            const result = await this.saveSeries(normalizedItem, false);
            return { action: 'created', series: result };
        }
    }

    normalizeSeriesItem(item) {
        const normalized = { ...item };
        
        // Handle legacy field mappings
        if (item.schedule_number && !normalized.application_number) {
            normalized.application_number = item.schedule_number;
        }
        
        // Ensure arrays are arrays
        if (normalized.tags && typeof normalized.tags === 'string') {
            normalized.tags = normalized.tags.split(';').map(t => t.trim()).filter(t => t);
        }
        if (normalized.media_types && typeof normalized.media_types === 'string') {
            normalized.media_types = normalized.media_types.split(';').map(t => t.trim()).filter(t => t);
        }
        
        // Handle open-ended dates
        if (normalized.dates_covered_end === 'present' || normalized.dates_covered_end === '') {
            normalized.dates_covered_end = null;
            normalized.open_ended = true;
        }
        
        // Calculate retention_is_permanent
        if (normalized.retention && normalized.retention.final_disposition) {
            normalized.retention_is_permanent = normalized.retention.final_disposition === 'permanent';
        }
        
        // Remove legacy fields
        delete normalized.schedule_number;
        delete normalized.schedule_id;
        delete normalized.schedule_uid;
        
        return normalized;
    }

    async upsertSchedule(scheduleData) {
        // Ensure database is initialized
        if (!this.db) {
            await this.initDatabase();
        }

        // Normalize data
        const schedule = {
            schedule_number: scheduleData.schedule_number,
            approval_status: scheduleData.approval_status.toLowerCase(),
            approval_date: scheduleData.approval_date,
            division: scheduleData.division,
            notes: scheduleData.notes,
            tags: Array.isArray(scheduleData.tags) ? scheduleData.tags : [],
            schedule_uid: scheduleData.schedule_uid || crypto.randomUUID(),
            updated_at: new Date().toISOString()
        };

        // Find existing schedule by schedule_uid
        const existing = await this.db.schedules
            .where('schedule_uid')
            .equals(schedule.schedule_uid)
            .first();

        if (existing) {
            schedule._id = existing._id;
            schedule.version = (existing.version || 1) + 1;
            schedule.created_at = existing.created_at;
            await this.db.schedules.update(schedule._id, schedule);
            return { action: 'updated', schedule };
        } else {
            schedule.created_at = new Date().toISOString();
            schedule.version = 1;
            const id = await this.db.schedules.add(schedule);
            return { action: 'created', schedule: { ...schedule, _id: id } };
        }
    }

    async findSeriesItemByScheduleAndItem(scheduleId, itemNumber) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const index = store.index('application_number+item_number');
            const request = index.get([scheduleId, itemNumber]);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async checkDuplicateItemNumber(scheduleId, itemNumber, excludeId = null) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const index = store.index('application_number+item_number');
            const request = index.get([scheduleId, itemNumber]);
            
            request.onsuccess = () => {
                const duplicate = request.result;
                // Only consider it a duplicate if it's not the same record we're editing
                resolve(duplicate && duplicate._id !== excludeId ? duplicate : null);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async saveAuditEvent(auditEvent) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['audit_events'], 'readwrite');
            const store = transaction.objectStore('audit_events');
            
            const event = {
                ...auditEvent,
                at: auditEvent.at || new Date().toISOString()
            };
            
            const request = store.add(event);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    showImportSummary(results) {
        // Handle merged model results structure
        const totalSeries = (results.series?.created || 0) + (results.series?.updated || 0);
        const totalAuditEvents = results.auditEvents?.created || 0;
        const totalErrors = (results.series?.errors?.length || 0) + (results.auditEvents?.errors?.length || 0);

        let message = `Import completed: ${totalSeries} series items (${results.series?.created || 0} new, ${results.series?.updated || 0} updated)`;
        
        if (totalAuditEvents > 0) {
            message += `, ${totalAuditEvents} audit events`;
        }
        
        if (totalErrors > 0) {
            message += `. ${totalErrors} errors occurred.`;
            ErrorHandler.log(new Error('Import validation errors'), 'Import validation', APP_CONSTANTS.ERROR_TYPES.VALIDATION);
        }

        this.setStatus(message, totalErrors > 0 ? 'warning' : 'success');
    }

    // Enhanced UX Helper Functions
    updateChipSelection(chipContainer, selectedValue) {
        chipContainer.querySelectorAll('.chip').forEach(chip => {
            chip.classList.toggle('active', chip.dataset.value === selectedValue);
        });
    }

    handleEscapeKey() {
        // Close admin dropdown if open
        const adminDropdown = document.getElementById('adminDropdown');
        if (adminDropdown && !adminDropdown.classList.contains('hidden')) {
            this.closeAdminMenu();
            return;
        }

        // Close modals or cancel current edit
        const modal = document.querySelector('.modal:not(.hidden)');
        if (modal) {
            this.hideModal();
        } else if (this.currentSchedule || this.currentSeriesItem) {
            if (this.currentSchedule) {
                this.cancelScheduleEdit();
            } else {
                this.cancelSeriesEdit();
            }
        }
    }

    // Admin dropdown helpers
    toggleAdminMenu() {
        const dropdown = document.getElementById('adminDropdown');
        const adminBtn = document.getElementById('adminMenuBtn');
        
        if (!dropdown || !adminBtn) return;

        const isHidden = dropdown.classList.contains('hidden');
        
        if (isHidden) {
            // Expand
            dropdown.classList.remove('hidden');
            adminBtn.setAttribute('aria-expanded', 'true');
            // Focus first actionable item
            const firstItem = dropdown.querySelector('.dropdown-item');
            if (firstItem) {
                setTimeout(() => firstItem.focus(), 100);
            }
        } else {
            this.closeAdminMenu();
        }
    }

    closeAdminMenu() {
        const dropdown = document.getElementById('adminDropdown');
        const adminBtn = document.getElementById('adminMenuBtn');
        if (!dropdown || !adminBtn) return;
        
        dropdown.classList.add('hidden');
        adminBtn.setAttribute('aria-expanded', 'false');
        adminBtn.focus(); // Return focus to button
    }

    setupAdminMenu() {
        const adminBtn = document.getElementById('adminMenuBtn');
        const clearDbBtn = document.getElementById('clearDbBtn');
        
        if (adminBtn) {
            adminBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.toggleAdminMenu();
            });
        }
        
        if (clearDbBtn) {
            clearDbBtn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.showModal(
                    'Clear Database',
                    'This will permanently delete all local data (schedules, series items, and audit events). This action cannot be undone. Are you sure you want to continue?',
                    () => this.clearDatabase()
                );
            });
        }
    }

    handleGlobalClick(e) {
        const dropdown = document.getElementById('adminDropdown');
        const adminMenu = document.getElementById('adminMenu');
        
        if (!dropdown || dropdown.classList.contains('hidden')) return;

        // Close if click is outside admin menu area
        if (!adminMenu.contains(e.target)) {
            this.closeAdminMenu();
        }
    }

    handleSaveShortcut() {
        // Save current form if editing
        const scheduleForm = document.getElementById('scheduleForm');
        const seriesForm = document.getElementById('seriesForm');
        
        if (scheduleForm && !scheduleForm.classList.contains('hidden')) {
            scheduleForm.dispatchEvent(new Event('submit'));
        } else if (seriesForm && !seriesForm.classList.contains('hidden')) {
            seriesForm.dispatchEvent(new Event('submit'));
        }
    }

    validateField(field) {
        this.clearFieldError(field);
        
        const fieldType = field.type;
        const fieldId = field.id;
        const value = field.value.trim();
        
        // Required field validation
        if (field.hasAttribute('required') && !value) {
            this.showFieldError(field, 'This field is required');
            return false;
        }

        // Date validation
        if (fieldType === 'date' && value) {
            const date = new Date(value);
            if (isNaN(date.getTime())) {
                this.showFieldError(field, 'Please enter a valid date');
                return false;
            }
        }

        // Year validation for coverage dates
        if ((fieldId === 'datesCoveredStart' || fieldId === 'datesCoveredEnd') && value) {
            if (!/^\d{4}$/.test(value) && value.toLowerCase() !== 'present') {
                this.showFieldError(field, 'Please enter a 4-digit year or "present"');
                return false;
            }
            
            const year = parseInt(value);
            if (!isNaN(year) && (year < 1800 || year > new Date().getFullYear() + 10)) {
                this.showFieldError(field, 'Please enter a reasonable year');
                return false;
            }
        }

        // Phone number validation
        if (fieldType === 'tel' && value) {
            const phoneRegex = /^\(?([0-9]{3})\)?[-. ]?([0-9]{3})[-. ]?([0-9]{4})$/;
            if (!phoneRegex.test(value)) {
                this.showFieldError(field, 'Please enter a valid phone number (e.g., 555-123-4567)');
                return false;
            }
        }

        // Number validation
        if (fieldType === 'number' && value) {
            const num = parseFloat(value);
            if (isNaN(num) || num < 0) {
                this.showFieldError(field, 'Please enter a valid positive number');
                return false;
            }
        }

        return true;
    }

    showFieldError(field, message) {
        field.classList.add('error');
        
        // Remove existing error message
        const existingError = field.parentElement.querySelector('.form-validation-error');
        if (existingError) {
            existingError.remove();
        }
        
        // Add new error message
        const errorDiv = document.createElement('div');
        errorDiv.className = 'form-validation-error';
        errorDiv.textContent = message;
        field.parentElement.appendChild(errorDiv);
    }

    clearFieldError(field) {
        field.classList.remove('error');
        const errorDiv = field.parentElement.querySelector('.form-validation-error');
        if (errorDiv) {
            errorDiv.remove();
        }
    }

    validateForm(formId) {
        const form = document.getElementById(formId);
        if (!form) return true;
        
        let isValid = true;
        const fields = form.querySelectorAll('.form-control');
        
        fields.forEach(field => {
            if (!this.validateField(field)) {
                isValid = false;
            }
        });
        
        return isValid;
    }

    // Enhanced number formatting
    formatNumber(value, stripCommas = true) {
        if (!value) return value;
        
        let numStr = value.toString();
        if (stripCommas) {
            numStr = numStr.replace(/,/g, '');
        }
        
        const num = parseFloat(numStr);
        return isNaN(num) ? value : num;
    }

    // Byte size display helper
    formatBytes(bytes) {
        if (bytes === 0) return '0 Bytes';
        
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    // CSV Import Functions
    async handleCsvFile(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const csvData = this.parseCSV(text);
            
            if (csvData.length < 2) {
                throw new Error('CSV file must contain at least a header row and one data row');
            }

            this.csvData = csvData;
            this.showCsvImportModal(csvData);
        } catch (error) {
            ErrorHandler.log(error, 'CSV parsing', APP_CONSTANTS.ERROR_TYPES.IMPORT);
            this.setStatus('Error reading CSV file: ' + error.message, 'error');
        }
        
        // Reset file input
        event.target.value = '';
    }

    parseCSV(text) {
        const lines = text.split('\n').map(line => line.trim()).filter(line => line);
        const result = [];
        
        for (const line of lines) {
            const row = [];
            let current = '';
            let inQuotes = false;
            
            for (let i = 0; i < line.length; i++) {
                const char = line[i];
                
                if (char === '"') {
                    inQuotes = !inQuotes;
                } else if (char === ',' && !inQuotes) {
                    row.push(current.trim());
                    current = '';
                } else {
                    current += char;
                }
            }
            
            row.push(current.trim());
            result.push(row);
        }
        
        return result;
    }

    showCsvImportModal(csvData) {
        const modal = document.getElementById('csvImportModal');
        const preview = document.getElementById('csvPreview');
        const mapping = document.getElementById('columnMapping');
        
        // Show preview of first 5 rows
        const previewData = csvData.slice(0, 5);
        DOMHelper.clearElement(preview);
        preview.appendChild(this.createCsvPreviewTable(previewData));
        
        // Create column mapping controls
        DOMHelper.clearElement(mapping);
        mapping.appendChild(this.createColumnMappingControls(csvData[0]));
        
        modal.classList.remove('hidden');
    }

    createCsvPreviewTable(data) {
        if (data.length === 0) {
            const p = document.createElement('p');
            p.textContent = 'No data to preview';
            return p;
        }
        
        const table = document.createElement('table');
        const thead = document.createElement('thead');
        const tbody = document.createElement('tbody');
        
        // Create header row
        const headerRow = document.createElement('tr');
        data[0].forEach((header, index) => {
            const th = document.createElement('th');
            DOMHelper.setTextContent(th, `Column ${index + 1}: ${header}`);
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        
        // Create data rows
        for (let i = 1; i < data.length; i++) {
            const row = document.createElement('tr');
            data[i].forEach(cell => {
                const td = document.createElement('td');
                DOMHelper.setTextContent(td, cell || '');
                row.appendChild(td);
            });
            tbody.appendChild(row);
        }
        
        table.appendChild(thead);
        table.appendChild(tbody);
        return table;
    }

    createColumnMappingControls(headers) {
        const seriesFields = [
            { key: '', label: '-- Skip Column --' },
            { key: 'application_number', label: 'Schedule Number *' },
            { key: 'item_number', label: 'Item Number *' },
            { key: 'record_series_title', label: 'Record Series Title *' },
            { key: 'description', label: 'Description' },
            { key: 'dates_covered_start', label: 'Dates Covered Start' },
            { key: 'dates_covered_end', label: 'Dates Covered End' },
            { key: 'arrangement', label: 'Arrangement' },
            { key: 'volume_paper_cuft', label: 'Paper Volume (cu ft)' },
            { key: 'volume_electronic_bytes', label: 'Electronic Volume (bytes)' },
            { key: 'annual_accum_paper_cuft', label: 'Annual Paper (cu ft)' },
            { key: 'annual_accum_electronic_bytes', label: 'Annual Electronic (bytes)' },
            { key: 'retention_text', label: 'Retention Text' },
            { key: 'retention_trigger', label: 'Retention Trigger' },
            { key: 'division', label: 'Division' },
            { key: 'contact', label: 'Contact' },
            { key: 'location', label: 'Location' },
            { key: 'representative_name', label: 'Representative Name' },
            { key: 'representative_title', label: 'Representative Title' },
            { key: 'representative_phone', label: 'Representative Phone' },
            { key: 'records_officer_name', label: 'Records Officer Name' },
            { key: 'records_officer_phone', label: 'Records Officer Phone' },
            { key: 'media_types', label: 'Media Types' },
            { key: 'electronic_records_standard', label: 'Electronic Records Standard' },
            { key: 'number_size_files', label: 'Number Size Files' },
            { key: 'index_or_finding_aids', label: 'Index or Finding Aids' },
            { key: 'omb_or_statute_refs', label: 'OMB or Statute References' },
            { key: 'related_series', label: 'Related Series' },
            { key: 'series_notes', label: 'Series Notes' }
        ];

        const container = document.createElement('div');
        
        headers.forEach((header, index) => {
            const mappingRow = document.createElement('div');
            mappingRow.className = 'mapping-row';
            
            const label = document.createElement('label');
            DOMHelper.setTextContent(label, `CSV Column: "${header}"`);
            
            const select = document.createElement('select');
            select.className = 'column-mapping-select';
            select.dataset.column = index;
            select.id = `mapping_${index}`;
            
            seriesFields.forEach(field => {
                select.appendChild(DOMHelper.createOption(field.key, field.label));
            });
            
            mappingRow.appendChild(label);
            mappingRow.appendChild(select);
            container.appendChild(mappingRow);
        });
        
        return container;
    }

    hideCsvModal() {
        const modal = document.getElementById('csvImportModal');
        modal.classList.add('hidden');
        this.csvData = null;
    }

    async processCsvImport() {
        try {
            const headers = this.csvData[0];
            const mapping = {};
            
            // Build mapping from CSV columns to database fields
            headers.forEach((header, index) => {
                const select = document.getElementById(`mapping_${index}`);
                if (select && select.value) {
                    mapping[index] = select.value;
                }
            });

            // Validate required fields are mapped
            const requiredFields = ['application_number', 'item_number', 'record_series_title'];
            const mappedFields = Object.values(mapping);
            const missingRequired = requiredFields.filter(field => !mappedFields.includes(field));
            
            if (missingRequired.length > 0) {
                throw new Error(`Required fields not mapped: ${missingRequired.join(', ')}`);
            }

            const results = {
                created: 0,
                updated: 0,
                skipped: 0,
                errors: []
            };

            // Process each data row
            for (let i = 1; i < this.csvData.length; i++) {
                try {
                    const row = this.csvData[i];
                    const item = this.mapCsvRowToItem(row, mapping);
                    
                    if (item.application_number && item.item_number && item.record_series_title) {
                        const result = await this.upsertSeriesItem(item);
                        results[result.action]++;
                    } else {
                        results.skipped++;
                        results.errors.push(`Row ${i + 1}: Missing required fields`);
                    }
                } catch (error) {
                    results.skipped++;
                    results.errors.push(`Row ${i + 1}: ${error.message}`);
                }
            }

            await this.logAuditEvent('system', null, 'csv_import', results);
            
            this.hideCsvModal();
            this.showCsvImportSummary(results);
            await this.updateUI();
        } catch (error) {
            ErrorHandler.log(error, 'CSV import', APP_CONSTANTS.ERROR_TYPES.IMPORT);
            this.setStatus('Error importing CSV: ' + error.message, 'error');
        }
    }

    mapCsvRowToItem(row, mapping) {
        const item = {
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        Object.entries(mapping).forEach(([csvIndex, fieldName]) => {
            const value = row[parseInt(csvIndex)]?.trim();
            if (value) {
                // Type conversion based on field
                if (fieldName.includes('volume') || fieldName.includes('term')) {
                    item[fieldName] = parseFloat(value) || 0;
                } else {
                    item[fieldName] = value;
                }
            }
        });

        return item;
    }

    hideCsvModal() {
        const modal = document.getElementById('csvImportModal');
        modal.classList.add('hidden');
        this.csvData = null;
    }

    showCsvImportSummary(results) {
        const total = results.created + results.updated;
        let message = `CSV import completed: ${total} series items (${results.created} new, ${results.updated} updated)`;
        
        if (results.skipped > 0) {
            message += `, ${results.skipped} skipped`;
        }
        
        if (results.errors.length > 0) {
            message += `. ${results.errors.length} errors occurred.`;
            ErrorHandler.log(new Error('CSV import validation errors'), 'CSV import validation', APP_CONSTANTS.ERROR_TYPES.VALIDATION);
        }

        this.setStatus(message, results.errors.length > 0 ? 'warning' : 'success');
    }

    // Quality Control Features

    flagRetentionKeywords(retentionText) {
        if (!retentionText) return [];
        
        const keywords = {
            audit: ['audit', 'auditing', 'audited', 'audit hold'],
            litigation: ['litigation', 'legal hold', 'lawsuit', 'court', 'legal action'],
            compliance: ['compliance', 'regulatory', 'regulation', 'statute', 'law'],
            destruction: ['destroy', 'destruction', 'dispose', 'disposal', 'shred']
        };
        
        const flags = [];
        const text = retentionText.toLowerCase();
        
        Object.entries(keywords).forEach(([category, terms]) => {
            if (terms.some(term => text.includes(term))) {
                flags.push(category);
            }
        });
        
        return flags;
    }

    calculateDataCompleteness(item) {
        const requiredFields = ['application_number', 'item_number', 'record_series_title'];
        const importantFields = [
            'description', 'dates_covered_start', 'dates_covered_end', 
            'retention_text', 'division', 'contact', 'location'
        ];
        const optionalFields = [
            'arrangement', 'volume_paper_cuft', 'volume_electronic_bytes',
            'representative_name', 'records_officer_name', 'media_types'
        ];
        
        let score = 0;
        let maxScore = 0;
        
        // Required fields (40% weight)
        requiredFields.forEach(field => {
            maxScore += 40;
            if (item[field] && item[field].toString().trim()) {
                score += 40;
            }
        });
        
        // Important fields (35% weight)
        importantFields.forEach(field => {
            maxScore += 5;
            if (item[field] && item[field].toString().trim()) {
                score += 5;
            }
        });
        
        // Optional fields (25% weight)
        optionalFields.forEach(field => {
            maxScore += 2.5;
            if (item[field] && item[field].toString().trim()) {
                score += 2.5;
            }
        });
        
        return Math.round((score / maxScore) * 100);
    }

    getCompletenessLevel(percentage) {
        if (percentage >= 90) return { level: 'excellent', color: 'green' };
        if (percentage >= 75) return { level: 'good', color: 'blue' };
        if (percentage >= 60) return { level: 'fair', color: 'orange' };
        return { level: 'poor', color: 'red' };
    }

    addQualityIndicators(item) {
        const indicators = {
            completeness: this.calculateDataCompleteness(item),
            retentionFlags: this.flagRetentionKeywords(item.retention_text)
        };
        
        return { ...item, qualityIndicators: indicators };
    }

    async showConfirmModal(title, message) {
        return new Promise((resolve) => {
            this.showModal(title, message, () => resolve(true), () => resolve(false));
        });
    }

    // Reporting and Export Enhancements
    async printReport() {
        try {
            const filteredItems = await this.getFilteredItems();
            const reportHtml = this.generateReportHtml(filteredItems);
            
            // Create a new window for printing
            const printWindow = window.open('', '_blank');
            printWindow.document.write(reportHtml);
            printWindow.document.close();
            
            // Wait for content to load then print
            printWindow.onload = () => {
                printWindow.print();
                printWindow.close();
            };
        } catch (error) {
            ErrorHandler.log(error, 'Print report', APP_CONSTANTS.ERROR_TYPES.EXPORT);
            this.setStatus('Error generating print report: ' + error.message, 'error');
        }
    }

    async exportFilteredData() {
        try {
            const filteredItems = await this.getFilteredItems();
            const allSchedules = await this.getAllSchedules();
            const relatedScheduleIds = [...new Set(filteredItems.map(item => item.schedule_id).filter(id => id))];
            const relatedSchedules = allSchedules.filter(schedule => relatedScheduleIds.includes(schedule._id));

            const exportData = {
                metadata: {
                    exported_at: new Date().toISOString(),
                    total_schedules: relatedSchedules.length,
                    total_series_items: filteredItems.length,
                    filters_applied: this.getActiveFilters()
                },
                schedules: relatedSchedules,
                series_items: filteredItems
            };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `iletsb_filtered_export_${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);

            this.setStatus(`Exported ${filteredItems.length} filtered items`, 'success');
        } catch (error) {
            ErrorHandler.log(error, 'Export filtered data', APP_CONSTANTS.ERROR_TYPES.EXPORT);
            this.setStatus('Error exporting filtered data: ' + error.message, 'error');
        }
    }

    async getFilteredItems() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const request = store.openCursor();
            const items = [];

            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    const item = { ...cursor.value, _id: cursor.key };
                    if (this.matchesCurrentFilters(item)) {
                        items.push(item);
                    }
                    cursor.continue();
                } else {
                    resolve(items);
                }
            };

            request.onerror = () => reject(request.error);
        });
    }

    getActiveFilters() {
        const filters = {};
        
        const searchInput = document.getElementById('searchInput')?.value;
        if (searchInput) filters.search = searchInput;
        
        const applicationFilter = document.getElementById('applicationFilter')?.value;
        if (applicationFilter) filters.application = applicationFilter;
        
        const divisionFilter = document.getElementById('divisionFilter')?.value;
        if (divisionFilter) filters.division = divisionFilter;
        
        const statusFilter = document.getElementById('statusFilter')?.value;
        if (statusFilter) filters.status = statusFilter;
        
        const retentionCategoryFilter = document.getElementById('retentionCategoryFilter')?.value;
        if (retentionCategoryFilter) filters.retentionCategory = retentionCategoryFilter;
        
        const approvalDateStart = document.getElementById('approvalDateStart')?.value;
        const approvalDateEnd = document.getElementById('approvalDateEnd')?.value;
        if (approvalDateStart || approvalDateEnd) {
            filters.approvalDateRange = { start: approvalDateStart, end: approvalDateEnd };
        }
        
        const coverageDateStart = document.getElementById('coverageDateStart')?.value;
        const coverageDateEnd = document.getElementById('coverageDateEnd')?.value;
        if (coverageDateStart || coverageDateEnd) {
            filters.coverageDateRange = { start: coverageDateStart, end: coverageDateEnd };
        }

        return filters;
    }

    generateReportHtml(items) {
        const activeFilters = this.getActiveFilters();
        const filterSummary = Object.keys(activeFilters).length > 0 
            ? Object.entries(activeFilters).map(([key, value]) => 
                `<li><strong>${key}:</strong> ${typeof value === 'object' ? JSON.stringify(value) : value}</li>`
              ).join('')
            : '<li>No filters applied</li>';

        const itemRows = items.map(item => {
            const itemWithQuality = this.addQualityIndicators(item);
            const completeness = itemWithQuality.qualityIndicators.completeness;
            const retentionFlags = itemWithQuality.qualityIndicators.retentionFlags;
            const schedule = this.schedules.find(s => s.application_number === item.application_number);
            const approvalStatus = schedule ? (schedule.approval_status || 'Unapproved') : 'Unapproved';

            return `
                <tr>
                    <td>${item.application_number || 'N/A'}</td>
                    <td>${item.item_number || 'N/A'}</td>
                    <td>${item.record_series_title || 'Untitled'}</td>
                    <td>${approvalStatus}</td>
                    <td>${item.division || 'N/A'}</td>
                    <td>${item.retention_text || 'Not specified'}</td>
                    <td>${this.formatDateRange(item.dates_covered_start, item.dates_covered_end)}</td>
                    <td>${completeness}%</td>
                </tr>
            `;
        }).join('');

        return `
            <!DOCTYPE html>
            <html>
            <head>
                <title>ILETSB Records Retention Inventory Report</title>
                <style>
                    body { 
                        font-family: Arial, sans-serif; 
                        margin: 20px; 
                        font-size: 12px;
                        line-height: 1.4;
                    }
                    .header { 
                        text-align: center; 
                        margin-bottom: 30px; 
                        border-bottom: 2px solid #333;
                        padding-bottom: 15px;
                    }
                    .header h1 { 
                        margin: 0; 
                        color: #333; 
                        font-size: 24px;
                    }
                    .header .subtitle { 
                        color: #666; 
                        margin-top: 5px;
                        font-size: 14px;
                    }
                    .summary { 
                        margin-bottom: 20px; 
                        background: #f5f5f5; 
                        padding: 15px; 
                        border-radius: 5px;
                    }
                    .summary h3 { 
                        margin-top: 0; 
                        color: #333;
                    }
                    .summary ul { 
                        margin: 10px 0; 
                        padding-left: 20px;
                    }
                    table { 
                        width: 100%; 
                        border-collapse: collapse; 
                        margin-top: 15px;
                    }
                    th, td { 
                        border: 1px solid #ddd; 
                        padding: 8px; 
                        text-align: left; 
                        font-size: 11px;
                    }
                    th { 
                        background-color: #f2f2f2; 
                        font-weight: bold;
                    }
                    tr:nth-child(even) { 
                        background-color: #f9f9f9; 
                    }
                    .footer { 
                        margin-top: 30px; 
                        text-align: center; 
                        color: #666; 
                        font-size: 10px;
                        border-top: 1px solid #ddd;
                        padding-top: 15px;
                    }
                    @media print {
                        body { margin: 0; }
                        .header { page-break-after: avoid; }
                        table { page-break-inside: avoid; }
                        tr { page-break-inside: avoid; }
                    }
                </style>
            </head>
            <body>
                <div class="header">
                    <h1>Illinois Law Enforcement Training & Standards Board</h1>
                    <div class="subtitle">Records Retention Inventory Report</div>
                    <div class="subtitle">Generated on ${new Date().toLocaleDateString()} at ${new Date().toLocaleTimeString()}</div>
                </div>

                <div class="summary">
                    <h3>Report Summary</h3>
                    <p><strong>Total Records:</strong> ${items.length}</p>
                    <h4>Active Filters:</h4>
                    <ul>${filterSummary}</ul>
                </div>

                <table>
                    <thead>
                        <tr>
                            <th>Schedule #</th>
                            <th>Item #</th>
                            <th>Record Series Title</th>
                            <th>Approval Status</th>
                            <th>Division</th>
                            <th>Retention</th>
                            <th>Dates Covered</th>
                            <th>Completeness</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${itemRows}
                    </tbody>
                </table>

                <div class="footer">
                    <p>This report was generated by the ILETSB Records Retention Inventory system.</p>
                    <p>For questions or corrections, please contact the Records Management Office.</p>
                </div>
            </body>
            </html>
        `;
    }

    formatDateRange(startDate, endDate) {
        if (!startDate && !endDate) return 'No dates specified';
        if (!startDate) return `Through ${endDate}`;
        if (!endDate) return `${startDate} - present`;
        if (startDate === endDate) return startDate;
        return `${startDate} - ${endDate}`;
    }

    setStatus(message, type = 'info') {
        const statusEl = document.getElementById('statusMessage');
        if (!statusEl) return;
        
        statusEl.textContent = message;
        statusEl.className = type === 'error' ? 'status--error' : type === 'success' ? 'status--success' : '';
        
        if (type === 'success' || type === 'error') {
            setTimeout(() => {
                statusEl.textContent = 'Ready';
                statusEl.className = '';
            }, 3000);
        }
    }

    toggleSearchPane() {
        const searchPane = document.getElementById('searchPane');
        const mainContent = document.querySelector('.main-content');
        const toggleBtn = document.getElementById('searchToggleBtn');
        
        if (!searchPane || !mainContent || !toggleBtn) return;
        
        const isCollapsed = searchPane.classList.contains('collapsed');
        
        if (isCollapsed) {
            // Expand
            searchPane.classList.remove('collapsed');
            mainContent.classList.remove('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'true');
        } else {
            // Collapse
            searchPane.classList.add('collapsed');
            mainContent.classList.add('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'false');
        }
        
        // Store preference in localStorage (guarded)
        try {
            localStorage.setItem('iletsb_search_pane_collapsed', String(!isCollapsed));
        } catch (e) {
            // Ignore storage errors; toggling should still work without persistence
        }
    }

    restoreSearchPaneState() {
        let isCollapsed = false;
        try {
            isCollapsed = localStorage.getItem('iletsb_search_pane_collapsed') === 'true';
        } catch (e) {
            // If storage is unavailable, default to expanded
            isCollapsed = false;
        }
        
        const searchPane = document.getElementById('searchPane');
        const mainContent = document.querySelector('.main-content');
        const toggleBtn = document.getElementById('searchToggleBtn');
        
        if (!searchPane || !mainContent || !toggleBtn) return;
        
        if (isCollapsed) {
            searchPane.classList.add('collapsed');
            mainContent.classList.add('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'false');
        } else {
            searchPane.classList.remove('collapsed');
            mainContent.classList.remove('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'true');
        }
    }

    handleKeydown(event) {
        if (event.key === 'Escape') {
            const modal = document.getElementById('confirmModal');
            if (modal && !modal.classList.contains('hidden')) {
                this.hideModal();
                return;
            }
            
            // Cancel current edit
            const scheduleForm = document.getElementById('scheduleForm');
            const seriesForm = document.getElementById('seriesForm');
            
            if (scheduleForm && !scheduleForm.classList.contains('hidden')) {
                this.cancelScheduleEdit();
            } else if (seriesForm && !seriesForm.classList.contains('hidden')) {
                this.cancelSeriesEdit();
            }
        }
    }

    // Import Status Management
    showImportStatus() {
        document.getElementById('importStatusModal').classList.remove('hidden');
    }

    hideImportStatus() {
        document.getElementById('importStatusModal').classList.add('hidden');
    }

    updateImportStatus(status) {
        document.getElementById('importStatusCode').textContent = status;
    }

    updateImportCounts(schedules, series) {
        document.getElementById('importSchedulesCount').textContent = schedules;
        document.getElementById('importSeriesCount').textContent = series;
    }

    logImportMessage(message) {
        const log = document.getElementById('importStatusLog');
        log.value += `[${new Date().toLocaleTimeString()}] ${message}\n`;
        log.scrollTop = log.scrollHeight;
    }

    clearImportLog() {
        document.getElementById('importStatusLog').value = '';
    }

    // Modal Management
    showModal(title, message, onConfirm, onCancel) {
        const modal = document.getElementById('confirmModal');
        const titleEl = document.getElementById('confirmTitle');
        const messageEl = document.getElementById('confirmMessage');
        const confirmBtn = document.getElementById('confirmBtn');
        const cancelBtn = document.getElementById('cancelBtn');
        
        if (!modal || !titleEl || !messageEl || !confirmBtn || !cancelBtn) {
            console.error('Modal elements not found');
            return;
        }
        
        titleEl.textContent = title;
        messageEl.textContent = message;
        
        // Store callbacks for later use
        this.modalCallbacks = { onConfirm, onCancel };
        
        modal.classList.remove('hidden');
        confirmBtn.focus();
    }

    hideModal() {
        const modal = document.getElementById('confirmModal');
        if (modal) {
            modal.classList.add('hidden');
        }
        this.modalCallbacks = null;
    }

    handleConfirm() {
        if (this.modalCallbacks && this.modalCallbacks.onConfirm) {
            this.modalCallbacks.onConfirm();
        }
        this.hideModal();
    }

    handleCancel() {
        if (this.modalCallbacks && this.modalCallbacks.onCancel) {
            this.modalCallbacks.onCancel();
        }
        this.hideModal();
    }

    async clearDatabase() {
        try {
            if (!this.db) {
                await this.initDatabase();
            }

            // Clear all object stores
            const transaction = this.db.transaction(['series', 'audit_events'], 'readwrite');
            
            const seriesStore = transaction.objectStore('series');
            const auditStore = transaction.objectStore('audit_events');
            
            await Promise.all([
                new Promise((resolve, reject) => {
                    const request = seriesStore.clear();
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                }),
                new Promise((resolve, reject) => {
                    const request = auditStore.clear();
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                })
            ]);

            // Clear localStorage errors as well
            localStorage.removeItem('iletsb_errors');
            
            // Refresh the UI
            await this.loadDataOptimized();
            this.updateStatusBar();
            
            // Show success message
            this.setStatus('Database cleared successfully', 'success');
            
        } catch (error) {
            ErrorHandler.log(error, 'Clear Database', APP_CONSTANTS.ERROR_TYPES.DATABASE);
            this.setStatus('Failed to clear database', 'error');
        }
    }

    setupImportStatusModal() {
        const closeBtn = document.getElementById('closeImportStatus');
        const closeFooterBtn = document.getElementById('importStatusCloseBtn');
        const modal = document.getElementById('importStatusModal');
        
        if (closeBtn) {
            closeBtn.addEventListener('click', () => this.hideImportStatus());
        }
        
        if (closeFooterBtn) {
            closeFooterBtn.addEventListener('click', () => this.hideImportStatus());
        }
        
        // Close modal when clicking outside of it
        if (modal) {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.hideImportStatus();
                }
            });
        }
        
        // Handle Escape key to close modal
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
                this.hideImportStatus();
            }
        });
    }
}

// Global error handlers
window.addEventListener('unhandledrejection', (event) => {
    ErrorHandler.log(event.reason, 'Unhandled Promise Rejection', APP_CONSTANTS.ERROR_TYPES.DATABASE);
    event.preventDefault(); // Prevent default browser error handling
});

window.addEventListener('error', (event) => {
    ErrorHandler.log(event.error || event.message || 'Unknown error', 'Global Error', APP_CONSTANTS.ERROR_TYPES.DATABASE);
});

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ILETSBApp();
});