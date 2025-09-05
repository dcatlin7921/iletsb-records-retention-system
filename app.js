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
        this.dbVersion = 4; // v4: rename application_number to schedule_number
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
                const transaction = event.target.transaction;

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

                // v4: Update series store with new field names and indexes
                if (oldVersion < 4) {
                    // If series store exists, we need to migrate data
                    if (db.objectStoreNames.contains('series')) {
                        // Store existing data for migration
                        const oldStore = transaction.objectStore('series');
                        const migrationData = [];
                        
                        // Collect existing data
                        const getAllRequest = oldStore.getAll();
                        getAllRequest.onsuccess = () => {
                            const existingData = getAllRequest.result || [];
                            
                            // Delete old store
                            db.deleteObjectStore('series');
                            
                            // Create new store with updated schema
                            const seriesStore = db.createObjectStore('series', { keyPath: '_id', autoIncrement: true });
                            seriesStore.createIndex('schedule_number_item_number', ['schedule_number', 'item_number'], { unique: false });
                            seriesStore.createIndex('record_series_title', 'record_series_title', { unique: false });
                            seriesStore.createIndex('division', 'division', { unique: false });
                            seriesStore.createIndex('schedule_number', 'schedule_number', { unique: false });
                            seriesStore.createIndex('dates_covered_start', 'dates_covered_start', { unique: false });
                            seriesStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });
                            
                            // Migrate existing data
                            existingData.forEach(item => {
                                // Rename application_number to schedule_number
                                if (item.application_number && !item.schedule_number) {
                                    item.schedule_number = item.application_number;
                                }
                                delete item.application_number;
                                
                                // Ensure arrays are arrays
                                const toArr = v => Array.isArray(v) ? v :
                                    (typeof v === 'string' ? v.split(/[,;\n]/).map(x=>x.trim()).filter(Boolean) : []);
                                item.tags = toArr(item.tags);
                                item.media_types = toArr(item.media_types);
                                item.omb_or_statute_refs = toArr(item.omb_or_statute_refs);
                                item.related_series = toArr(item.related_series);
                                
                                // Ensure ui_extras exists
                                item.ui_extras = item.ui_extras || {};
                                
                                // Remove old fields that are no longer needed
                                delete item.retention_is_permanent;
                                delete item.schedule_id;
                                
                                seriesStore.add(item);
                            });
                        };
                    } else {
                        // Create new series store
                        const seriesStore = db.createObjectStore('series', { keyPath: '_id', autoIncrement: true });
                        seriesStore.createIndex('schedule_number_item_number', ['schedule_number', 'item_number'], { unique: false });
                        seriesStore.createIndex('record_series_title', 'record_series_title', { unique: false });
                        seriesStore.createIndex('division', 'division', { unique: false });
                        seriesStore.createIndex('schedule_number', 'schedule_number', { unique: false });
                        seriesStore.createIndex('dates_covered_start', 'dates_covered_start', { unique: false });
                        seriesStore.createIndex('tags', 'tags', { unique: false, multiEntry: true });
                    }
                } else if (!db.objectStoreNames.contains('series')) {
                    // Create new merged series object store for fresh installs
                    const seriesStore = db.createObjectStore('series', { keyPath: '_id', autoIncrement: true });
                    seriesStore.createIndex('schedule_number_item_number', ['schedule_number', 'item_number'], { unique: false });
                    seriesStore.createIndex('record_series_title', 'record_series_title', { unique: false });
                    seriesStore.createIndex('division', 'division', { unique: false });
                    seriesStore.createIndex('schedule_number', 'schedule_number', { unique: false });
                    seriesStore.createIndex('dates_covered_start', 'dates_covered_start', { unique: false });
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


    

    // Database Operations
    async getAllSchedules() {
        // Legacy method - now returns unique schedule info from series
        const series = await this.getAllSeries();
        const scheduleMap = new Map();
        
        series.forEach(item => {
            if (item.schedule_number) {
                const key = item.schedule_number;
                if (!scheduleMap.has(key)) {
                    scheduleMap.set(key, {
                        _id: `sched_${key}`,
                        schedule_number: item.schedule_number,
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
            if (!this.db) {
                console.error('Database not initialized');
                resolve([]);
                return;
            }
            
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const request = store.getAll();
            
            request.onsuccess = () => {
                const result = request.result || [];
                resolve(result);
            };
            request.onerror = () => {
                console.error('getAllSeries error:', request.error);
                reject(request.error);
            };
        });
    }

    async saveSchedule(schedule, isUpdate = false) {
        // Legacy method - now updates all series with matching schedule_number
        const series = await this.getAllSeries();
        const matchingSeries = series.filter(s => s.schedule_number === schedule.schedule_number);
        
        const promises = matchingSeries.map(seriesItem => {
            // Update schedule fields on the series item
            seriesItem.schedule_number = schedule.schedule_number;
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
                
                // Log audit event separately to avoid blocking the main operation
                setTimeout(() => {
                    this.logAuditEvent('series', id, isUpdate ? 'update' : 'create', { 
                        schedule_number: item.schedule_number,
                        item_number: item.item_number,
                        record_series_title: item.record_series_title
                    }).catch(err => {
                        ErrorHandler.log(err, 'Audit event logging');
                    });
                }, 0);
                
                resolve(item);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSchedule(id) {
        // Legacy method - now removes schedule assignment from all matching series
        const series = await this.getAllSeries();
        const scheduleNumber = id.replace('sched_', '');
        const matchingSeries = series.filter(s => s.schedule_number === scheduleNumber);
        
        const promises = matchingSeries.map(seriesItem => {
            // Remove schedule assignment fields
            delete seriesItem.schedule_number;
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

    // Modern Search and Filtering System
    async searchAndFilterSeries(searchCriteria = {}) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            
            // Use appropriate index if available
            let request;
            if (searchCriteria.scheduleNumber) {
                const index = store.index('schedule_number');
                request = index.getAll(searchCriteria.scheduleNumber);
            } else if (searchCriteria.division) {
                const index = store.index('division');
                request = index.getAll(searchCriteria.division);
            } else {
                request = store.getAll();
            }
            
            request.onsuccess = () => {
                let items = request.result || [];
                
                // Apply text search across multiple fields
                if (searchCriteria.searchText) {
                    const searchTerms = searchCriteria.searchText.toLowerCase().split(/\s+/).filter(term => term.length > 0);
                    items = items.filter(item => {
                        const searchableText = this.buildSearchableText(item).toLowerCase();
                        return searchTerms.every(term => searchableText.includes(term));
                    });
                }
                
                // Apply specific filters
                items = items.filter(item => this.matchesFilterCriteria(item, searchCriteria));
                
                // Apply sorting
                if (searchCriteria.sortBy) {
                    items = this.sortSeriesItems(items, searchCriteria.sortBy, searchCriteria.sortOrder);
                }
                
                resolve(items);
            };
            request.onerror = () => reject(request.error);
        });
    }

    buildSearchableText(item) {
        const fields = [
            item.record_series_title,
            item.schedule_number,
            item.item_number,
            item.division,
            item.retention_text,
            item.notes,
            Array.isArray(item.tags) ? item.tags.join(' ') : '',
            Array.isArray(item.media_types) ? item.media_types.join(' ') : '',
            Array.isArray(item.omb_or_statute_refs) ? item.omb_or_statute_refs.join(' ') : '',
            item.ui_extras?.seriesDescription || '',
            item.ui_extras?.seriesContact || '',
            item.ui_extras?.arrangement || ''
        ];
        return fields.filter(Boolean).join(' ');
    }

    matchesFilterCriteria(item, criteria) {
        // Schedule number filter
        if (criteria.scheduleNumber && item.schedule_number !== criteria.scheduleNumber) {
            return false;
        }
        
        // Division filter
        if (criteria.division && item.division !== criteria.division) {
            return false;
        }
        
        // Approval status filter
        if (criteria.approvalStatus && item.approval_status !== criteria.approvalStatus) {
            return false;
        }
        
        // Date range filters
        if (criteria.approvalDateStart || criteria.approvalDateEnd) {
            if (!this.isDateInRange(item.approval_date, criteria.approvalDateStart, criteria.approvalDateEnd)) {
                return false;
            }
        }
        
        if (criteria.coverageDateStart || criteria.coverageDateEnd) {
            if (!this.isCoverageDateInRange(item, criteria.coverageDateStart, criteria.coverageDateEnd)) {
                return false;
            }
        }
        
        // Tag filter
        if (criteria.tags && criteria.tags.length > 0) {
            const itemTags = Array.isArray(item.tags) ? item.tags : [];
            if (!criteria.tags.some(tag => itemTags.includes(tag))) {
                return false;
            }
        }
        
        // Media type filter
        if (criteria.mediaTypes && criteria.mediaTypes.length > 0) {
            const itemMediaTypes = Array.isArray(item.media_types) ? item.media_types : [];
            if (!criteria.mediaTypes.some(type => itemMediaTypes.includes(type))) {
                return false;
            }
        }
        
        return true;
    }

    sortSeriesItems(items, sortBy, sortOrder = 'asc') {
        return items.sort((a, b) => {
            let aVal = this.getSortValue(a, sortBy);
            let bVal = this.getSortValue(b, sortBy);
            
            // Handle null/undefined values
            if (aVal == null && bVal == null) return 0;
            if (aVal == null) return sortOrder === 'asc' ? 1 : -1;
            if (bVal == null) return sortOrder === 'asc' ? -1 : 1;
            
            // Convert to strings for comparison
            aVal = String(aVal).toLowerCase();
            bVal = String(bVal).toLowerCase();
            
            const comparison = aVal.localeCompare(bVal, undefined, { numeric: true });
            return sortOrder === 'asc' ? comparison : -comparison;
        });
    }

    getSortValue(item, sortBy) {
        switch (sortBy) {
            case 'schedule_item':
                return `${item.schedule_number || 'zzz'}-${item.item_number || 'zzz'}`;
            case 'dates_covered_start':
                return this.normalizeDateForSorting(item.dates_covered_start);
            case 'approval_date':
                return this.normalizeDateForSorting(item.approval_date);
            case 'updated_at':
                return item.updated_at || '';
            default:
                return item[sortBy] || '';
        }
    }

    normalizeDateForSorting(dateStr) {
        if (!dateStr) return '0000';
        if (dateStr.toLowerCase() === 'present') return '9999';
        
        // Extract year for sorting
        const yearMatch = dateStr.match(/(\d{4})/);
        return yearMatch ? yearMatch[1] : '0000';
    }

    isDateInRange(dateStr, startDate, endDate) {
        if (!dateStr) return !startDate && !endDate;
        
        const year = this.extractYear(dateStr);
        if (!year) return false;
        
        if (startDate && year < parseInt(startDate)) return false;
        if (endDate && year > parseInt(endDate)) return false;
        
        return true;
    }

    isCoverageDateInRange(item, startDate, endDate) {
        const startYear = this.extractYear(item.dates_covered_start);
        const endYear = this.extractYear(item.dates_covered_end);
        
        if (startDate) {
            const filterStart = parseInt(startDate);
            if (startYear && startYear > filterStart) return false;
            if (!startYear && endYear && endYear < filterStart) return false;
        }
        
        if (endDate) {
            const filterEnd = parseInt(endDate);
            if (endYear && endYear !== 9999 && endYear < filterEnd) return false;
            if (!endYear && startYear && startYear > filterEnd) return false;
        }
        
        return true;
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
        if (seriesForm) {
            seriesForm.addEventListener('submit', (e) => this.handleSeriesSubmit(e));
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
        try {
            const searchCriteria = this.buildSearchCriteria();
            this.filteredItems = await this.searchAndFilterSeries(searchCriteria);
            
            // Update UI
            await this.renderResults();
            this.updateResultsSummary();
            this.updateFilterSummary();
            
        } catch (error) {
            ErrorHandler.log(error, 'Apply filters');
            this.setStatus('Error applying filters: ' + error.message, 'error');
        }
    }

    buildSearchCriteria() {
        const criteria = {};
        
        // Text search
        const searchInput = document.getElementById('searchInput');
        if (searchInput?.value.trim()) {
            criteria.searchText = searchInput.value.trim();
        }
        
        // Schedule number filter
        const scheduleFilter = document.getElementById('scheduleFilter');
        if (scheduleFilter?.value) {
            criteria.scheduleNumber = scheduleFilter.value;
        }
        
        // Division filter
        const divisionFilter = document.getElementById('divisionFilter');
        if (divisionFilter?.value) {
            criteria.division = divisionFilter.value;
        }
        
        // Approval status filter
        const statusFilter = document.getElementById('statusFilter');
        if (statusFilter?.value) {
            criteria.approvalStatus = statusFilter.value;
        }
        
        // Date range filters
        const approvalDateStart = document.getElementById('approvalDateStart');
        if (approvalDateStart?.value) {
            criteria.approvalDateStart = approvalDateStart.value;
        }
        
        const approvalDateEnd = document.getElementById('approvalDateEnd');
        if (approvalDateEnd?.value) {
            criteria.approvalDateEnd = approvalDateEnd.value;
        }
        
        const coverageDateStart = document.getElementById('coverageDateStart');
        if (coverageDateStart?.value) {
            criteria.coverageDateStart = coverageDateStart.value;
        }
        
        const coverageDateEnd = document.getElementById('coverageDateEnd');
        if (coverageDateEnd?.value) {
            criteria.coverageDateEnd = coverageDateEnd.value;
        }
        
        // Tag filter (if implemented in UI)
        const tagFilter = document.getElementById('tagFilter');
        if (tagFilter?.value) {
            criteria.tags = tagFilter.value.split(',').map(tag => tag.trim()).filter(Boolean);
        }
        
        // Sorting
        const sortBy = document.getElementById('sortBy');
        if (sortBy?.value) {
            criteria.sortBy = sortBy.value;
        }
        
        const sortOrder = document.getElementById('sortOrder');
        if (sortOrder?.value) {
            criteria.sortOrder = sortOrder.value;
        }
        
        return criteria;
    }

    updateFilterSummary() {
        const summary = document.getElementById('filterSummary');
        if (!summary) return;
        
        const criteria = this.buildSearchCriteria();
        const activeFilters = [];
        
        if (criteria.searchText) activeFilters.push(`Text: "${criteria.searchText}"`);
        if (criteria.scheduleNumber) activeFilters.push(`Schedule: ${criteria.scheduleNumber}`);
        if (criteria.division) activeFilters.push(`Division: ${criteria.division}`);
        if (criteria.approvalStatus) activeFilters.push(`Status: ${criteria.approvalStatus}`);
        if (criteria.approvalDateStart || criteria.approvalDateEnd) {
            const dateRange = `${criteria.approvalDateStart || 'start'} - ${criteria.approvalDateEnd || 'end'}`;
            activeFilters.push(`Approval: ${dateRange}`);
        }
        if (criteria.coverageDateStart || criteria.coverageDateEnd) {
            const dateRange = `${criteria.coverageDateStart || 'start'} - ${criteria.coverageDateEnd || 'end'}`;
            activeFilters.push(`Coverage: ${dateRange}`);
        }
        
        summary.textContent = activeFilters.length > 0 
            ? `Active filters: ${activeFilters.join(', ')}`
            : 'No active filters';
    }

    // Removed old sortResults method - sorting now handled in searchAndFilterSeries

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
            ErrorHandler.log(error, 'Update UI');
            this.setStatus('Error updating interface: ' + error.message, 'error');
        }
    }

    async populateFilterDropdowns() {
        try {
            // Get all series data for populating dropdowns
            const allSeries = await this.getAllSeries();
            
            // Schedule numbers
            const scheduleNumbers = [...new Set(allSeries.map(s => s.schedule_number).filter(n => n))].sort();
            const scheduleSelect = document.getElementById('scheduleFilter');
            if (scheduleSelect) {
                DOMHelper.clearElement(scheduleSelect);
                scheduleSelect.appendChild(DOMHelper.createOption('', 'All Schedules'));
                scheduleNumbers.forEach(num => {
                    scheduleSelect.appendChild(DOMHelper.createOption(num, num));
                });
            }

            // Divisions
            const divisions = [...new Set(allSeries.map(s => s.division).filter(d => d))].sort();
            const divSelect = document.getElementById('divisionFilter');
            if (divSelect) {
                DOMHelper.clearElement(divSelect);
                divSelect.appendChild(DOMHelper.createOption('', 'All Divisions'));
                divisions.forEach(div => {
                    divSelect.appendChild(DOMHelper.createOption(div, div));
                });
            }
            
            // Approval status
            const statusSelect = document.getElementById('statusFilter');
            if (statusSelect) {
                DOMHelper.clearElement(statusSelect);
                statusSelect.appendChild(DOMHelper.createOption('', 'All Statuses'));
                Object.values(APP_CONSTANTS.APPROVAL_STATUS).forEach(status => {
                    const displayName = status.charAt(0).toUpperCase() + status.slice(1);
                    statusSelect.appendChild(DOMHelper.createOption(status, displayName));
                });
            }
            
            // Tags (if tag filter exists)
            const tagSelect = document.getElementById('tagFilter');
            if (tagSelect) {
                const allTags = [...new Set(allSeries.flatMap(s => Array.isArray(s.tags) ? s.tags : []))].sort();
                DOMHelper.clearElement(tagSelect);
                tagSelect.appendChild(DOMHelper.createOption('', 'All Tags'));
                allTags.forEach(tag => {
                    tagSelect.appendChild(DOMHelper.createOption(tag, tag));
                });
            }
            
        } catch (error) {
            ErrorHandler.log(error, 'Populate filter dropdowns');
        }
    }

    // Legacy function - schedule dropdown removed from Series tab
    populateSeriesScheduleDropdown() {
        // Schedule dropdown has been removed from Series Details tab
        // Schedule information is now managed in the Schedule Details tab
        return;
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
        
        if (!resultsList) return;
        
        // Clear previous results but preserve emptyState in its original position
        const children = Array.from(resultsList.children);
        children.forEach(child => {
            if (child.id !== 'emptyState') {
                resultsList.removeChild(child);
            }
        });
        
        if (this.filteredItems.length === 0) {
            // Show empty state
            if (emptyState) {
                emptyState.style.display = 'block';
            }
            return;
        }

        // Hide empty state when we have results
        if (emptyState) {
            emptyState.style.display = 'none';
        }
        
        // Render all filtered items (simplified approach)
        this.filteredItems.forEach((item, index) => {
            const row = this.createResultRow(item, index);
            resultsList.appendChild(row);
        });
        
        // Highlight selected item if any
        if (this.selectedItemId) {
            const selectedRow = resultsList.querySelector(`[data-item-id="${this.selectedItemId}"]`);
            if (selectedRow) {
                selectedRow.classList.add('selected');
            }
        }
    }

    // Removed virtual scrolling - using simpler direct rendering

    // Removed virtual scroll handler

    // Removed virtual viewport rendering

    // Removed old filtered items count method

    // Removed old filtered items range method

    // Removed old filter matching method - replaced with new system

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
        // Display schedule_number directly from merged model
        DOMHelper.setTextContent(colApp, item.schedule_number || 'N/A');

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
        // Use the new refreshCountsUI method for consistency
        this.refreshCountsUI();
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
        const noSelectionMessage = document.getElementById('noSelectionMessage');
        const tabNavigation = document.getElementById('tabNavigation');
        const seriesTabPanel = document.getElementById('seriesTabPanel');
        const scheduleTabPanel = document.getElementById('scheduleTabPanel');
        
        // Hide no selection message
        if (noSelectionMessage) {
            noSelectionMessage.classList.add('hidden');
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
                // Forms will be populated after tab is made visible
                this.populateFormsFromSeries(seriesItem);
            } else {
                const seriesForm = document.getElementById('seriesForm');
                if (seriesForm) seriesForm.reset();
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
        
        // Schedule dropdown removed from Series tab - no longer needed
        
        // Store current tab for persistence
        this.currentTab = tabName;
    }

    hideDetails() {
        const noSelectionMessage = document.getElementById('noSelectionMessage');
        const tabNavigation = document.getElementById('tabNavigation');
        const seriesTabPanel = document.getElementById('seriesTabPanel');
        const scheduleTabPanel = document.getElementById('scheduleTabPanel');
        
        // Show no selection message
        if (noSelectionMessage) {
            noSelectionMessage.classList.remove('hidden');
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
        
        // In merged schema, schedule info is stored directly on series record
        let scheduleInfo = null;
        if (item.schedule_number) {
            // Create schedule object from series data for display
            scheduleInfo = {
                _id: `sched_${item.schedule_number}`,
                schedule_number: item.schedule_number,
                approval_status: item.approval_status,
                approval_date: item.approval_date,
                division: item.division,
                notes: item.notes,
                tags: item.tags || []
            };
        }
        
        // Display both schedule and series details
        this.displayDetails(scheduleInfo, item);
        
        const deleteSeriesBtn = document.getElementById('deleteSeriesBtn');
        if (deleteSeriesBtn) deleteSeriesBtn.classList.remove('hidden');
    }

    populateSeriesForm(item) {
        const fields = {
            'itemNumber': item.item_number || '',
            'seriesTitle': item.record_series_title || '',
            'seriesDescription': item.ui_extras?.seriesDescription || '',
            'datesStart': item.dates_covered_start || '',
            'datesEnd': item.dates_covered_end || '',
            'seriesDivision': item.division || '',
            'seriesContact': item.ui_extras?.seriesContact || '',
            'seriesLocation': item.ui_extras?.seriesLocation || '',
            'retentionText': item.retention_text || '',
            'retentionTrigger': item.ui_extras?.retentionTrigger || '',
            'retentionTerm': item.ui_extras?.retentionTerm || '',
            'volumePaper': item.ui_extras?.volumePaper || '',
            'volumeElectronic': item.ui_extras?.volumeElectronic || '',
            'annualPaper': item.ui_extras?.annualPaper || '',
            'annualElectronic': item.ui_extras?.annualElectronic || '',
            'arrangement': item.ui_extras?.arrangement || '',
            'mediaTypes': Array.isArray(item.media_types) ? item.media_types.join(', ') : (item.media_types || ''),
            'electronicStandard': item.ui_extras?.electronicStandard || '',
            'numberSizeFiles': item.ui_extras?.numberSizeFiles || '',
            'indexFindingAids': item.ui_extras?.indexFindingAids || '',
            'ombStatuteRefs': Array.isArray(item.omb_or_statute_refs) ? item.omb_or_statute_refs.join(', ') : (item.omb_or_statute_refs || ''),
            'relatedSeries': Array.isArray(item.related_series) ? item.related_series.join(', ') : (item.related_series || ''),
            'representativeName': item.ui_extras?.representativeName || '',
            'representativeTitle': item.ui_extras?.representativeTitle || '',
            'representativePhone': item.ui_extras?.representativePhone || '',
            'recordsOfficerName': item.ui_extras?.recordsOfficerName || '',
            'recordsOfficerPhone': item.ui_extras?.recordsOfficerPhone || '',
            'seriesNotes': item.notes || ''
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
        this.currentSeriesItem = null;
        this.selectedItemId = null;
        
        // Clear any existing selection
        document.querySelectorAll('.result-item').forEach(row => row.classList.remove('selected'));
        
        // Show details pane and series tab
        this.displayDetails(null, {});
        this.switchToTab('series');
        
        // Reset the form
        const seriesForm = document.getElementById('seriesForm');
        if (seriesForm) seriesForm.reset();
        
        const deleteSeriesBtn = document.getElementById('deleteSeriesBtn');
        
        if (deleteSeriesBtn) deleteSeriesBtn.classList.add('hidden');
        
        // Focus on the item number field since schedule dropdown was removed
        const itemNumberInput = document.getElementById('itemNumber');
        if (itemNumberInput) itemNumberInput.focus();
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
        
        // Basic validation
        const seriesTitleEl = document.getElementById('seriesTitle');
        if (!seriesTitleEl || !seriesTitleEl.value.trim()) {
            this.setStatus('Record Series Title is required', 'error');
            return;
        }

        // Validate schedule number format if provided
        const scheduleNumEl = document.getElementById('scheduleNum');
        if (scheduleNumEl && scheduleNumEl.value.trim()) {
            if (!this.validateScheduleNumber(scheduleNumEl.value.trim())) {
                this.setStatus('Schedule Number must be in format ##-### (e.g., 25-001)', 'error');
                return;
            }
        }

        // Validate item number format if provided
        const itemNumberEl = document.getElementById('itemNumber');
        if (itemNumberEl && itemNumberEl.value.trim()) {
            if (!this.validateItemNumber(itemNumberEl.value.trim())) {
                this.setStatus('Item Number format is invalid', 'error');
                return;
            }
        }

        try {
            // Use the new v3.1 save function
            await this.saveSeriesFromForms();
            this.cancelSeriesEdit();
            // Force refresh after form is closed
            setTimeout(() => this.applyFilters(), 100);
        } catch (error) {
            ErrorHandler.log(error, 'Series save', APP_CONSTANTS.ERROR_TYPES.DATABASE);
            this.setStatus('Error saving series: ' + error.message, 'error');
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
        document.querySelectorAll('.result-item.selected').forEach(row => row.classList.remove('selected'));
        this.selectedItemId = null;
        this.hideDetails();
    }

    // Import/Export v3.1
    async exportData() {
        try {
            const seriesItems = await this.getAllSeries();
            const auditEvents = await this.getAllAuditEvents();
            
            // Export in v3.1 format with schedule_number terminology
            const cleanSeries = seriesItems.map(item => {
                const cleanItem = {
                    schedule_number: item.schedule_number || null,
                    item_number: item.item_number || null,
                    record_series_title: item.record_series_title || null,
                    division: item.division || null,
                    approval_status: item.approval_status || null,
                    approval_date: item.approval_date || null,
                    dates_covered_start: item.dates_covered_start || null,
                    dates_covered_end: item.dates_covered_end || null,
                    tags: item.tags || [],
                    media_types: item.media_types || [],
                    omb_or_statute_refs: item.omb_or_statute_refs || [],
                    related_series: item.related_series || [],
                    retention_text: item.retention_text || null,
                    notes: item.notes || null,
                    ui_extras: item.ui_extras || {},
                    created_at: item.created_at || null,
                    updated_at: item.updated_at || null,
                    version: item.version || 1
                };
                
                return cleanItem;
            });
            
            const exportData = {
                exported_at: new Date().toISOString(),
                version: "3.1",
                agency: "ILETSB",
                series: cleanSeries,
                audit_events: auditEvents || []
            };

            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `iletsb-records-v3.1-${new Date().toISOString().split('T')[0]}.json`;
            a.click();
            URL.revokeObjectURL(url);
            
            await this.logAuditEvent('system', null, 'export', { recordCount: seriesItems.length, version: "3.1" });
            this.setStatus('Data exported successfully (v3.1 format)', 'success');
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

            // Import series (v3.1 with legacy support)
            const seriesArray = data.series || data.series_items || [];
            this.logImportMessage(`Processing ${seriesArray.length} series items...`);
            
            for (const item of seriesArray) {
                try {
                    // Legacy support: map application_number to schedule_number
                    if (item.application_number && !item.schedule_number) {
                        item.schedule_number = item.application_number;
                        delete item.application_number;
                    }
                    
                    const identifier = `${item.schedule_number || 'unassigned'}-${item.item_number || 'no-item'}`;
                    this.logImportMessage(`Importing series ${identifier}: ${item.record_series_title}...`);
                    
                    const result = await this.upsertSeriesV31(item);
                    results.series[result.action]++;
                    this.logImportMessage(`Series ${identifier} ${result.action} successfully`);
                } catch (error) {
                    const identifier = `${item.schedule_number || item.application_number || 'unassigned'}-${item.item_number || 'no-item'}`;
                    results.series.errors.push(`Series ${identifier}: ${error.message}`);
                    results.series.skipped++;
                    this.logImportMessage(`Error importing series: ${error.message}`);
                }
                
                // Update counts with unique schedule numbers (remove await to prevent blocking)
                this.updateRecordCount();
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
            // Force UI refresh after import completes
            await this.loadDataOptimized();
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
                
                // Validate schedule_number format if present (support both new and legacy field names)
                const scheduleNumber = item.schedule_number || item.application_number;
                if (scheduleNumber && !/^\d{2}-\d{3}$/.test(scheduleNumber)) {
                    errors.push(`Series item ${i}: Invalid schedule_number format (expected XX-XXX)`);
                }
                
                // Validate item_number format if present
                if (item.item_number && !/^\d+([A-Za-z]|\.\d+)?$/.test(item.item_number)) {
                    errors.push(`Series item ${i}: Invalid item_number format`);
                }
                
                // Validate approval_status if present
                if (item.approval_status && !validStatuses.includes(item.approval_status)) {
                    errors.push(`Series item ${i}: Invalid approval_status (must be one of: ${validStatuses.join(', ')})`);
                }
                
                // Validate dates if present
                if (item.dates_covered_start && !/^\d{4}(-\d{2})?(-\d{2})?$/.test(item.dates_covered_start)) {
                    errors.push(`Series item ${i}: Invalid dates_covered_start format (expected YYYY, YYYY-MM, or YYYY-MM-DD)`);
                }
                
                if (item.dates_covered_end && item.dates_covered_end !== 'present' && !/^\d{4}(-\d{2})?(-\d{2})?$/.test(item.dates_covered_end)) {
                    errors.push(`Series item ${i}: Invalid dates_covered_end format (expected YYYY, YYYY-MM, YYYY-MM-DD, or "present")`);
                }
                
                // Validate arrays (allow both arrays and strings for legacy compatibility)
                const arrayFields = ['tags', 'media_types', 'omb_or_statute_refs', 'related_series'];
                arrayFields.forEach(field => {
                    if (item[field] && !Array.isArray(item[field]) && typeof item[field] !== 'string') {
                        errors.push(`Series item ${i}: ${field} must be an array or string`);
                    }
                });
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
                    // Use new search system instead of old filter matching
                    items.push(item);
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
        // Prevent concurrent executions
        if (this._clearingDatabase) {
            console.warn('Database clear already in progress, ignoring duplicate request');
            return;
        }
        
        this._clearingDatabase = true;
        
        try {
            this.setStatus('Clearing database...', 'info');
            
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
        } finally {
            // Always reset the flag
            this._clearingDatabase = false;
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

    // v3.1 Save/Load Adapters
    
    // Helper function to convert input to array
    toArr(input) {
        if (Array.isArray(input)) return input;
        if (!input) return [];
        return String(input).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
    }

    // Collect all form values and save as series record
    async saveSeriesFromForms() {
        try {
            // Read schedule number from Series Details tab dropdown
            const schedule_number = document.getElementById('seriesScheduleNum')?.value?.trim() || null;
            const approval_status = document.getElementById('approvalStatus')?.value || null;
            const approval_date = document.getElementById('approvalDate')?.value || null;
            const division = document.getElementById('scheduleDivision')?.value?.trim() || null;
            const tags = this.toArr(document.getElementById('scheduleTags')?.value);

            // Read Series Details
            const item_number = document.getElementById('itemNumber')?.value?.trim() || null;
            const record_series_title = document.getElementById('seriesTitle')?.value?.trim() || null;
            const dates_covered_start = document.getElementById('datesStart')?.value?.trim() || null;
            const dates_covered_end = document.getElementById('datesEnd')?.value?.trim() || null;
            const retention_text = document.getElementById('retentionText')?.value || null;
            const notes = document.getElementById('seriesNotes')?.value || null;

            const media_types = this.toArr(document.getElementById('mediaTypes')?.value);
            const omb_or_statute_refs = this.toArr(document.getElementById('ombStatuteRefs')?.value);
            const related_series = this.toArr(document.getElementById('relatedSeries')?.value);

            // Everything else goes into ui_extras (captured verbatim)
            const ui_extras = {
                seriesDescription: document.getElementById('seriesDescription')?.value || null,
                seriesContact: document.getElementById('seriesContact')?.value || null,
                seriesLocation: document.getElementById('seriesLocation')?.value || null,
                retentionTerm: document.getElementById('retentionTerm')?.value || null,
                retentionTrigger: document.getElementById('retentionTrigger')?.value || null,
                volumePaper: document.getElementById('volumePaper')?.value || null,
                volumeElectronic: document.getElementById('volumeElectronic')?.value || null,
                annualPaper: document.getElementById('annualPaper')?.value || null,
                annualElectronic: document.getElementById('annualElectronic')?.value || null,
                arrangement: document.getElementById('arrangement')?.value || null,
                electronicStandard: document.getElementById('electronicStandard')?.value || null,
                numberSizeFiles: document.getElementById('numberSizeFiles')?.value || null,
                indexFindingAids: document.getElementById('indexFindingAids')?.value || null,
                representativeName: document.getElementById('representativeName')?.value || null,
                representativeTitle: document.getElementById('representativeTitle')?.value || null,
                representativePhone: document.getElementById('representativePhone')?.value || null,
                recordsOfficerName: document.getElementById('recordsOfficerName')?.value || null,
                recordsOfficerPhone: document.getElementById('recordsOfficerPhone')?.value || null,
                scheduleNotes: document.getElementById('scheduleNotes')?.value || null
            };

            const now = new Date().toISOString();
            const row = {
                schedule_number, item_number, record_series_title,
                division, approval_status, approval_date,
                dates_covered_start, dates_covered_end,
                tags, media_types, omb_or_statute_refs, related_series,
                retention_text, notes, ui_extras,
                updated_at: now
            };

            // Upsert by [schedule_number+item_number] when both present
            const existing = (schedule_number && item_number)
                ? await this.findSeriesByScheduleAndItem(schedule_number, item_number)
                : null;

            if (existing) {
                row._id = existing._id;
                row.created_at = existing.created_at || now;
                row.version = (existing.version || 0) + 1;
                await this.saveSeries(row, true);
                await this.logAuditEvent('series', row._id, 'update', row);
            } else {
                row.created_at = now;
                row.version = 1;
                const savedItem = await this.saveSeries(row, false);
                await this.logAuditEvent('series', savedItem._id, 'create', row);
            }

            // Refresh UI
            await this.updateUI();
            this.setStatus('Series saved successfully', 'success');
            
        } catch (error) {
            ErrorHandler.log(error, 'Save series from forms');
            this.setStatus('Error saving series: ' + error.message, 'error');
        }
    }

    // Find series by schedule_number and item_number combination
    async findSeriesByScheduleAndItem(scheduleNumber, itemNumber) {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['series'], 'readonly');
            const store = transaction.objectStore('series');
            const index = store.index('schedule_number_item_number');
            const request = index.get([scheduleNumber, itemNumber]);
            
            request.onsuccess = () => resolve(request.result || null);
            request.onerror = () => reject(request.error);
        });
    }

    // Load series data into forms (reverse mapping)
    populateFormsFromSeries(seriesItem) {
        if (!seriesItem) return;

        try {
            // Populate Schedule Details
            this.setFormValue('scheduleNum', seriesItem.schedule_number);
            this.setFormValue('approvalStatus', seriesItem.approval_status);
            this.setFormValue('approvalDate', seriesItem.approval_date);
            this.setFormValue('scheduleDivision', seriesItem.division);
            this.setFormValue('scheduleTags', Array.isArray(seriesItem.tags) ? seriesItem.tags.join(', ') : '');

            // Populate Series Details
            this.setFormValue('itemNumber', seriesItem.item_number);
            this.setFormValue('seriesTitle', seriesItem.record_series_title);
            this.setFormValue('datesStart', seriesItem.dates_covered_start);
            this.setFormValue('datesEnd', seriesItem.dates_covered_end);
            this.setFormValue('retentionText', seriesItem.retention_text);
            this.setFormValue('seriesNotes', seriesItem.notes);

            this.setFormValue('mediaTypes', Array.isArray(seriesItem.media_types) ? seriesItem.media_types.join(', ') : '');
            this.setFormValue('ombStatuteRefs', Array.isArray(seriesItem.omb_or_statute_refs) ? seriesItem.omb_or_statute_refs.join(', ') : '');
            this.setFormValue('relatedSeries', Array.isArray(seriesItem.related_series) ? seriesItem.related_series.join(', ') : '');

            // Populate ui_extras fields
            if (seriesItem.ui_extras) {
                Object.keys(seriesItem.ui_extras).forEach(key => {
                    this.setFormValue(key, seriesItem.ui_extras[key]);
                });
            }

        } catch (error) {
            ErrorHandler.log(error, 'Populate forms from series');
        }
    }

    // Helper to safely set form field values
    setFormValue(fieldId, value) {
        const field = document.getElementById(fieldId);
        if (field && value !== null && value !== undefined) {
            field.value = value;
        }
    }

    // Update status bar and import modal counts
    async refreshCountsUI() {
        try {
            const totalSeries = await this.getSeriesItemsCount();
            const nonBlank = await this.getAllSeries();
            const scheduleNumbers = nonBlank
                .map(s => s.schedule_number)
                .filter(n => n && n.trim() !== '')
                .map(n => n.trim());
            const totalSchedules = new Set(scheduleNumbers).size;

            const recordCountElement = document.getElementById('recordCount');
            if (recordCountElement) {
                recordCountElement.textContent = `${totalSchedules} schedules, ${totalSeries} series`;
            }

            // Also update import modal fields if they exist
            const importSchedulesCount = document.getElementById('importSchedulesCount');
            const importSeriesCount = document.getElementById('importSeriesCount');
            if (importSchedulesCount) importSchedulesCount.textContent = totalSchedules;
            if (importSeriesCount) importSeriesCount.textContent = totalSeries;

        } catch (error) {
            ErrorHandler.log(error, 'Refresh counts UI');
        }
    }

    // Validation functions
    validateScheduleNumber(scheduleNumber) {
        if (!scheduleNumber) return true; // Optional field
        return /^\d{2}-\d{3}$/.test(scheduleNumber);
    }

    validateItemNumber(itemNumber) {
        if (!itemNumber) return true; // Optional field
        return /^\d+([A-Za-z]|\.\d+)?$/.test(itemNumber);
    }

    // v3.1 Import upsert method
    async upsertSeriesV31(importItem) {
        try {
            // Normalize arrays from import data
            const normalizeArray = (value) => {
                if (Array.isArray(value)) return value;
                if (!value) return [];
                return String(value).split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
            };

            // Prepare the series record
            const now = new Date().toISOString();
            const seriesRecord = {
                schedule_number: importItem.schedule_number || null,
                item_number: importItem.item_number || null,
                record_series_title: importItem.record_series_title || null,
                division: importItem.division || null,
                approval_status: importItem.approval_status || null,
                approval_date: importItem.approval_date || null,
                dates_covered_start: importItem.dates_covered_start || null,
                dates_covered_end: importItem.dates_covered_end || null,
                tags: normalizeArray(importItem.tags),
                media_types: normalizeArray(importItem.media_types),
                omb_or_statute_refs: normalizeArray(importItem.omb_or_statute_refs),
                related_series: normalizeArray(importItem.related_series),
                retention_text: importItem.retention_text || null,
                notes: importItem.notes || null,
                ui_extras: importItem.ui_extras || {},
                updated_at: now
            };

            // Preserve timestamps if they exist
            if (importItem.created_at) {
                seriesRecord.created_at = importItem.created_at;
            }
            if (importItem.version) {
                seriesRecord.version = importItem.version;
            }

            // Upsert logic: find existing by [schedule_number+item_number] when both present
            let existing = null;
            if (seriesRecord.schedule_number && seriesRecord.item_number) {
                existing = await this.findSeriesByScheduleAndItem(seriesRecord.schedule_number, seriesRecord.item_number);
            }

            if (existing) {
                // Update existing record
                seriesRecord._id = existing._id;
                seriesRecord.created_at = existing.created_at || now;
                seriesRecord.version = (existing.version || 0) + 1;
                const updatedSeries = await this.saveSeries(seriesRecord, true);
                return { action: 'updated', record: updatedSeries };
            } else {
                // Create new record
                seriesRecord.created_at = now;
                seriesRecord.version = 1;
                const newSeries = await this.saveSeries(seriesRecord, false);
                return { action: 'created', record: newSeries };
            }

        } catch (error) {
            throw new Error(`Failed to upsert series: ${error.message}`);
        }
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