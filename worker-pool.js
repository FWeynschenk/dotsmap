// Worker Pool Manager for parallel dot calculation
class WorkerPool {
    constructor(numWorkers = navigator.hardwareConcurrency || 4) {
        this.numWorkers = Math.min(numWorkers, 8); // Cap at 8 workers
        this.workers = [];
        this.availableWorkers = [];
        this.taskQueue = [];
        this.initialized = false;
        this.lookupMapBuilt = false;
        
        console.log(`Initializing worker pool with ${this.numWorkers} workers`);
        
        // Create workers
        for (let i = 0; i < this.numWorkers; i++) {
            const worker = new Worker('fast-worker.js');
            worker.id = i;
            this.workers.push(worker);
            this.availableWorkers.push(worker);
        }
    }
    
    // Initialize all workers with world data
    async init(topology) {
        const initPromises = this.workers.map(worker => {
            return new Promise((resolve) => {
                const handler = (e) => {
                    if (e.data.type === 'features') {
                        worker.removeEventListener('message', handler);
                        resolve(e.data.features);
                    }
                };
                worker.addEventListener('message', handler);
                worker.postMessage({ type: 'init', payload: topology });
            });
        });
        
        const results = await Promise.all(initPromises);
        this.initialized = true;
        console.log('Worker pool initialized');
        return results[0]; // All workers return the same features
    }
    
    // Build lookup map on one worker for ultra-fast queries
    async buildLookupMap(params, onProgress) {
        if (this.lookupMapBuilt) return;
        
        const worker = this.workers[0]; // Use first worker
        
        return new Promise((resolve, reject) => {
            const handler = (e) => {
                if (e.data.type === 'lookupProgress') {
                    if (onProgress) onProgress(e.data.progress);
                } else if (e.data.type === 'lookupComplete') {
                    worker.removeEventListener('message', handler);
                    this.lookupMapBuilt = true;
                    
                    // Broadcast to other workers to build their own maps
                    const buildPromises = this.workers.slice(1).map(w => {
                        return new Promise(res => {
                            const h = (e) => {
                                if (e.data.type === 'lookupComplete') {
                                    w.removeEventListener('message', h);
                                    res();
                                }
                            };
                            w.addEventListener('message', h);
                            w.postMessage({ type: 'buildLookupMap', payload: params });
                        });
                    });
                    
                    Promise.all(buildPromises).then(() => {
                        console.log('All workers have lookup maps built');
                        resolve();
                    });
                } else if (e.data.type === 'error') {
                    worker.removeEventListener('message', handler);
                    reject(new Error(e.data.error));
                }
            };
            
            worker.addEventListener('message', handler);
            worker.postMessage({ type: 'buildLookupMap', payload: params });
        });
    }
    
    // Calculate dots using all workers in parallel
    async calculateDotsParallel(params, onProgress) {
        if (!this.initialized) {
            throw new Error('Worker pool not initialized');
        }
        
        const { width, height, spacing } = params;
        
        // Divide work into chunks across X dimension
        // IMPORTANT: Align chunk boundaries to spacing grid to prevent overlap/duplicates
        const chunks = [];
        const chunkWidth = Math.ceil(width / this.numWorkers);
        
        let lastEndX = 0; // Track where the previous chunk ended
        
        for (let i = 0; i < this.numWorkers; i++) {
            // Calculate raw boundaries
            let startX = i * chunkWidth;
            let endX = Math.min(startX + chunkWidth, width);
            
            // Align startX to spacing grid (round down to nearest multiple of spacing)
            startX = Math.floor(startX / spacing) * spacing;
            
            // CRITICAL: Ensure this chunk starts after the previous chunk ended
            // This prevents duplicate processing of the same grid points
            if (startX < lastEndX) {
                startX = lastEndX;
            }
            
            // For endX, align up to spacing (round up to next multiple)
            // But don't exceed width
            endX = Math.min(Math.ceil(endX / spacing) * spacing, width);
            
            // Ensure we don't have zero-width chunks or start beyond width
            if (startX < width && endX > startX) {
                chunks.push({
                    ...params,
                    startX,
                    endX,
                    startY: 0,
                    endY: height
                });
                lastEndX = endX; // Update for next iteration
            }
        }
        
        console.log(`Processing ${chunks.length} chunks in parallel`);
        
        // Process all chunks in parallel
        const chunkPromises = chunks.map((chunk, index) => {
            return new Promise((resolve, reject) => {
                const worker = this.workers[index % this.workers.length];
                
                const handler = (e) => {
                    if (e.data.type === 'chunkResult' && e.data.chunkId === index) {
                        worker.removeEventListener('message', handler);
                        if (onProgress) {
                            onProgress(((index + 1) / chunks.length * 100).toFixed(0));
                        }
                        resolve(e.data.result);
                    } else if (e.data.type === 'error') {
                        worker.removeEventListener('message', handler);
                        reject(new Error(e.data.error));
                    }
                };
                
                worker.addEventListener('message', handler);
                worker.postMessage({ 
                    type: 'processChunk', 
                    payload: chunk,
                    chunkId: index 
                });
            });
        });
        
        const results = await Promise.all(chunkPromises);
        
        // Check adjacent chunks for overlap at boundaries
        let duplicatesRemoved = 0;
        
        for (let i = 0; i < results.length - 1; i++) {
            const currentChunk = results[i];
            const nextChunk = results[i + 1];
            
            if (currentChunk.length === 0 || nextChunk.length === 0) continue;
            
            // Find the rightmost x coordinate in current chunk
            const currentMaxX = Math.max(...currentChunk.map(d => d.x));
            
            // Find the leftmost x coordinate in next chunk
            const nextMinX = Math.min(...nextChunk.map(d => d.x));
            
            // If they're the same or overlap (within spacing tolerance)
            if (Math.abs(currentMaxX - nextMinX) < spacing) {
                // Remove all dots from next chunk that have x === nextMinX
                const beforeLength = nextChunk.length;
                results[i + 1] = nextChunk.filter(d => Math.round(d.x) !== Math.round(nextMinX));
                duplicatesRemoved += beforeLength - results[i + 1].length;
            }
        }
        
        // Combine all results
        let allDots = results.flat();
        
        // Final pass: remove any remaining duplicates using coordinate map
        // (catches edge cases like dots at same Y in different chunks)
        const dotMap = new Map();
        const beforeFinal = allDots.length;
        
        for (const dot of allDots) {
            // Create unique key based on x,y coordinates (rounded to avoid floating point issues)
            const key = `${Math.round(dot.x)},${Math.round(dot.y)}`;
            
            if (!dotMap.has(key)) {
                dotMap.set(key, dot);
            }
        }
        
        allDots = Array.from(dotMap.values());
        duplicatesRemoved += beforeFinal - allDots.length;
        
        if (duplicatesRemoved > 0) {
            console.log(`[INFO] Removed ${duplicatesRemoved} duplicate dots at chunk boundaries`);
        }
        
        console.log(`Processed ${allDots.length} unique dots using parallel workers`);
        
        return {
            dots: allDots,
            debugInfo: { 
                totalChecks: allDots.length,
                parallelWorkers: chunks.length,
                duplicatesRemoved: duplicatesRemoved
            }
        };
    }
    
    // Calculate dots on a single worker (fallback)
    async calculateDotsSingle(params) {
        const worker = this.workers[0];
        
        return new Promise((resolve, reject) => {
            const handler = (e) => {
                if (e.data.type === 'dots') {
                    worker.removeEventListener('message', handler);
                    resolve(e.data.result);
                } else if (e.data.type === 'error') {
                    worker.removeEventListener('message', handler);
                    reject(new Error(e.data.error));
                }
            };
            
            worker.addEventListener('message', handler);
            worker.postMessage({ type: 'update', payload: params });
        });
    }
    
    // Terminate all workers
    terminate() {
        this.workers.forEach(worker => worker.terminate());
        this.workers = [];
        this.availableWorkers = [];
        this.initialized = false;
        this.lookupMapBuilt = false;
    }
}

