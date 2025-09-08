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
            
            // Check if database is empty and load test data if needed
            const existingData = await this.getAllSeries();
            if (existingData.length === 0) {
                await this.loadTestDataIfEmpty();
            }
            
            this.initEventListeners();
            this.restoreSearchPaneState();
            this.updateUI();
            this.setStatus('Ready');
        } catch (error) {
            ErrorHandler.log(error, 'App initialization');
            this.setStatus('Error initializing application: ' + error.message, 'error');
        }
    }
    
    async loadTestDataIfEmpty() {
        try {
            // Only attempt to load test data if running from http/https (not file://)
            if (window.location.protocol === 'file:') {
                // Skip test data loading when running from file system due to CORS restrictions
                return;
            }
            
            // Load test data from test-import.json
            const response = await fetch('./test-import.json');
            if (response.ok) {
                const testData = await response.json();
                if (testData.series && testData.series.length > 0) {
                    // Import the test data
                    for (const item of testData.series) {
                        // Handle legacy application_number field
                        if (item.application_number && !item.schedule_number) {
                            item.schedule_number = item.application_number;
                            delete item.application_number;
                        }
                        
                        // Normalize arrays
                        ['tags', 'media_types', 'omb_or_statute_refs', 'related_series'].forEach(field => {
                            if (item[field] && typeof item[field] === 'string') {
                                item[field] = item[field].split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
                            }
                        });
                        
                        // Ensure ui_extras exists
                        item.ui_extras = item.ui_extras || {};
                        
                        // Remove old fields that are no longer needed
                        delete item.retention_is_permanent;
                        delete item.schedule_id;
                        
                        // Save to database
                        await this.saveSeries(item, false);
                    }
                    
                    this.setStatus('Test data loaded successfully', 'success');
                }
            }
        } catch (error) {
            // Silently handle test data loading errors - this is not critical functionality
            console.log('Test data not loaded:', error.message);
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
        // Atomic bulk update for all series with matching schedule_number
        const series = await this.getAllSeries();
        const matchingSeries = series.filter(s => s.schedule_number === schedule.schedule_number);
        
        if (matchingSeries.length === 0) {
            return schedule; // No series to update
        }
        
        // Use atomic transaction for bulk update
        return this.performAtomicScheduleBulkUpdate(schedule, matchingSeries, isUpdate);
    }
    
    async performAtomicScheduleBulkUpdate(schedule, matchingSeries, isUpdate) {
        return new Promise((resolve, reject) => {
            // Start atomic transaction
            const transaction = this.db.transaction(['series', 'audit_events'], 'readwrite');
            const seriesStore = transaction.objectStore('series');
            const auditStore = transaction.objectStore('audit_events');
            
            const now = new Date().toISOString();
            const updatedSeries = [];
            const auditEvents = [];
            
            // Prepare all updates and audit events
            matchingSeries.forEach(seriesItem => {
                // Update schedule fields on the series item
                const updatedItem = { ...seriesItem };
                updatedItem.schedule_number = schedule.schedule_number;
                updatedItem.approval_status = schedule.approval_status;
                updatedItem.approval_date = schedule.approval_date;
                updatedItem.division = schedule.division || seriesItem.division;
                updatedItem.notes = schedule.notes;
                updatedItem.tags = schedule.tags || seriesItem.tags;
                updatedItem.updated_at = now;
                
                updatedSeries.push(updatedItem);
                
                // Prepare audit event for this series
                auditEvents.push({
                    entity: 'series',
                    entity_id: seriesItem._id,
                    action: 'schedule_bulk_update',
                    actor: 'local-user',
                    at: now,
                    payload: JSON.stringify({
                        schedule_number: schedule.schedule_number,
                        item_number: seriesItem.item_number,
                        record_series_title: seriesItem.record_series_title,
                        bulk_update_fields: ['approval_status', 'approval_date', 'division', 'notes', 'tags']
                    })
                });
            });
            
            // Transaction success handler
            transaction.oncomplete = () => {
                resolve(schedule);
            };
            
            // Transaction error handler - automatic rollback
            transaction.onerror = (event) => {
                const error = new Error(`Bulk update transaction failed: ${event.target.error?.message || 'Unknown error'}`);
                ErrorHandler.log(error, 'Schedule bulk update transaction');
                reject(error);
            };
            
            transaction.onabort = (event) => {
                const error = new Error(`Bulk update transaction aborted: ${event.target.error?.message || 'Transaction aborted'}`);
                ErrorHandler.log(error, 'Schedule bulk update transaction abort');
                reject(error);
            };
            
            try {
                // Perform all series updates within the transaction
                updatedSeries.forEach(item => {
                    const request = seriesStore.put(item);
                    request.onerror = () => {
                        transaction.abort();
                    };
                });
                
                // Add all audit events within the same transaction
                auditEvents.forEach(event => {
                    const request = auditStore.add(event);
                    request.onerror = () => {
                        transaction.abort();
                    };
                });
                
            } catch (error) {
                ErrorHandler.log(error, 'Schedule bulk update execution');
                transaction.abort();
            }
        });
    }


    async saveSeries(item, isUpdate = false) {
        return new Promise((resolve, reject) => {
            // Create a transaction that includes BOTH stores
            const transaction = this.db.transaction(['series', 'audit_events'], 'readwrite');
            const seriesStore = transaction.objectStore('series');
            
            const now = new Date().toISOString();
            if (!isUpdate) {
                item.created_at = now;
            }
            item.updated_at = now;
            
            const request = isUpdate ? seriesStore.put(item) : seriesStore.add(item);
            
            request.onsuccess = () => {
                const id = request.result;
                item._id = id;
                
                // Log the audit event USING THE SAME TRANSACTION
                this.logAuditEvent('series', id, isUpdate ? 'update' : 'create', {
                    schedule_number: item.schedule_number,
                    item_number: item.item_number,
                    record_series_title: item.record_series_title
                }, transaction).catch(err => {
                    ErrorHandler.log(err, 'Audit event logging');
                    transaction.abort(); // IMPORTANT: Abort if logging fails
                });
            };
            
            request.onerror = () => reject(request.error);
            
            transaction.oncomplete = () => resolve(item);
            transaction.onerror = () => reject(transaction.error);
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


    async deleteSeries(id) {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                ErrorHandler.log(new Error('Database not initialized'), 'Delete series');
                return reject(new Error('Database connection not available'));
            }
            
            const transaction = this.db.transaction(['series'], 'readwrite');
            const store = transaction.objectStore('series');
            const request = store.delete(id);

            request.onsuccess = () => {
                this.logAuditEvent('series', id, 'delete', {});
                resolve();
            };
            
            request.onerror = (event) => {
                const error = request.error || new Error('Failed to delete series record');
                ErrorHandler.log(error, 'Delete series', {
                    id: id,
                    errorName: error.name,
                    errorMessage: error.message
                });
                reject(error);
            };
            
            transaction.onabort = (event) => {
                const error = transaction.error || new Error('Transaction aborted during delete');
                ErrorHandler.log(error, 'Delete series transaction', {
                    id: id,
                    errorName: error.name,
                    errorMessage: error.message
                });
                reject(error);
            };
        });
    }

    async logAuditEvent(entity, entityId, action, payload, transaction = null) {
        return new Promise((resolve, reject) => {
            // If no transaction is passed, create a new one
            const trans = transaction || this.db.transaction(['audit_events'], 'readwrite');
            const store = trans.objectStore('audit_events');
            
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
            
            // Don't commit if the transaction was passed in from outside
            // The calling function will handle committing
        });
    }

    async getAllAuditEvents() {
        return new Promise((resolve, reject) => {
            if (!this.db) {
                console.error('Database not initialized');
                resolve([]);
                return;
            }
            
            const transaction = this.db.transaction(['audit_events'], 'readonly');
            const store = transaction.objectStore('audit_events');
            const request = store.getAll();
            
            request.onsuccess = () => {
                const result = request.result || [];
                resolve(result);
            };
            request.onerror = () => {
                console.error('getAllAuditEvents error:', request.error);
                reject(request.error);
            };
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


    // Bulk Update UI Feedback Methods
    hideBulkUpdateProgress() {
        // Re-enable form controls
        const submitBtn = document.querySelector('#scheduleForm button[type="submit"]');
        const cancelBtn = document.getElementById('cancelScheduleBtn');
        
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = 'Save Schedule';
        }
        
        if (cancelBtn) {
            cancelBtn.disabled = false;
        }
        
        // Remove loading class from form
        const form = document.getElementById('scheduleForm');
        if (form) {
            form.classList.remove('bulk-updating');
        }
    }

    // UI Event Handlers
    initEventListeners() {
        // Top navigation
        const newScheduleBtn = document.getElementById('newScheduleBtn');
        if (newScheduleBtn) {
            newScheduleBtn.addEventListener('click', () => this.createNewSchedule());
        }
        document.getElementById('newSeriesBtn').addEventListener('click', () => this.createNewSeriesItem());
        // Export and import buttons are handled in setupAdminMenu() to avoid duplicate listeners
        document.getElementById('importFile').addEventListener('change', (e) => this.importData(e));
        // Export filtered button is handled in setupAdminMenu() to avoid duplicate listeners

        // Search and filters
        document.getElementById('searchInput').addEventListener('input', (e) => this.debounceSearch(e.target.value));
        document.getElementById('scheduleFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('divisionFilter').addEventListener('change', () => this.applyFilters());
        document.getElementById('statusFilter').addEventListener('change', () => this.applyFilters());
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
        
        // Cancel buttons
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

    setupAdminMenu() {
        const adminMenuBtn = document.getElementById('adminMenuBtn');
        const adminDropdown = document.getElementById('adminDropdown');
        const newSeriesBtn = document.getElementById('newSeriesBtn');
        const exportBtn = document.getElementById('exportBtn');
        const importBtn = document.getElementById('importBtn');
        const exportFilteredBtn = document.getElementById('exportFilteredBtn');
        const clearDbBtn = document.getElementById('clearDbBtn');

        if (!adminMenuBtn || !adminDropdown) return;

        // Toggle dropdown visibility
        adminMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isExpanded = adminMenuBtn.getAttribute('aria-expanded') === 'true';
            
            // Close all other dropdowns first
            document.querySelectorAll('.dropdown').forEach(dropdown => {
                if (dropdown !== adminDropdown) {
                    dropdown.classList.add('hidden');
                }
            });
            
            // Toggle this dropdown
            if (isExpanded) {
                adminDropdown.classList.add('hidden');
                adminMenuBtn.setAttribute('aria-expanded', 'false');
            } else {
                adminDropdown.classList.remove('hidden');
                adminMenuBtn.setAttribute('aria-expanded', 'true');
            }
        });

        // Admin menu item handlers
        if (newSeriesBtn) {
            newSeriesBtn.addEventListener('click', () => {
                this.createNewSeriesItem();
                adminDropdown.classList.add('hidden');
                adminMenuBtn.setAttribute('aria-expanded', 'false');
            });
        }

        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportData();
                adminDropdown.classList.add('hidden');
                adminMenuBtn.setAttribute('aria-expanded', 'false');
            });
        }

        if (importBtn) {
            importBtn.addEventListener('click', () => {
                this.showImportModal();
                adminDropdown.classList.add('hidden');
                adminMenuBtn.setAttribute('aria-expanded', 'false');
            });
        }

        if (exportFilteredBtn) {
            exportFilteredBtn.addEventListener('click', () => {
                this.exportFilteredData();
                adminDropdown.classList.add('hidden');
                adminMenuBtn.setAttribute('aria-expanded', 'false');
            });
        }

        if (clearDbBtn) {
            clearDbBtn.addEventListener('click', () => {
                this.confirmClearDatabase();
                adminDropdown.classList.add('hidden');
                adminMenuBtn.setAttribute('aria-expanded', 'false');
            });
        }
    }

    setupImportStatusModal() {
        // This method sets up any import status modal functionality
        // Currently a placeholder as no import status modal elements were found in HTML
        // If import status modal elements exist, they would be wired here
    }

    handleGlobalClick(e) {
        // Close all dropdowns when clicking outside
        if (!e.target.closest('.admin-menu') && !e.target.closest('.dropdown')) {
            document.querySelectorAll('.dropdown').forEach(dropdown => {
                dropdown.classList.add('hidden');
            });
            
            // Reset aria-expanded attributes
            document.querySelectorAll('[aria-expanded="true"]').forEach(btn => {
                btn.setAttribute('aria-expanded', 'false');
            });
        }
    }

    handleEscapeKey() {
        // Close any open modals or dropdowns
        document.querySelectorAll('.dropdown').forEach(dropdown => {
            dropdown.classList.add('hidden');
        });
        
        // Reset aria-expanded attributes
        document.querySelectorAll('[aria-expanded="true"]').forEach(btn => {
            btn.setAttribute('aria-expanded', 'false');
        });
        
        // Close any open modals
        const modals = document.querySelectorAll('.modal:not(.hidden)');
        modals.forEach(modal => {
            modal.classList.add('hidden');
        });
    }

    handleSaveShortcut() {
        // Handle Ctrl+Enter or Cmd+Enter to save current form
        const activeForm = document.querySelector('form:not(.hidden)');
        if (activeForm) {
            const submitBtn = activeForm.querySelector('button[type="submit"]');
            if (submitBtn && !submitBtn.disabled) {
                submitBtn.click();
            }
        }
    }

    handleKeydown(e) {
        // Handle general keyboard navigation
        if (e.target.matches('input, textarea, select')) {
            // Don't interfere with form input
            return;
        }
        
        // Handle arrow key navigation in results list
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            const resultItems = document.querySelectorAll('.result-item');
            const currentSelected = document.querySelector('.result-item.selected');
            
            if (resultItems.length > 0) {
                let nextIndex = 0;
                
                if (currentSelected) {
                    const currentIndex = Array.from(resultItems).indexOf(currentSelected);
                    if (e.key === 'ArrowDown') {
                        nextIndex = (currentIndex + 1) % resultItems.length;
                    } else {
                        nextIndex = currentIndex > 0 ? currentIndex - 1 : resultItems.length - 1;
                    }
                }
                
                resultItems[nextIndex].click();
                resultItems[nextIndex].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                e.preventDefault();
            }
        }
    }

    toggleSearchPane() {
        const searchPane = document.getElementById('searchPane');
        const mainContent = document.querySelector('.main-content');
        const toggleBtn = document.getElementById('searchToggleBtn');
        
        if (!searchPane || !mainContent || !toggleBtn) return;
        
        const isCollapsed = searchPane.classList.contains('collapsed');
        
        if (isCollapsed) {
            // Expand the search pane
            searchPane.classList.remove('collapsed');
            mainContent.classList.remove('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'true');
        } else {
            // Collapse the search pane
            searchPane.classList.add('collapsed');
            mainContent.classList.add('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'false');
        }
        
        // Save state to localStorage
        try {
            localStorage.setItem('iletsb_search_pane_collapsed', (!isCollapsed).toString());
        } catch (e) {
            // If storage is unavailable, continue without saving state
        }
    }

    handleScheduleSubmit(e) {
        e.preventDefault();
        
        try {
            const form = e.target;
            
            // Get form data using new reusable method
            const formData = this.getFormData(form);
            
            // Create schedule object with schedule number
            const schedule = {
                schedule_number: formData.schedule_number,
                approval_status: formData.approval_status || 'draft',
                approval_date: formData.approval_date || null,
                tags: formData.tags || [],
                ...formData
            };
            
            // Validate required fields
            if (!schedule.schedule_number) {
                this.setStatus('Schedule Number is required', 'error');
                return;
            }
            
            // Validate schedule number format
            if (!/^\d{2}-\d{3}$/.test(schedule.schedule_number)) {
                this.setStatus('Schedule Number must be in format XX-XXX (e.g., 25-012)', 'error');
                return;
            }
            
            // Save schedule (bulk update all matching series)
            this.saveSchedule(schedule, false);
            
        } catch (error) {
            ErrorHandler.log(error, 'Schedule form submission');
            this.setStatus(`Error saving schedule: ${error.message}`, 'error');
        }
    }

    // Alias method to match event listener expectation
    handleSeriesSubmit(e) {
        return this.handleSeriesFormSubmit(e);
    }

    updateChipSelection(chipContainer, selectedValue) {
        if (!chipContainer) return;
        
        // Remove active class from all chips in this container
        const chips = chipContainer.querySelectorAll('.chip');
        chips.forEach(chip => {
            chip.classList.remove('active');
        });
        
        // Add active class to the selected chip
        const selectedChip = chipContainer.querySelector(`[data-value="${selectedValue}"]`);
        if (selectedChip) {
            selectedChip.classList.add('active');
        }
        
        // Update the corresponding select element
        const formGroup = chipContainer.closest('.form-group');
        if (formGroup) {
            const select = formGroup.querySelector('select');
            if (select) {
                select.value = selectedValue;
                
                // Trigger change event to update filters
                select.dispatchEvent(new Event('change', { bubbles: true }));
            }
        }
    }

    createNewSchedule() {
        // Clear current selection and show schedule form
        this.currentSeriesItem = null;
        this.selectedItemId = null;
        
        // Clear selection styling
        document.querySelectorAll('.result-item').forEach(row => row.classList.remove('selected'));
        
        // Show schedule tab and form
        const scheduleTab = document.getElementById('scheduleTab');
        const seriesTab = document.getElementById('seriesTab');
        const scheduleTabPanel = document.getElementById('scheduleTabPanel');
        const seriesTabPanel = document.getElementById('seriesTabPanel');
        const noSelectionMessage = document.getElementById('noSelectionMessage');
        const tabNavigation = document.getElementById('tabNavigation');
        
        if (noSelectionMessage) noSelectionMessage.classList.add('hidden');
        if (tabNavigation) tabNavigation.classList.remove('hidden');
        
        if (scheduleTab) scheduleTab.classList.add('active');
        if (seriesTab) seriesTab.classList.remove('active');
        if (scheduleTabPanel) scheduleTabPanel.classList.remove('hidden');
        if (seriesTabPanel) seriesTabPanel.classList.add('hidden');
        
        // Clear and reset schedule form
        const scheduleForm = document.getElementById('scheduleForm');
        if (scheduleForm) {
            scheduleForm.reset();
            
            // Focus on schedule number field
            const scheduleNumberField = document.getElementById('scheduleNumber');
            if (scheduleNumberField) {
                scheduleNumberField.focus();
            }
        }
        
        this.setStatus('Creating new schedule', 'info');
    }

    showImportModal() {
        // Trigger the import file input
        const importFile = document.getElementById('importFile');
        if (importFile) {
            importFile.click();
        }
    }

    confirmClearDatabase() {
        // Show confirmation modal for clearing database
        const confirmed = confirm('Are you sure you want to clear all data from the database? This action cannot be undone.');
        
        if (confirmed) {
            this.clearDatabase();
        }
    }

    async clearDatabase() {
        try {
            // Clear all data from IndexedDB
            const transaction = this.db.transaction(['series', 'audit_events'], 'readwrite');
            
            await Promise.all([
                transaction.objectStore('series').clear(),
                transaction.objectStore('audit_events').clear()
            ]);
            
            // Reset application state
            this.schedules = [];
            this.seriesItems = [];
            this.filteredItems = [];
            this.currentSeriesItem = null;
            this.selectedItemId = null;
            
            // Update UI
            this.updateUI();
            this.setStatus('Database cleared successfully', 'success');
            
        } catch (error) {
            ErrorHandler.log(error, 'Clear database');
            this.setStatus(`Error clearing database: ${error.message}`, 'error');
        }
    }

    validateField(field) {
        if (!field) return true;
        
        const fieldName = field.dataset.field || field.name || field.id;
        const value = field.value.trim();
        let isValid = true;
        let errorMessage = '';
        
        // Clear existing error state
        this.clearFieldError(field);
        
        // Validate based on field type and requirements
        if (field.hasAttribute('required') && !value) {
            isValid = false;
            errorMessage = 'This field is required';
        } else if (fieldName === 'schedule_number' && value) {
            if (!/^\d{2}-\d{3}$/.test(value)) {
                isValid = false;
                errorMessage = 'Schedule number must be in format XX-XXX (e.g., 25-012)';
            }
        } else if (fieldName === 'item_number' && value) {
            if (!/^\d+([A-Za-z]|\.\d+)?$/.test(value)) {
                isValid = false;
                errorMessage = 'Item number must be numeric with optional letter or decimal suffix';
            }
        } else if (field.type === 'email' && value) {
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(value)) {
                isValid = false;
                errorMessage = 'Please enter a valid email address';
            }
        } else if (field.type === 'number' && value) {
            const numValue = parseFloat(value);
            if (isNaN(numValue) || numValue < 0) {
                isValid = false;
                errorMessage = 'Please enter a valid positive number';
            }
        }
        
        // Show error if validation failed
        if (!isValid) {
            this.showFieldError(field, errorMessage);
        }
        
        return isValid;
    }

    clearFieldError(field) {
        if (!field) return;
        
        // Remove error styling from field
        field.classList.remove('error');
        
        // Remove error message
        const formGroup = field.closest('.form-group');
        if (formGroup) {
            const existingError = formGroup.querySelector('.field-error');
            if (existingError) {
                existingError.remove();
            }
        }
    }

    showFieldError(field, message) {
        if (!field || !message) return;
        
        // Add error styling to field
        field.classList.add('error');
        
        // Add error message
        const formGroup = field.closest('.form-group');
        if (formGroup) {
            // Remove existing error message first
            const existingError = formGroup.querySelector('.field-error');
            if (existingError) {
                existingError.remove();
            }
            
            // Create new error message
            const errorElement = document.createElement('div');
            errorElement.className = 'field-error';
            errorElement.textContent = message;
            formGroup.appendChild(errorElement);
        }
    }

    async exportData() {
        try {
            // Get all data from database
            const series = await this.getAllSeries();
            const auditEvents = await this.getAllAuditEvents();
            
            // Create export object with metadata
            const exportData = {
                metadata: {
                    exported_at: new Date().toISOString(),
                    version: '3.7',
                    total_series: series.length,
                    total_schedules: new Set(series.map(s => s.schedule_number).filter(Boolean)).size
                },
                series: series,
                audit_events: auditEvents
            };
            
            // Create and download file
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `iletsb-records-export-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            this.setStatus(`Exported ${series.length} series records successfully`, 'success');
            
        } catch (error) {
            ErrorHandler.log(error, 'Export data');
            this.setStatus(`Error exporting data: ${error.message}`, 'error');
        }
    }

    async exportFilteredData() {
        try {
            // Use currently filtered items
            const filteredSeries = this.filteredItems || [];
            
            if (filteredSeries.length === 0) {
                this.setStatus('No records to export with current filters', 'error');
                return;
            }
            
            // Get audit events for filtered series
            const seriesIds = filteredSeries.map(s => s._id);
            const allAuditEvents = await this.getAllAuditEvents();
            const filteredAuditEvents = allAuditEvents.filter(event => 
                event.entity === 'series' && seriesIds.includes(event.entity_id)
            );
            
            // Create export object
            const exportData = {
                metadata: {
                    exported_at: new Date().toISOString(),
                    version: '3.7',
                    filtered_export: true,
                    total_series: filteredSeries.length,
                    total_schedules: new Set(filteredSeries.map(s => s.schedule_number).filter(Boolean)).size
                },
                series: filteredSeries,
                audit_events: filteredAuditEvents
            };
            
            // Create and download file
            const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `iletsb-records-filtered-export-${new Date().toISOString().split('T')[0]}.json`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            this.setStatus(`Exported ${filteredSeries.length} filtered series records successfully`, 'success');
            
        } catch (error) {
            ErrorHandler.log(error, 'Export filtered data');
            this.setStatus(`Error exporting filtered data: ${error.message}`, 'error');
        }
    }

    async getAllAuditEvents() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction(['audit_events'], 'readonly');
            const store = transaction.objectStore('audit_events');
            const request = store.getAll();
            
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    }

    confirmDeleteSeriesItem() {
        if (!this.currentSeriesItem) {
            this.setStatus('No series item selected for deletion', 'error');
            return;
        }
        
        const confirmed = confirm(`Are you sure you want to delete the series item "${this.currentSeriesItem.record_series_title}"? This action cannot be undone.`);
        
        if (confirmed) {
            this.deleteSeries(this.currentSeriesItem._id);
        }
    }


    confirmDeleteSchedule() {
        // This would delete schedule assignment from all matching series
        const confirmed = confirm('Are you sure you want to remove schedule assignment from all matching series? This action cannot be undone.');
        
        if (confirmed) {
            // Implementation would go here if needed
            this.setStatus('Schedule deletion not implemented', 'info');
        }
    }

    async importData(event) {
        const file = event.target.files[0];
        if (!file) return;

        try {
            const text = await file.text();
            const importData = JSON.parse(text);
            
            if (!importData.series || !Array.isArray(importData.series)) {
                this.setStatus('Invalid import file: missing series array', 'error');
                return;
            }

            let importedCount = 0;
            const errors = [];

            // Process each series item
            for (const item of importData.series) {
                try {
                    // Handle legacy application_number field
                    if (item.application_number && !item.schedule_number) {
                        item.schedule_number = item.application_number;
                        delete item.application_number;
                    }
                    
                    // Normalize arrays
                    ['tags', 'media_types', 'omb_or_statute_refs', 'related_series'].forEach(field => {
                        if (item[field] && typeof item[field] === 'string') {
                            item[field] = item[field].split(/[,;\n]/).map(s => s.trim()).filter(Boolean);
                        }
                    });
                    
                    // Remove _id to prevent conflicts - let database assign new IDs
                    delete item._id;
                    
                    // Set timestamps
                    const now = new Date().toISOString();
                    item.created_at = item.created_at || now;
                    item.updated_at = now;
                    item.version = (item.version || 0) + 1;
                    
                    // Save to database
                    await this.saveSeries(item, false);
                    importedCount++;
                    
                } catch (error) {
                    errors.push(`Error importing item "${item.record_series_title || 'Unknown'}": ${error.message}`);
                }
            }
            
            // Import audit events if present
            if (importData.audit_events && Array.isArray(importData.audit_events)) {
                for (const auditEvent of importData.audit_events) {
                    try {
                        // Remove _id to prevent conflicts
                        delete auditEvent._id;
                        await this.logAuditEvent(
                            auditEvent.entity,
                            auditEvent.entity_id,
                            auditEvent.action,
                            auditEvent.payload,
                            auditEvent.actor,
                            auditEvent.at
                        );
                    } catch (error) {
                        // Silently handle audit event import errors
                    }
                }
            }
            
            // Update UI and show results
            this.updateUI();
            
            if (errors.length > 0) {
                console.warn('Import errors:', errors);
                this.setStatus(`Imported ${importedCount} records with ${errors.length} errors`, 'success');
            } else {
                this.setStatus(`Successfully imported ${importedCount} series records`, 'success');
            }
            
        } catch (error) {
            ErrorHandler.log(error, 'Import data');
            this.setStatus(`Error importing data: ${error.message}`, 'error');
        } finally {
            // Clear the file input
            event.target.value = '';
        }
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
            
            console.log('Filtered items:', this.filteredItems.length, this.filteredItems);
            
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
        
        const activeFilters = [];
        
        if (criteria.searchText) activeFilters.push(`Text: "${criteria.searchText}"`);
        if (criteria.scheduleNumber) activeFilters.push(`Schedule: ${criteria.scheduleNumber}`);
        if (criteria.division) activeFilters.push(`Division: ${criteria.division}`);
        if (criteria.approvalStatus) activeFilters.push(`Status: ${criteria.approvalStatus}`);
        
        summary.textContent = activeFilters.length > 0 
            ? `Active filters: ${activeFilters.join(', ')}`
            : 'No active filters';
    }

    clearFilters() {
        const elements = [
            'searchInput', 'scheduleFilter', 'divisionFilter', 'statusFilter'
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
                try { await this.saveSeries(si, true); } catch (e) { ErrorHandler.log(e, 'Normalize series'); }
            }
        }
    }

    async renderResults() {
        const resultsList = document.getElementById('resultsList');
        const emptyState = document.getElementById('emptyState');
        
        console.log('Rendering results:', this.filteredItems.length, 'items');
        
        if (!resultsList) {
            console.error('Results list element not found');
            return;
        }
        
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
            console.log('No filtered items to display');
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
        
        console.log('Rendered', this.filteredItems.length, 'result rows');
        
        // Highlight selected item if any
        if (this.selectedItemId) {
            const selectedRow = resultsList.querySelector(`[data-item-id="${this.selectedItemId}"]`);
            if (selectedRow) {
                selectedRow.classList.add('selected');
            }
        }
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
                this.populateSeriesForm(seriesItem);
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
        if (!item) return;
        
        // Store current item for form operations
        this.currentSeriesItem = item;
        
        // Use the new reusable populateForm method
        this.populateForm(document.getElementById('seriesForm'), item);
        
        // Handle special cases
        if (item.dates_covered_end === 'present') {
            document.getElementById('datesEnd').value = 'present';
        }
        
        // Show delete button if this is an existing record
        const deleteBtn = document.getElementById('deleteSeriesBtn');
        if (deleteBtn) {
            deleteBtn.classList.toggle('hidden', !item._id);
        }
        
        // Show clone button if this is an existing record
        const cloneBtn = document.getElementById('cloneRecordBtn');
        if (cloneBtn) {
            cloneBtn.classList.toggle('hidden', !item._id);
        }
    }
    
    populateScheduleForm(schedule) {
        if (!schedule) return;
        
        // Store current schedule for form operations
        this.currentSchedule = schedule;
        
        // Use the new reusable populateForm method
        this.populateForm(document.getElementById('scheduleForm'), schedule);
        
        // Show schedule number as static text
        const scheduleNumEl = document.getElementById('scheduleNum');
        if (scheduleNumEl) {
            scheduleNumEl.textContent = schedule.schedule_number || 'Not assigned';
        }
        
        // Show delete button if this is an existing record
        const deleteBtn = document.getElementById('deleteScheduleBtn');
        if (deleteBtn) {
            deleteBtn.classList.toggle('hidden', !schedule._id);
        }
    }
    
    async handleSeriesFormSubmit(event) {
        event.preventDefault();
        
        try {
            const form = event.target;
            const isUpdate = !!this.currentSeriesItem?._id;
            
            // Get form data using new reusable method
            const formData = this.getFormData(form);
            
            // Create/update series item with timestamps and version
            const now = new Date().toISOString();
            const seriesItem = {
                ...(this.currentSeriesItem || {}),
                ...formData,
                updated_at: now
            };
            
            if (!isUpdate) {
                seriesItem.created_at = now;
                seriesItem.version = 1;
            } else {
                seriesItem.version = (this.currentSeriesItem.version || 0) + 1;
            }
            
            await this.saveSeries(seriesItem, isUpdate);
            await this.logAuditEvent('series', seriesItem._id, isUpdate ? 'update' : 'create', seriesItem);
            this.updateUI();
            this.setStatus(`Series item ${isUpdate ? 'updated' : 'created'} successfully`);
        } catch (error) {
            ErrorHandler.log(error, 'Series form submission');
            this.setStatus(`Error saving series item: ${error.message}`, 'error');
        }
    }
    
    async handleScheduleFormSubmit(event) {
        event.preventDefault();
        
        try {
            const form = document.getElementById('scheduleForm');
            const scheduleNumber = document.getElementById('scheduleNum').textContent;
            if (scheduleNumber === 'Not assigned') {
                throw new Error('Cannot save schedule without a schedule number');
            }
            
            // Get form data using new reusable method
            const formData = this.getFormData(form);
            
            // Create schedule object with schedule number
            const schedule = {
                ...formData,
                schedule_number: scheduleNumber
            };
            
            // Count affected series for bulk update feedback
            const allSeries = await this.getAllSeries();
            const affectedCount = allSeries.filter(s => s.schedule_number === scheduleNumber).length;
            
            await this.saveSchedule(schedule, true);
            
            const message = affectedCount > 1 
                ? `Schedule saved successfully. Updated ${affectedCount} series records.`
                : 'Schedule saved successfully';
            
            this.updateUI();
            this.setStatus(message, 'success');
        } catch (error) {
            ErrorHandler.log(error, 'Schedule form submission');
            this.setStatus(`Error saving schedule: ${error.message}`, 'error');
        }
    }
    
    // Form Handling Utilities
    getFormData(formElement) {
        const data = {};
        
        // Handle regular fields with data-field attributes
        const fields = formElement.querySelectorAll('[data-field]');
        fields.forEach(field => {
            const key = field.dataset.field;
            let value;
            
            if (field.type === 'checkbox') {
                value = field.checked;
            } else if (field.hasAttribute('data-array-input')) {
                value = this.parseArrayInput(field.value);
            } else {
                value = field.value || null;
            }
            
            // Handle nested object fields (e.g., "ui_extras.seriesDescription")
            if (key.includes('.')) {
                this.setNestedValue(data, key, value);
            } else {
                data[key] = value;
            }
        });
        
        return data;
    }
    
    populateForm(formElement, data) {
        // Handle all fields with data-field attributes
        const fields = formElement.querySelectorAll('[data-field]');
        fields.forEach(field => {
            const key = field.dataset.field;
            let value;
            
            // Get value from nested object if needed (e.g., "ui_extras.seriesDescription")
            if (key.includes('.')) {
                value = this.getNestedValue(data, key);
            } else {
                value = data[key];
            }
            
            // Set field value based on type
            if (field.type === 'checkbox') {
                field.checked = Boolean(value);
            } else if (field.hasAttribute('data-array-input') && Array.isArray(value)) {
                field.value = value.join(', ');
            } else {
                field.value = value || '';
            }
        });
    }
    
    parseArrayInput(inputValue) {
        if (!inputValue) return [];
        if (Array.isArray(inputValue)) return inputValue;
        
        // Split on commas, semicolons, or newlines
        return inputValue.split(/[,;\n]/)
            .map(item => item.trim())
            .filter(Boolean);
    }
    
    // Helper function to set nested object values (e.g., "ui_extras.seriesDescription")
    setNestedValue(obj, path, value) {
        const keys = path.split('.');
        let current = obj;
        
        for (let i = 0; i < keys.length - 1; i++) {
            const key = keys[i];
            if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
                current[key] = {};
            }
            current = current[key];
        }
        
        current[keys[keys.length - 1]] = value;
    }
    
    // Helper function to get nested object values (e.g., "ui_extras.seriesDescription")
    getNestedValue(obj, path) {
        const keys = path.split('.');
        let current = obj;
        
        for (const key of keys) {
            if (current && typeof current === 'object' && key in current) {
                current = current[key];
            } else {
                return null;
            }
        }
        
        return current;
    }
    
    // Clone Record functionality
    cloneCurrentRecord() {
        if (!this.currentSeriesItem) {
            this.setStatus('No record selected to clone', 'error');
            return;
        }
        
        // Create a new form with current data but clear identifying fields
        const clonedData = { ...this.currentSeriesItem };
        delete clonedData._id;
        delete clonedData.created_at;
        delete clonedData.updated_at;
        delete clonedData.version;
        
        // Clear the current selection to indicate this is a new record
        this.currentSeriesItem = null;
        this.selectedItemId = null;
        
        // Clear selection styling
        document.querySelectorAll('.result-item').forEach(row => row.classList.remove('selected'));
        
        // Populate the form with cloned data
        this.populateForm(document.getElementById('seriesForm'), clonedData);
        
        // Hide delete button since this is a new record
        const deleteBtn = document.getElementById('deleteSeriesBtn');
        if (deleteBtn) {
            deleteBtn.classList.add('hidden');
        }
        
        // Show clone button
        const cloneBtn = document.getElementById('cloneRecordBtn');
        if (cloneBtn) {
            cloneBtn.classList.remove('hidden');
        }
        
        this.setStatus('Record cloned. Modify as needed and save as new record.', 'success');
    }
    
    // Enhanced form event handlers setup
    setupFormEventHandlers() {
        // Series form submission
        const seriesForm = document.getElementById('seriesForm');
        if (seriesForm) {
            seriesForm.addEventListener('submit', (e) => this.handleSeriesFormSubmit(e));
        }
        
        // Schedule form submission
        const scheduleForm = document.getElementById('scheduleForm');
        if (scheduleForm) {
            scheduleForm.addEventListener('submit', (e) => this.handleScheduleFormSubmit(e));
        }
        
        // Cancel buttons
        const cancelSeriesBtn = document.getElementById('cancelSeriesBtn');
        if (cancelSeriesBtn) {
            cancelSeriesBtn.addEventListener('click', () => this.cancelSeriesEdit());
        }
        
        const cancelScheduleBtn = document.getElementById('cancelScheduleBtn');
        if (cancelScheduleBtn) {
            cancelScheduleBtn.addEventListener('click', () => this.cancelScheduleEdit());
        }
    }
    
    async handleSaveAsNew(event) {
        event.preventDefault();
        
        try {
            const form = document.getElementById('seriesForm');
            const formData = this.getFormData(form);
            
            // Validate required fields
            if (!formData.record_series_title) {
                this.setStatus('Record Series Title is required', 'error');
                return;
            }
            
            // Create new series item with timestamps
            const now = new Date().toISOString();
            const seriesItem = {
                ...formData,
                created_at: now,
                updated_at: now,
                version: 1
            };
            
            const savedItem = await this.saveSeries(seriesItem, false);
            await this.logAuditEvent('series', savedItem._id, 'create', seriesItem);
            
            this.updateUI();
            this.setStatus('New series record created successfully', 'success');
            
            // Clear form and hide details
            this.cancelSeriesEdit();
        } catch (error) {
            ErrorHandler.log(error, 'Save series as new');
            this.setStatus(`Error creating new series: ${error.message}`, 'error');
        }
    }
    
    cancelSeriesEdit() {
        this.currentSeriesItem = null;
        this.selectedItemId = null;
        
        document.querySelectorAll('.result-item').forEach(row => row.classList.remove('selected'));
        this.hideDetails();
    }
    
    cancelScheduleEdit() {
        this.currentSchedule = null;
        this.hideDetails();
    }
    
    // Status management
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
    
    // UI helper methods that may be missing
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

    // Removed saveAsNewBtn conditional event listener

    // UI helper methods that may be missing
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

    refreshCountsUI() {
        try {
            const totalSeries = this.seriesItems.length;
            const nonBlank = this.seriesItems.filter(s => s.schedule_number && s.schedule_number.trim() !== '');
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
    
    restoreSearchPaneState() {
        // Restore search pane state from localStorage if available
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
            // Collapse the search pane
            searchPane.classList.add('collapsed');
            mainContent.classList.add('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'false');
        } else {
            // Expand the search pane
            searchPane.classList.remove('collapsed');
            mainContent.classList.remove('search-collapsed');
            toggleBtn.setAttribute('aria-expanded', 'true');
        }
        
        // Save state to localStorage
        try {
            localStorage.setItem('iletsb_search_pane_collapsed', (!isCollapsed).toString());
        } catch (e) {
            // If storage is unavailable, continue without saving state
        }
    }
}

// Initialize the application when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    const app = new ILETSBApp();
    
    // Setup form event handlers after app initialization
    app.setupFormEventHandlers();
});