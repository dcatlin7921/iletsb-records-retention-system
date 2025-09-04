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
        SUPERCEDED: 'superseded',
        DENIED: 'denied'
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
            message: error.message || error,
            stack: error.stack
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
        this.dbVersion = APP_CONSTANTS.DB_VERSION;
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
            await this.migrateData();
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

                // Create schedules object store
                if (!db.objectStoreNames.contains('schedules')) {
                    const scheduleStore = db.createObjectStore('schedules', { autoIncrement: true });
                    scheduleStore.createIndex('application_number', 'application_number', { unique: true });
                    scheduleStore.createIndex('approval_status', 'approval_status', { unique: false });
                    scheduleStore.createIndex('approval_date', 'approval_date', { unique: false });
                } else if (oldVersion < 2) {
                    // Migration for existing schedules store
                    const transaction = event.target.transaction;
                    const scheduleStore = transaction.objectStore('schedules');
                    
                    // Remove old indices
                    try { scheduleStore.deleteIndex('schedule_number'); } catch (e) {}
                    
                    // Add new indices
                    try { scheduleStore.createIndex('application_number', 'application_number', { unique: true }); } catch (e) {}
                }

                // Create series_items object store
                if (!db.objectStoreNames.contains('series_items')) {
                    const seriesStore = db.createObjectStore('series_items', { autoIncrement: true });
                    seriesStore.createIndex('schedule_id', 'schedule_id', { unique: false });
                    seriesStore.createIndex('schedule_item', ['schedule_id', 'item_number'], { unique: true });
                    seriesStore.createIndex('division', 'division', { unique: false });
                    seriesStore.createIndex('retention_is_permanent', 'retention_is_permanent', { unique: false });
                    seriesStore.createIndex('record_series_title', 'record_series_title', { unique: false });
                } else if (oldVersion < 2) {
                    // Migration for existing series_items store
                    const transaction = event.target.transaction;
                    const seriesStore = transaction.objectStore('series_items');
                    
                    // Remove old indices
                    try { seriesStore.deleteIndex('schedule_number'); } catch (e) {}
                    try { seriesStore.deleteIndex('series_number'); } catch (e) {}
                    try { seriesStore.deleteIndex('retention_term'); } catch (e) {}
                    
                    // Add new indices
                    try { seriesStore.createIndex('schedule_id', 'schedule_id', { unique: false }); } catch (e) {}
                    try { seriesStore.createIndex('schedule_item', ['schedule_id', 'item_number'], { unique: true }); } catch (e) {}
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

    async migrateData() {
        try {
            const schedules = await this.getAllSchedules();
            const seriesItems = await this.getAllSeriesItems();
            
            // Pre-pass: ensure uniqueness of schedules.application_number by nulling duplicates
            // Use direct IndexedDB operations to bypass validation constraints
            const seenAppNums = new Set();
            const duplicatesToFix = [];
            
            for (const sched of schedules) {
                const appNum = (sched.application_number || '').trim();
                if (!appNum) continue; // skip empties
                if (seenAppNums.has(appNum)) {
                    duplicatesToFix.push({ schedule: sched, duplicateAppNum: appNum });
                } else {
                    seenAppNums.add(appNum);
                }
            }
            
            // Fix duplicates using direct IndexedDB operations
            if (duplicatesToFix.length > 0) {
                console.log(`Found ${duplicatesToFix.length} duplicate application_number values, fixing...`);
                const transaction = this.db.transaction(['schedules'], 'readwrite');
                const store = transaction.objectStore('schedules');
                
                for (const { schedule, duplicateAppNum } of duplicatesToFix) {
                    try {
                        // Null out duplicate natural key; retain human context in notes
                        schedule.application_number = null;
                        schedule.notes = [schedule.notes, `(migration) cleared duplicate application_number ${duplicateAppNum}`]
                            .filter(Boolean)
                            .join(' ');
                        await new Promise((resolve, reject) => {
                            const request = store.put(schedule);
                            request.onsuccess = () => resolve();
                            request.onerror = () => reject(request.error);
                        });
                    } catch (e) {
                        // Log but continue migration
                        ErrorHandler.log(e, `Clearing duplicate application_number ${duplicateAppNum}`);
                    }
                }
                
                await new Promise((resolve, reject) => {
                    transaction.oncomplete = () => resolve();
                    transaction.onerror = () => reject(transaction.error);
                });
            }

            // Step 1: Migrate schedules - normalize approval_status and remove deprecated fields
            for (const schedule of schedules) {
                let needsUpdate = false;
                
                // Normalize approval_status to lowercase enum
                if (schedule.approval_status && typeof schedule.approval_status === 'string') {
                    const normalized = schedule.approval_status.toLowerCase();
                    if (Object.values(APP_CONSTANTS.APPROVAL_STATUS).includes(normalized)) {
                        schedule.approval_status = normalized;
                        needsUpdate = true;
                    }
                }
                
                // Remove deprecated schedule_number field
                if ('schedule_number' in schedule) {
                    delete schedule.schedule_number;
                    needsUpdate = true;
                }
                
                
                if (needsUpdate) {
                    await this.saveSchedule(schedule, true);
                }
            }
            
            // Step 2: Migrate series items - add schedule_id FK and normalize fields
            for (const item of seriesItems) {
                let needsUpdate = false;
                
                // Add schedule_id foreign key
                if (!item.schedule_id) {
                    const scheduleRef = item.application_number || item.schedule_number;
                    if (scheduleRef) {
                        const relatedSchedule = schedules.find(s => s.application_number === scheduleRef);
                        if (relatedSchedule) {
                            item.schedule_id = relatedSchedule._id;
                            needsUpdate = true;
                        }
                    }
                }
                
                // Remove deprecated fields
                if ('schedule_number' in item) {
                    delete item.schedule_number;
                    needsUpdate = true;
                }
                if ('series_number' in item) {
                    delete item.series_number;
                    needsUpdate = true;
                }
                
                // Normalize dates_covered fields
                if (item.dates_covered_start === 'present') {
                    item.dates_covered_start = null;
                    item.open_ended_start = true;
                    needsUpdate = true;
                }
                if (item.dates_covered_end === 'present') {
                    item.dates_covered_end = null;
                    item.open_ended_end = true;
                    needsUpdate = true;
                }
                
                // Convert string lists to arrays
                const listFields = ['media_types', 'related_series', 'omb_or_statute_refs'];
                for (const field of listFields) {
                    if (item[field] && typeof item[field] === 'string') {
                        item[field] = item[field].split(/[,;]/).map(s => s.trim()).filter(s => s);
                        needsUpdate = true;
                    } else if (!Array.isArray(item[field])) {
                        item[field] = [];
                        needsUpdate = true;
                    }
                }
                
                // Structure retention object
                if (!item.retention || typeof item.retention !== 'object') {
                    item.retention = {
                        trigger: item.retention_trigger || '',
                        stages: [],
                        final_disposition: item.retention_is_permanent ? 'permanent' : 'destroy'
                    };
                    
                    // Parse retention_text into stages if available
                    if (item.retention_text) {
                        const stages = this.parseRetentionStages(item.retention_text);
                        item.retention.stages = stages;
                    }
                    
                    needsUpdate = true;
                }
                
                if (needsUpdate) {
                    await this.saveSeriesItem(item, true);
                }
            }
            
            console.log('Data migration completed successfully');
        } catch (error) {
            ErrorHandler.log(error, 'Data migration');
            console.error('Migration failed:', error);
        }
    }
    
    parseRetentionStages(retentionText) {
        // Simple parser for retention text like "Retain 2 years, then transfer 4 years, then destroy"
        const stages = [];
        const text = retentionText.toLowerCase();
        
        // Look for patterns like "retain X years", "transfer X years", etc.
        const patterns = [
            /retain\s+(\d+)\s+years?/,
            /transfer.*?(\d+)\s+years?/,
            /destroy/,
            /permanent/
        ];
        
        let match;
        if (match = text.match(/retain\s+(\d+)\s+years?/)) {
            stages.push({ action: 'retain_in_office', duration_years: parseInt(match[1]) });
        }
        if (match = text.match(/transfer.*?(\d+)\s+years?/)) {
            stages.push({ action: 'transfer_to_records_center', duration_years: parseInt(match[1]) });
        }
        if (text.includes('destroy')) {
            stages.push({ action: 'destroy_securely' });
        }
        
        return stages;
    }

    // Database Operations
    async getAllSchedules() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['schedules'], 'readonly');
            const store = transaction.objectStore('schedules');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async getAllSeriesItems() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    async saveSchedule(schedule, isUpdate = false) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['schedules'], 'readwrite');
            const store = transaction.objectStore('schedules');
            
            const now = new Date().toISOString();
            if (!isUpdate) {
                schedule.created_at = now;
                schedule.version = 1;
            }
            schedule.updated_at = now;
            
            const request = isUpdate ? store.put(schedule, schedule._id) : store.add(schedule);
            
            request.onsuccess = () => {
                const id = request.result;
                schedule._id = id;
                this.logAuditEvent('schedule', id, isUpdate ? 'update' : 'create', { application_number: schedule.application_number });
                resolve(schedule);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async saveSeriesItem(item, isUpdate = false) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series_items'], 'readwrite');
            const store = transaction.objectStore('series_items');
            
            const now = new Date().toISOString();
            if (!isUpdate) {
                item.created_at = now;
            }
            item.updated_at = now;
            
            const request = isUpdate ? store.put(item, item._id) : store.add(item);
            
            request.onsuccess = () => {
                const id = request.result;
                item._id = id;
                this.logAuditEvent('series', id, isUpdate ? 'update' : 'create', { 
                    application_number: item.application_number, 
                    item_number: item.item_number 
                });
                resolve(item);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSchedule(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['schedules'], 'readwrite');
            const store = transaction.objectStore('schedules');
            const request = store.delete(id);
            
            request.onsuccess = () => {
                this.logAuditEvent('schedule', id, 'delete', {});
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSeriesItem(id) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series_items'], 'readwrite');
            const store = transaction.objectStore('series_items');
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
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
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
                    // Need to cross-reference with schedules
                    // For now, skip this filter
                }
                
                if (filters.permanentOnly !== null) {
                    items = items.filter(item => item.retention_is_permanent === filters.permanentOnly);
                }
                
                if (filters.termOnly !== null) {
                    items = items.filter(item => !item.retention_is_permanent === filters.termOnly);
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
        document.getElementById('applicationFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('divisionFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('statusFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('permanentFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('termFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('retentionCategoryFilter').addEventListener('change', () => this.applyFilters());
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

        // Retention toggle
        document.getElementById('isPermanent').addEventListener('change', (e) => {
            const retentionTermGroup = document.getElementById('retentionTermGroup');
            if (retentionTermGroup) {
                retentionTermGroup.style.display = e.target.checked ? 'none' : 'block';
                if (e.target.checked) {
                    const retentionTermInput = document.getElementById('retentionTerm');
                    if (retentionTermInput) {
                        retentionTermInput.value = '';
                    }
                }
            }
        });

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

        // Byte converters
        document.querySelectorAll('.converter-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const multiplier = parseInt(e.target.dataset.multiplier);
                const input = e.target.closest('.form-group').querySelector('input[type="number"]');
                if (input && input.value) {
                    const currentValue = parseFloat(input.value);
                    input.value = Math.round(currentValue * multiplier);
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
        
        // Load schedules with cursor
        await this.loadSchedulesWithCursor();
        
        // Load series items count only for UI updates
        this.totalSeriesCount = await this.getSeriesItemsCount();
        
        this.populateFilterDropdowns();
        await this.renderResults();
        this.updateResultsSummary();
        this.updateRecordCount();
    }

    async loadSchedulesWithCursor(limit = null, offset = 0) {
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
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
            const request = store.count();
            
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async applyFilters() {
        const searchInput = document.getElementById('searchInput');
        const applicationFilter = document.getElementById('applicationFilter');
        const divisionFilter = document.getElementById('divisionFilter');
        const statusFilter = document.getElementById('statusFilter');
        const permanentFilter = document.getElementById('permanentFilter');
        const termFilter = document.getElementById('termFilter');

        // Check if elements exist before accessing values
        if (!searchInput || !applicationFilter || !divisionFilter || !statusFilter || !permanentFilter || !termFilter) {
            ErrorHandler.log(new Error('Filter elements not found'), 'Apply filters', APP_CONSTANTS.ERROR_TYPES.VALIDATION);
            return;
        }

        const filters = {
            searchText: searchInput.value.trim(),
            scheduleNumber: applicationFilter.value,
            division: divisionFilter.value,
            approvalStatus: statusFilter.value,
            permanentOnly: permanentFilter.checked ? true : null,
            termOnly: termFilter.checked ? true : null
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
            'searchInput', 'applicationFilter', 'divisionFilter', 
            'statusFilter', 'permanentFilter', 'termFilter', 'retentionCategoryFilter',
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
            this.schedules = await this.getAllSchedules();
            this.seriesItems = await this.getAllSeriesItems();
            this.filteredItems = [...this.seriesItems];

            // Normalize existing records so relationships are consistent
            await this.normalizeExistingData();
            
            this.populateFilterDropdowns();
            // Keep the Series form schedule dropdown in sync with schedules
            if (typeof this.populateSeriesScheduleDropdown === 'function') {
                this.populateSeriesScheduleDropdown();
            }
            // Diagnostic: log series items whose schedule reference has no matching schedule
            try {
                const scheduleSet = this.getScheduleNumberSet();
                const orphans = this.seriesItems.filter(si => {
                    const ref = si.application_number;
                    return !!ref && !scheduleSet.has(ref);
                });
                if (orphans.length > 0) {
                    // Non-fatal notice in console and UI status for awareness
                    console.warn('Orphan series items (no matching schedule):', orphans.map(o => ({ id: o._id, scheduleRef: o.application_number, item: o.item_number, title: o.record_series_title })));
                    this.setStatus(`${orphans.length} series item(s) reference a missing schedule.`, 'warning');
                }
            } catch (diagErr) {
                // Do not block UI if diagnostics fail
                console.warn('Diagnostics failed', diagErr);
            }
            this.renderResults();
            this.updateResultsSummary();
            this.updateRecordCount();
        } catch (error) {
            ErrorHandler.log(error, 'UI update');
        }
    }

    populateFilterDropdowns() {
        // Schedule numbers
        const scheduleNumbers = [...new Set(this.schedules.map(s => s.application_number).filter(n => n))];
        const scheduleSelect = document.getElementById('applicationFilter');
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
        const select = document.getElementById('seriesAppNum');
        if (!select) return;

        // Preserve current selection (schedule_id as string)
        const currentValue = select.value;

        // Build sorted list by application_number for display
        const schedules = (this.schedules || [])
            .filter(s => s && s._id != null && s.application_number)
            .sort((a, b) => String(a.application_number).localeCompare(String(b.application_number)));

        DOMHelper.clearElement(select);
        select.appendChild(DOMHelper.createOption('', 'Select a schedule…'));

        schedules.forEach(s => {
            // value = internal schedule_id, label = application_number
            const opt = DOMHelper.createOption(String(s._id), s.application_number);
            opt.setAttribute('data-application-number', s.application_number);
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
            if (s.application_number) set.add(s.application_number);
        });
        return set;
    }

    // Normalize existing records so both legacy and canonical fields are in sync
    async normalizeExistingData() {
        // Normalize schedules
        for (const sched of this.schedules) {
            const desired = sched.application_number || sched.schedule_number || '';
            if (!desired) continue;
            const needsUpdate = (sched.application_number !== desired) || ('schedule_number' in sched);
            if (needsUpdate) {
                sched.application_number = desired;
                if ('schedule_number' in sched) delete sched.schedule_number;
                try { await this.saveSchedule(sched, true); } catch (e) { ErrorHandler.log(e, 'Normalize schedule'); }
            }
        }

        // Normalize series items
        for (const si of this.seriesItems) {
            const schedNum = si.application_number || si.schedule_number || '';
            const seriesNum = si.item_number || si.series_number || '';
            const needsUpdate = (si.application_number !== schedNum) || ('schedule_number' in si) || (si.item_number !== seriesNum) || ('series_number' in si);
            if (needsUpdate) {
                if (schedNum) { si.application_number = schedNum; }
                if (seriesNum) { si.item_number = seriesNum; }
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
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
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
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
            const request = store.openCursor();
            
            const items = [];
            let currentIndex = 0;
            let foundItems = 0;
            
            request.onsuccess = (event) => {
                const cursor = event.target.result;
                if (cursor) {
                    if (this.matchesCurrentFilters(cursor.value)) {
                        if (currentIndex >= offset && foundItems < limit) {
                            items.push({ ...cursor.value, _id: cursor.key });
                            foundItems++;
                        }
                        currentIndex++;
                        
                        if (foundItems >= limit) {
                            resolve(items);
                            return;
                        }
                    }
                    cursor.continue();
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
        const permanentFilter = document.getElementById('permanentFilter')?.checked || false;
        const termFilter = document.getElementById('termFilter')?.checked || false;
        const retentionCategoryFilter = document.getElementById('retentionCategoryFilter')?.value || '';
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
                item.application_number,
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

        // Application number filter
        if (applicationFilter && item.application_number !== applicationFilter) {
            return false;
        }

        // Division filter
        if (divisionFilter && item.division !== divisionFilter) {
            return false;
        }

        // Status filter
        if (statusFilter) {
            const schedule = this.schedules.find(s => s.application_number === item.application_number);
            const approvalStatus = schedule ? (schedule.approval_status || 'Unapproved') : 'Unapproved';
            if (approvalStatus !== statusFilter) return false;
        }

        // Retention type filters
        if (permanentFilter && termFilter) {
            // Both selected - show all
        } else if (permanentFilter && !item.retention_is_permanent) {
            return false;
        } else if (termFilter && item.retention_is_permanent) {
            return false;
        } else if (!permanentFilter && !termFilter) {
            // Neither selected - show all
        }

        // Retention category filter
        if (retentionCategoryFilter) {
            const category = this.getRetentionCategory(item);
            if (category !== retentionCategoryFilter) {
                return false;
            }
        }

        // Approval date range filter (uses schedule.approval_date)
        if (approvalDateStart || approvalDateEnd) {
            const schedule = this.schedules.find(s => s.application_number === item.application_number);
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
        if (item.retention_is_permanent) {
            return 'permanent';
        } else if (item.retention_term && item.retention_term > 0) {
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
            const uniqueScheduleNumbers = [...new Set(this.seriesItems.map(s => s.application_number).filter(n => n))];
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
        } else if (item.application_number) {
            // Fallback for legacy data
            relatedSchedule = this.schedules.find(s => s.application_number === item.application_number);
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
            'seriesAppNum': (item.schedule_id != null ? String(item.schedule_id) : ''),
            'itemNumber': item.item_number || '',
            'seriesTitle': item.record_series_title || '',
            'seriesDescription': item.description || '',
            'datesStart': item.dates_covered_start || '',
            'datesEnd': item.dates_covered_end || '',
            'seriesDivision': item.division || '',
            'seriesContact': item.contact || '',
            'seriesLocation': item.location || '',
            'retentionTerm': item.retention_term || '',
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
        const isPermanentCheckbox = document.getElementById('isPermanent');
        const auditHoldCheckbox = document.getElementById('auditHold');
        const litigationHoldCheckbox = document.getElementById('litigationHold');

        if (isPermanentCheckbox) isPermanentCheckbox.checked = item.retention_is_permanent || false;
        if (auditHoldCheckbox) auditHoldCheckbox.checked = item.audit_hold_required || false;
        if (litigationHoldCheckbox) litigationHoldCheckbox.checked = item.litigation_hold_required || false;

        // Toggle retention term visibility
        const retentionTermGroup = document.getElementById('retentionTermGroup');
        if (retentionTermGroup) {
            retentionTermGroup.style.display = item.retention_is_permanent ? 'none' : 'block';
        }
    }

    populateScheduleForm(schedule) {
        const fields = {
            'scheduleAppNum': schedule.application_number || '',
            'approvalStatus': schedule.approval_status || 'draft',
            'approvalDate': schedule.approval_date || '',
            'scheduleNotes': schedule.notes || ''
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
        const retentionTermGroup = document.getElementById('retentionTermGroup');
        const seriesAppNumInput = document.getElementById('seriesAppNum');
        
        if (deleteSeriesBtn) deleteSeriesBtn.classList.add('hidden');
        if (retentionTermGroup) retentionTermGroup.style.display = 'block';
        // Populate the schedule dropdown and focus it
        this.populateSeriesScheduleDropdown();
        if (seriesAppNumInput) seriesAppNumInput.focus();
    }

    async handleScheduleSubmit(e) {
        e.preventDefault();
        
        const schedule = {
            application_number: document.getElementById('scheduleAppNum').value,
            approval_status: document.getElementById('approvalStatus').value.toLowerCase(),
            approval_date: document.getElementById('approvalDate').value,
            notes: document.getElementById('scheduleNotes').value
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
        const seriesAppNumEl = document.getElementById('seriesAppNum');
        const itemNumberEl = document.getElementById('itemNumber');
        const seriesTitleEl = document.getElementById('seriesTitle');
        
        console.log('Field elements found:', {
            seriesAppNum: !!seriesAppNumEl,
            itemNumber: !!itemNumberEl,
            seriesTitle: !!seriesTitleEl
        });
        
        if (!seriesAppNumEl) {
            console.error('seriesAppNum element not found');
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
        
        if (!seriesAppNumEl.value.trim()) {
            this.setStatus('Schedule is required', 'error');
            return;
        }
        // Relationship validation: ensure selected schedule exists by internal id
        const selectedScheduleIdStr = seriesAppNumEl.value.trim();
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
            application_number: relatedSchedule.application_number,
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
            retention_term: parseFloat(document.getElementById('retentionTerm').value) || null,
            retention_is_permanent: document.getElementById('isPermanent').checked,
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
            audit_hold_required: document.getElementById('auditHold').checked,
            litigation_hold_required: document.getElementById('litigationHold').checked,
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
                    `Item number "${item.item_number}" already exists for application "${item.application_number}". Do you want to continue anyway?`
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
            const schedules = await this.getAllSchedules();
            const seriesItems = await this.getAllSeriesItems();
            
            // Remove internal keys for export
            const exportSchedules = schedules.map(s => {
                const {_id, ...exportItem} = s;
                return exportItem;
            });
            
            const exportSeriesItems = seriesItems.map(s => {
                const {_id, ...exportItem} = s;
                return exportItem;
            });
            
            const exportData = {
                exported_at: new Date().toISOString(),
                version: 1,
                agency: {
                    name: "Illinois Law Enforcement Training and Standards Board",
                    abbrev: "ILETSB"
                },
                schedules: exportSchedules,
                series_items: exportSeriesItems,
                audit_events: []
            };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `iletsb-records-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            await this.logAuditEvent('system', null, 'export', { recordCount: schedules.length + seriesItems.length });
            this.setStatus('Data exported successfully', 'success');
        } catch (error) {
            ErrorHandler.log(error, 'Data export', APP_CONSTANTS.ERROR_TYPES.EXPORT);
            this.setStatus('Error exporting data: ' + error.message, 'error');
        }
    }

    async importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const data = JSON.parse(text);
            
            // Validate JSON structure
            const validation = this.validateImportData(data);
            if (!validation.valid) {
                throw new Error(`Invalid file format: ${validation.errors.join(', ')}`);
            }

            const results = {
                schedules: { created: 0, updated: 0, skipped: 0, errors: [] },
                seriesItems: { created: 0, updated: 0, skipped: 0, errors: [] },
                auditEvents: { created: 0, updated: 0, skipped: 0, errors: [] }
            };

            // Build mapping from application_number to schedule_id
            const scheduleIdMap = new Map();
            
            // Import schedules with upsert logic and build mapping
            for (const schedule of data.schedules) {
                try {
                    const result = await this.upsertSchedule(schedule);
                    results.schedules[result.action]++;
                    
                    // Store the mapping from application_number to _id
                    if (result.schedule) {
                        scheduleIdMap.set(schedule.application_number, result.schedule._id);
                    }
                } catch (error) {
                    results.schedules.errors.push(`Schedule ${schedule.application_number}: ${error.message}`);
                    results.schedules.skipped++;
                }
            }

            // Import series items with proper schedule_id mapping
            for (const item of data.series_items) {
                try {
                    const scheduleId = scheduleIdMap.get(item.application_number);
                    if (!scheduleId) {
                        throw new Error(`No matching schedule found for application_number: ${item.application_number}`);
                    }
                    
                    // Create item with proper schedule_id
                    const itemWithScheduleId = {
                        ...item,
                        schedule_id: scheduleId
                    };
                    
                    const result = await this.upsertSeriesItem(itemWithScheduleId);
                    results.seriesItems[result.action]++;
                } catch (error) {
                    results.seriesItems.errors.push(`Series ${item.application_number}-${item.item_number}: ${error.message}`);
                    results.seriesItems.skipped++;
                }
            }

            // Import and fix audit events with proper entity_id mapping
            if (data.audit_events && Array.isArray(data.audit_events)) {
                const oldToNewIdMap = new Map();
                
                // Build reverse mapping from old entity_id to new entity_id
                // This assumes audit events reference schedules/series_items by their old IDs
                data.audit_events.forEach(event => {
                    if (event.entity === 'schedule' && event.payload) {
                        const payload = JSON.parse(event.payload || '{}');
                        const applicationNumber = payload.application_number;
                        if (applicationNumber && scheduleIdMap.has(applicationNumber)) {
                            oldToNewIdMap.set(event.entity_id, scheduleIdMap.get(applicationNumber));
                        }
                    } else if (event.entity === 'series') {
                        // For series items, we need to map based on application_number + item_number
                        // This is more complex and may need additional logic
                        const payload = JSON.parse(event.payload || '{}');
                        const applicationNumber = payload.application_number;
                        const itemNumber = payload.item_number;
                        
                        if (applicationNumber && scheduleIdMap.has(applicationNumber)) {
                            // Find the corresponding series item by schedule_id and item_number
                            // This would require additional mapping logic
                            // For now, we'll preserve the original entity_id as-is
                        }
                    }
                });
                
                // Import audit events with updated entity_id mapping
                for (const auditEvent of data.audit_events) {
                    try {
                        const newEntityId = oldToNewIdMap.get(auditEvent.entity_id) || auditEvent.entity_id;
                        
                        const auditEventWithNewId = {
                            ...auditEvent,
                            entity_id: newEntityId,
                            payload: JSON.stringify({
                                ...JSON.parse(auditEvent.payload || '{}'),
                                original_entity_id: auditEvent.entity_id // Preserve original for reference
                            })
                        };
                        
                        await this.saveAuditEvent(auditEventWithNewId);
                        results.auditEvents.created++;
                    } catch (error) {
                        results.auditEvents.errors.push(`Audit event: ${error.message}`);
                        results.auditEvents.skipped++;
                    }
                }
            }

            await this.logAuditEvent('system', null, 'import', results);
            
            // Show detailed import summary
            this.showImportSummary(results);
            await this.updateUI();
        } catch (error) {
            ErrorHandler.log(error, 'Data import', APP_CONSTANTS.ERROR_TYPES.IMPORT);
            this.setStatus('Error importing data: ' + error.message, 'error');
        }
        
        // Reset file input
        event.target.value = '';
    }

    validateImportData(data) {
        const errors = [];
        
        if (!data || typeof data !== 'object') {
            errors.push('Invalid JSON structure');
            return { valid: false, errors };
        }

        if (!data.schedules || !Array.isArray(data.schedules)) {
            errors.push('Missing or invalid schedules array');
        }

        if (!data.series_items || !Array.isArray(data.series_items)) {
            errors.push('Missing or invalid series_items array');
        }

        if (!data.agency || !data.agency.abbrev || data.agency.abbrev !== 'ILETSB') {
            errors.push('Invalid agency - must be ILETSB');
        }

        // Validate required fields in schedules
        data.schedules?.forEach((schedule, index) => {
            if (!schedule.application_number) {
                errors.push(`Schedule ${index + 1}: Missing application_number`);
            }
        });

        // Validate required fields in series items
        data.series_items?.forEach((item, index) => {
            if (!item.application_number) {
                errors.push(`Series item ${index + 1}: Missing application_number`);
            }
            if (!item.item_number) {
                errors.push(`Series item ${index + 1}: Missing item_number`);
            }
            if (!item.record_series_title) {
                errors.push(`Series item ${index + 1}: Missing record_series_title`);
            }
        });

        return { valid: errors.length === 0, errors };
    }

    async upsertSchedule(scheduleData) {
        if (!scheduleData.application_number) {
            throw new Error('Missing application_number');
        }

        // Check if schedule exists
        const existing = await this.findScheduleByApplicationNumber(scheduleData.application_number);
        
        const schedule = {
            ...scheduleData,
            updated_at: new Date().toISOString()
        };

        if (existing) {
            // Update existing schedule
            schedule._id = existing._id;
            schedule.created_at = existing.created_at;
            schedule.version = (existing.version || 1) + 1;
            await this.saveSchedule(schedule, true);
            return { action: 'updated', schedule };
        } else {
            // Create new schedule
            schedule.created_at = new Date().toISOString();
            schedule.version = 1;
            await this.saveSchedule(schedule);
            return { action: 'created', schedule };
        }
    }

    async upsertSeriesItem(itemData) {
        if (!itemData.schedule_id || !itemData.item_number) {
            throw new Error('Missing schedule_id or item_number');
        }

        // Check if series item exists using schedule_id and item_number
        const existing = await this.findSeriesItemByScheduleAndItem(itemData.schedule_id, itemData.item_number);
        
        const item = {
            ...itemData,
            updated_at: new Date().toISOString()
        };

        if (existing) {
            // Update existing item
            item._id = existing._id;
            item.created_at = existing.created_at;
            await this.saveSeriesItem(item, true);
            return { action: 'updated' };
        } else {
            // Create new item
            item.created_at = new Date().toISOString();
            await this.saveSeriesItem(item);
            return { action: 'created' };
        }
    }

    async findScheduleByApplicationNumber(applicationNumber) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['schedules'], 'readonly');
            const store = transaction.objectStore('schedules');
            const index = store.index('application_number');
            const request = index.get(applicationNumber);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async findSeriesItemByKey(applicationNumber, itemNumber) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
            const request = store.getAll();

            request.onsuccess = () => {
                const items = request.result;
                const found = items.find(item => 
                    item.application_number === applicationNumber && 
                    item.item_number === itemNumber
                );
                resolve(found);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async findSeriesItemByScheduleAndItem(scheduleId, itemNumber) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
            const index = store.index('schedule_item');
            const request = index.get([scheduleId, itemNumber]);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async checkDuplicateItemNumber(scheduleId, itemNumber, excludeId = null) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
            const index = store.index('schedule_item');
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
        const totalSchedules = results.schedules.created + results.schedules.updated;
        const totalSeries = results.seriesItems.created + results.seriesItems.updated;
        const totalAuditEvents = results.auditEvents?.created || 0;
        const totalErrors = results.schedules.errors.length + results.seriesItems.errors.length + (results.auditEvents?.errors?.length || 0);

        let message = `Import completed: ${totalSchedules} schedules (${results.schedules.created} new, ${results.schedules.updated} updated), ${totalSeries} series items (${results.seriesItems.created} new, ${results.seriesItems.updated} updated)`;
        
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

    async clearDatabase() {
        try {
            this.setStatus('Clearing database...', 'warning');

            // Close any open connections
            if (this.db) {
                try { this.db.close(); } catch {}
            }

            let deleteSucceeded = false;
            await new Promise((resolve, reject) => {
                const deleteRequest = indexedDB.deleteDatabase(this.dbName);
                deleteRequest.onerror = () => reject(deleteRequest.error || new Error('Failed to delete database'));
                deleteRequest.onblocked = () => {
                    // Advise user if multiple tabs are open
                    this.setStatus('Database deletion is blocked. Close other tabs of this app and try again.', 'error');
                    reject(new Error('Deletion blocked'));
                };
                deleteRequest.onsuccess = () => { deleteSucceeded = true; resolve(); };
            });

            // Reset in-memory state
            this.db = null;
            this.schedules = [];
            this.seriesItems = [];
            this.filteredItems = [];
            this.currentSchedule = null;
            this.currentSeriesItem = null;
            this.selectedItemId = null;
            this.virtualScroller = null;

            // Recreate empty DB schema
            await this.initDatabase();

            // Force-clear all stores for absolute certainty
            await new Promise((resolve, reject) => {
                const tx = this.db.transaction(['schedules','series_items','audit_events'], 'readwrite');
                tx.objectStore('schedules').clear();
                tx.objectStore('series_items').clear();
                tx.objectStore('audit_events').clear();
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error || new Error('Failed to clear stores'));
            });

            // Reset UI without calling updateUI() which would reload sample data
            this.clearFilters();
            // Clear results pane DOM immediately to avoid stale rows
            const resultsList = document.getElementById('resultsList');
            if (resultsList) {
                resultsList.scrollTop = 0;
                DOMHelper.clearElement(resultsList);
                const emptyState = document.getElementById('emptyState');
                if (emptyState) resultsList.appendChild(emptyState);
            }
            this.cancelScheduleEdit();
            this.cancelSeriesEdit();
            
            // Manually update UI components without loading sample data
            this.populateFilterDropdowns();
            this.updateResultsSummary();
            this.updateRecordCount();

            this.setStatus('Database cleared successfully', 'success');
            this.closeAdminMenu();
        } catch (error) {
            ErrorHandler.log(error, 'Clear database', APP_CONSTANTS.ERROR_TYPES.DATABASE);
            this.setStatus('Error clearing database: ' + (error.message || error), 'error');
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

        // Retention logic validation
        if (fieldId === 'retentionTerm') {
            const isPermanent = document.getElementById('retentionIsPermanent')?.checked;
            if (isPermanent && value) {
                this.showFieldError(field, 'Retention term should be empty for permanent records');
                return false;
            }
            if (!isPermanent && !value) {
                this.showFieldError(field, 'Retention term is required for non-permanent records');
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
            { key: 'retention_term', label: 'Retention Term (years)' },
            { key: 'retention_is_permanent', label: 'Is Permanent (true/false)' },
            { key: 'division', label: 'Division' },
            { key: 'contact', label: 'Contact' },
            { key: 'location', label: 'Location' },
            { key: 'representative_name', label: 'Representative Name' },
            { key: 'representative_title', label: 'Representative Title' },
            { key: 'representative_phone', label: 'Representative Phone' },
            { key: 'records_officer_name', label: 'Records Officer Name' },
            { key: 'records_officer_phone', label: 'Records Officer Phone' },
            { key: 'media_types', label: 'Media Types' },
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
                } else if (fieldName === 'retention_is_permanent') {
                    item[fieldName] = value.toLowerCase() === 'true' || value === '1';
                } else if (fieldName.includes('hold_required')) {
                    item[fieldName] = value.toLowerCase() === 'true' || value === '1';
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
            retentionFlags: this.flagRetentionKeywords(item.retention_text),
            hasAuditHold: item.audit_hold_required,
            hasLitigationHold: item.litigation_hold_required,
            isPermanent: item.retention_is_permanent
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
            const relatedScheduleNumbers = [...new Set(filteredItems.map(item => item.application_number))];
            const relatedSchedules = allSchedules.filter(schedule => relatedScheduleNumbers.includes(schedule.application_number));

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
            const transaction = this.db.transaction(['series_items'], 'readonly');
            const store = transaction.objectStore('series_items');
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
                    <td>${item.retention_is_permanent ? 'Permanent' : (item.retention_term ? `${item.retention_term} years` : 'Not specified')}</td>
                    <td>${this.formatDateRange(item.dates_covered_start, item.dates_covered_end)}</td>
                    <td>${completeness}%</td>
                    <td>${retentionFlags.join(', ') || 'None'}</td>
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
                            <th>Flags</th>
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

    async confirmDeleteSchedule() {
        if (!this.currentSchedule) return;
        
        // Check if schedule has series items
        const relatedSeries = this.seriesItems.filter(item => 
            item.schedule_id === this.currentSchedule._id || 
            item.application_number === this.currentSchedule.application_number
        );
        
        if (relatedSeries.length > 0) {
            if (this.currentSchedule.approval_status === APP_CONSTANTS.APPROVAL_STATUS.DRAFT) {
                // For drafts, allow cascade delete
                const confirmed = await this.showConfirmModal(
                    'Delete Draft Schedule',
                    `This draft schedule "${this.currentSchedule.application_number}" has ${relatedSeries.length} series item(s). Deleting the schedule will also delete all its series items. This action cannot be undone.`
                );
                
                if (!confirmed) return;
                
                try {
                    // Delete all related series items first
                    for (const item of relatedSeries) {
                        await this.deleteSeriesItem(item._id);
                    }
                    
                    await this.deleteSchedule(this.currentSchedule._id);
                    this.setStatus('Draft schedule and related series items deleted successfully', 'success');
                    await this.updateUI();
                    this.cancelScheduleEdit();
                } catch (error) {
                    ErrorHandler.log(error, 'Delete draft schedule', APP_CONSTANTS.ERROR_TYPES.DATABASE);
                    this.setStatus('Error deleting draft schedule: ' + error.message, 'error');
                }
            } else {
                // For approved schedules, block deletion
                this.setStatus(`Cannot delete approved schedule "${this.currentSchedule.application_number}" because it has ${relatedSeries.length} series item(s). Delete the series items first.`, 'error');
                return;
            }
        } else {
            // No related series, safe to delete
            const confirmed = await this.showConfirmModal(
                'Delete Schedule',
                `Are you sure you want to delete schedule "${this.currentSchedule.application_number}"? This action cannot be undone.`
            );
            
            if (!confirmed) return;
            
            try {
                await this.deleteSchedule(this.currentSchedule._id);
                this.setStatus('Schedule deleted successfully', 'success');
                await this.updateUI();
                this.cancelScheduleEdit();
            } catch (error) {
                ErrorHandler.log(error, 'Delete schedule', APP_CONSTANTS.ERROR_TYPES.DATABASE);
                this.setStatus('Error deleting schedule: ' + error.message, 'error');
            }
        }
    }

    async confirmDeleteSeriesItem() {
        if (!this.currentSeriesItem) return;
        
        const confirmed = await this.showConfirmModal(
            'Delete Series Item',
            `Are you sure you want to delete series item "${this.currentSeriesItem.item_number}: ${this.currentSeriesItem.record_series_title}"? This action cannot be undone.`
        );
        
        if (!confirmed) return;
        
        try {
            await this.deleteSeriesItem(this.currentSeriesItem._id);
            this.setStatus('Series item deleted successfully', 'success');
            await this.updateUI();
            this.cancelSeriesEdit();
        } catch (error) {
            ErrorHandler.log(error, 'Delete series item', APP_CONSTANTS.ERROR_TYPES.DATABASE);
            this.setStatus('Error deleting series item: ' + error.message, 'error');
        }
    }

    // Modal Management
    showModal(title, message, confirmCallback) {
        const modal = document.getElementById('confirmModal');
        const titleElement = document.getElementById('confirmTitle');
        const messageElement = document.getElementById('confirmMessage');
        const confirmBtn = document.getElementById('confirmBtn');

        if (titleElement) titleElement.textContent = title;
        if (messageElement) messageElement.textContent = message;
        if (modal) modal.classList.remove('hidden');
        
        this.confirmCallback = confirmCallback;
        
        if (confirmBtn) confirmBtn.focus();
    }

    hideModal() {
        const modal = document.getElementById('confirmModal');
        if (modal) modal.classList.add('hidden');
        this.confirmCallback = null;
    }

    handleConfirm() {
        if (this.confirmCallback) {
            this.confirmCallback();
        }
        this.hideModal();
    }

    // Utility Methods
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
}

// Global error handlers
window.addEventListener('unhandledrejection', (event) => {
    ErrorHandler.log(event.reason, 'Unhandled Promise Rejection', APP_CONSTANTS.ERROR_TYPES.DATABASE);
    event.preventDefault(); // Prevent default browser error handling
});

window.addEventListener('error', (event) => {
    ErrorHandler.log(event.error, 'Global Error', APP_CONSTANTS.ERROR_TYPES.DATABASE);
});

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    new ILETSBApp();
});