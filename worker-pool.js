// Worker Pool Manager for parallel dot calculation
class WorkerPool {
    constructor(numWorkers = navigator.hardwareConcurrency || 4) {
        this.numWorkers = Math.min(numWorkers, 8); // Cap at 8 workers
        this.workers = [];
        this.availableWorkers = [];
        this.taskQueue = [];
        this.initialized = false;

        console.log(`Initializing worker pool with ${this.numWorkers} workers`);
        
        // Create workers
        for (let i = 0; i < this.numWorkers; i++) {
            const worker = new Worker('fast-worker.js');
            worker.id = i;
            this.workers.push(worker);
            this.availableWorkers.push(worker);
        }
    }
    
    // Initialize all workers with world data. Returns { features, neighbors }.
    async init(topology) {
        const initPromises = this.workers.map(worker => {
            return new Promise((resolve) => {
                const handler = (e) => {
                    if (e.data.type === 'features') {
                        worker.removeEventListener('message', handler);
                        resolve({ features: e.data.features, neighbors: e.data.neighbors });
                    }
                };
                worker.addEventListener('message', handler);
                worker.postMessage({ type: 'init', payload: topology });
            });
        });

        const results = await Promise.all(initPromises);
        this.initialized = true;
        console.log('Worker pool initialized');
        return results[0]; // All workers return the same data
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

        // Chunk boundaries are aligned to the spacing grid and chained via
        // lastEndX, and each chunk iterates x < endX (half-open), so chunks are
        // contiguous and non-overlapping by construction — no dedup needed.
        // (The old spread-based dedup also overflowed the stack at tiny spacing,
        // where a single chunk can hold hundreds of thousands of dots.)
        const allDots = results.flat();

        console.log(`Processed ${allDots.length} dots using parallel workers`);

        return {
            dots: allDots,
            debugInfo: {
                totalChecks: allDots.length,
                parallelWorkers: chunks.length,
                duplicatesRemoved: 0
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
    }
}

