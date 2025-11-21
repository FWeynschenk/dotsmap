// Enhanced cache manager with localStorage persistence
class CacheManager {
    constructor(maxMemoryItems = 10, useLocalStorage = true) {
        this.memoryCache = new Map();
        this.maxMemoryItems = maxMemoryItems;
        this.useLocalStorage = useLocalStorage;
        this.cachePrefix = 'dotsmap_cache_';
        this.metadataKey = 'dotsmap_cache_metadata';
        
        // Load metadata from localStorage
        this.loadMetadata();
        
        // Clean old entries periodically
        this.cleanOldEntries();
    }
    
    // Generate cache key from parameters
    generateKey(params) {
        const { projectionName, width, height, spacing, showOceanDots } = params;
        return `${projectionName}-${width}-${height}-${spacing}-${showOceanDots}`;
    }
    
    // Load metadata about cached items
    loadMetadata() {
        if (!this.useLocalStorage) return;
        
        try {
            const metadataStr = localStorage.getItem(this.metadataKey);
            this.metadata = metadataStr ? JSON.parse(metadataStr) : {};
        } catch (e) {
            console.warn('Failed to load cache metadata:', e);
            this.metadata = {};
        }
    }
    
    // Save metadata
    saveMetadata() {
        if (!this.useLocalStorage) return;
        
        try {
            localStorage.setItem(this.metadataKey, JSON.stringify(this.metadata));
        } catch (e) {
            console.warn('Failed to save cache metadata:', e);
        }
    }
    
    // Get from cache
    get(params) {
        const key = this.generateKey(params);
        
        // Try memory cache first (fastest)
        if (this.memoryCache.has(key)) {
            console.log('[OK] Memory cache hit:', key);
            return this.memoryCache.get(key);
        }
        
        // Try localStorage (slower but persistent)
        if (this.useLocalStorage) {
            try {
                const storageKey = this.cachePrefix + key;
                const cachedStr = localStorage.getItem(storageKey);
                
                if (cachedStr) {
                    const cached = JSON.parse(cachedStr);
                    console.log('[OK] LocalStorage cache hit:', key);
                    
                    // Move to memory cache
                    this.memoryCache.set(key, cached);
                    this.enforceSizeLimit();
                    
                    // Update access time
                    if (this.metadata[key]) {
                        this.metadata[key].lastAccess = Date.now();
                        this.saveMetadata();
                    }
                    
                    return cached;
                }
            } catch (e) {
                console.warn('Failed to read from localStorage:', e);
            }
        }
        
        console.log('✗ Cache miss:', key);
        return null;
    }
    
    // Set in cache
    set(params, data) {
        const key = this.generateKey(params);
        
        // Save to memory cache
        this.memoryCache.set(key, data);
        this.enforceSizeLimit();
        
        // Save to localStorage
        if (this.useLocalStorage) {
            try {
                const storageKey = this.cachePrefix + key;
                const dataStr = JSON.stringify(data);
                
                // Check if data is too large (localStorage has ~5-10MB limit)
                if (dataStr.length > 4 * 1024 * 1024) { // 4MB limit
                    console.warn('Cache entry too large for localStorage:', key);
                    return;
                }
                
                localStorage.setItem(storageKey, dataStr);
                
                // Update metadata
                if (!this.metadata[key]) {
                    this.metadata[key] = {
                        created: Date.now(),
                        lastAccess: Date.now(),
                        size: dataStr.length
                    };
                } else {
                    this.metadata[key].lastAccess = Date.now();
                }
                
                this.saveMetadata();
                console.log('[OK] Saved to cache:', key);
            } catch (e) {
                // localStorage full or disabled
                console.warn('Failed to save to localStorage:', e);
                
                // Try to free up space
                if (e.name === 'QuotaExceededError') {
                    this.cleanOldEntries(true);
                }
            }
        }
    }
    
    // Enforce memory cache size limit (LRU)
    enforceSizeLimit() {
        if (this.memoryCache.size > this.maxMemoryItems) {
            // Remove oldest entry
            const firstKey = this.memoryCache.keys().next().value;
            this.memoryCache.delete(firstKey);
        }
    }
    
    // Clean old entries from localStorage
    cleanOldEntries(aggressive = false) {
        if (!this.useLocalStorage) return;
        
        try {
            const maxAge = aggressive ? 1 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000; // 1 or 7 days
            const now = Date.now();
            
            const keysToDelete = [];
            
            for (const [key, meta] of Object.entries(this.metadata)) {
                if (now - meta.lastAccess > maxAge) {
                    keysToDelete.push(key);
                }
            }
            
            if (aggressive && keysToDelete.length === 0) {
                // If aggressive and nothing to delete, remove oldest entries
                const sortedKeys = Object.entries(this.metadata)
                    .sort((a, b) => a[1].lastAccess - b[1].lastAccess)
                    .slice(0, Math.floor(Object.keys(this.metadata).length / 2))
                    .map(([key]) => key);
                keysToDelete.push(...sortedKeys);
            }
            
            keysToDelete.forEach(key => {
                localStorage.removeItem(this.cachePrefix + key);
                delete this.metadata[key];
            });
            
            if (keysToDelete.length > 0) {
                console.log(`Cleaned ${keysToDelete.length} old cache entries`);
                this.saveMetadata();
            }
        } catch (e) {
            console.warn('Failed to clean old entries:', e);
        }
    }
    
    // Clear all cache
    clear() {
        this.memoryCache.clear();
        
        if (this.useLocalStorage) {
            try {
                Object.keys(this.metadata).forEach(key => {
                    localStorage.removeItem(this.cachePrefix + key);
                });
                this.metadata = {};
                this.saveMetadata();
                console.log('[OK] Cache cleared');
            } catch (e) {
                console.warn('Failed to clear cache:', e);
            }
        }
    }
    
    // Get cache statistics
    getStats() {
        const memorySize = this.memoryCache.size;
        const storageSize = Object.keys(this.metadata).length;
        const totalBytes = Object.values(this.metadata).reduce((sum, meta) => sum + (meta.size || 0), 0);
        
        return {
            memoryItems: memorySize,
            storageItems: storageSize,
            totalBytes: totalBytes,
            totalMB: (totalBytes / 1024 / 1024).toFixed(2)
        };
    }
}

