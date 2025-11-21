importScripts(
    "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js",
    "https://cdn.jsdelivr.net/npm/d3-geo-projection@4"
);

let world;
let countryCircles = [];
let spatialGrid = new Map();
let countryLookupMap = null; // Pre-computed pixel map for fast lookups
const GRID_SIZE = 10;
let currentProjection;
let debugInfo = { totalChecks: 0, circleChecks: 0, fullChecks: 0, gridChecks: 0 };

// Chunk size for parallel processing
const CHUNK_SIZE = 5000;

self.onmessage = function(e) {
    const { type, payload, chunkId } = e.data;
    
    try {
        if (type === 'init') {
            initializeWorld(payload);
        } else if (type === 'update') {
            const result = calculateDots(payload);
            self.postMessage({ type: 'dots', result, params: payload });
        } else if (type === 'processChunk') {
            const result = processChunk(payload, chunkId);
            self.postMessage({ type: 'chunkResult', result, chunkId, params: payload });
        } else if (type === 'buildLookupMap') {
            buildCountryLookupMap(payload);
        }
    } catch (err) {
        console.error("Worker error:", err);
        self.postMessage({ type: 'error', error: err.message });
    }
};

function initializeWorld(topology) {
    world = topojson.feature(topology, topology.objects.countries);
    
    // Process features
    world.features = world.features.map(feature => {
        const processCoordinates = coords => {
            return coords.map(coord => {
                let [lon, lat] = coord;
                if (Math.abs(lat) > 60) {
                    if (lon > 180) lon -= 360;
                    if (lon <= -180) lon += 360;
                }
                return [wrapLongitude(lon), lat];
            });
        };

        if (feature.geometry.type === "MultiPolygon") {
            feature.geometry.coordinates = feature.geometry.coordinates.map(poly =>
                poly.map(processCoordinates)
            );
        } else if (feature.geometry.type === "Polygon") {
            feature.geometry.coordinates = feature.geometry.coordinates.map(processCoordinates);
        }
        
        return feature;
    });

    // Pre-calculate circular bounds
    countryCircles = world.features.flatMap(country => {
        const bounds = calculateCircularBounds(country);
        if (Array.isArray(bounds)) {
            return bounds.map(bound => ({
                country: country,
                bounds: bound
            }));
        }
        return [{
            country: country,
            bounds: bounds
        }];
    });

    initializeSpatialGrid();

    // Send processed features back to main thread
    self.postMessage({ type: 'features', features: world.features });
}

// Build a lookup map for ultra-fast country detection
function buildCountryLookupMap({ width, height, projectionName, resolution = 2 }) {
    currentProjection = setupProjection(projectionName, width, height);
    
    const mapWidth = Math.ceil(width / resolution);
    const mapHeight = Math.ceil(height / resolution);
    
    // Use a typed array for memory efficiency
    // Store country index (0 = ocean, 1+ = country index)
    countryLookupMap = {
        data: new Uint16Array(mapWidth * mapHeight),
        width: mapWidth,
        height: mapHeight,
        resolution: resolution
    };
    
    // Build the map
    for (let y = 0; y < mapHeight; y++) {
        for (let x = 0; x < mapWidth; x++) {
            const px = x * resolution;
            const py = y * resolution;
            const country = getCountryAtPointSlow([px, py]);
            const countryIndex = country ? world.features.indexOf(country) + 1 : 0;
            countryLookupMap.data[y * mapWidth + x] = countryIndex;
        }
        
        // Report progress
        if (y % 10 === 0) {
            self.postMessage({ 
                type: 'lookupProgress', 
                progress: (y / mapHeight * 100).toFixed(1) 
            });
        }
    }
    
    self.postMessage({ type: 'lookupComplete' });
}

// Fast country lookup using the pre-computed map
function getCountryAtPointFast(point) {
    if (!countryLookupMap) {
        return getCountryAtPointSlow(point);
    }
    
    const x = Math.floor(point[0] / countryLookupMap.resolution);
    const y = Math.floor(point[1] / countryLookupMap.resolution);
    
    if (x < 0 || x >= countryLookupMap.width || y < 0 || y >= countryLookupMap.height) {
        return null;
    }
    
    const index = countryLookupMap.data[y * countryLookupMap.width + x];
    return index > 0 ? world.features[index - 1] : null;
}

// Process a chunk of dots
function processChunk({ width, height, projectionName, spacing, showOceanDots, startX, endX, startY, endY }, chunkId) {
    if (!currentProjection) {
        currentProjection = setupProjection(projectionName, width, height);
    }
    
    const results = [];
    
    for (let x = startX; x < endX; x += spacing) {
        for (let y = startY; y < endY; y += spacing) {
            const point = [x, y];
            if (isPointInProjection(point)) {
                const country = countryLookupMap ? getCountryAtPointFast(point) : getCountryAtPointSlow(point);
                if (!country && !showOceanDots) continue;
                
                results.push({
                    x: point[0],
                    y: point[1],
                    countryName: country ? country.properties.name : null,
                    coords: currentProjection.invert(point)
                });
            }
        }
    }
    
    return results;
}

function calculateDots({ width, height, projectionName, spacing, showOceanDots }) {
    debugInfo = { totalChecks: 0, circleChecks: 0, fullChecks: 0, gridChecks: 0 };
    currentProjection = setupProjection(projectionName, width, height);
    
    const dots = createDotsGrid(spacing, width, height)
        .filter(point => isPointInProjection(point));
    
    const useFast = countryLookupMap && 
                    countryLookupMap.width === Math.ceil(width / countryLookupMap.resolution) &&
                    countryLookupMap.height === Math.ceil(height / countryLookupMap.resolution);
    
    const results = dots.map(point => {
        const country = useFast ? getCountryAtPointFast(point) : getCountryAtPointSlow(point);
        if (!country && !showOceanDots) return null;
        
        return {
            x: point[0],
            y: point[1],
            countryName: country ? country.properties.name : null,
            coords: currentProjection.invert(point)
        };
    }).filter(d => d !== null);

    return {
        dots: results,
        debugInfo
    };
}

// --- Helper Functions ---

function calculateCircularBounds(geometry) {
    const bounds = d3.geoBounds(geometry);
    let [minLon, minLat] = bounds[0];
    let [maxLon, maxLat] = bounds[1];
    
    const isPolar = Math.abs(minLat) > 80 || Math.abs(maxLat) > 80;
    const crossesAntimeridian = maxLon < minLon || (maxLon - minLon) > 350;
    
    const centroid = d3.geoCentroid(geometry);
    const isRussia = centroid[1] > 50 && centroid[0] > 60 && centroid[0] < 180;
    const isUSA = centroid[1] > 30 && centroid[0] < -30 && centroid[0] > -180;
    const isAntarctica = centroid[1] < -60;
    
    if (isAntarctica) {
        return {
            center: [0, -90],
            radius: Math.PI / 2.5,
            isPolar: true,
            crossesAntimeridian: true,
            isSpecialRegion: true,
            regionType: 'antarctica'
        };
    }
    
    if (isRussia) {
        return {
            center: [100, 65],
            radius: Math.PI / 2.5,
            isPolar: true,
            crossesAntimeridian: true,
            isSpecialRegion: true,
            regionType: 'russia'
        };
    }
    
    if (isUSA) {
        const mainBounds = {
            center: centroid,
            radius: Math.PI / 4,
            isPolar: false,
            crossesAntimeridian: false,
            isSpecialRegion: true,
            regionType: 'usa-main'
        };
        
        const alaskaBounds = {
            center: [-170, 65],
            radius: Math.PI / 3.5,
            isPolar: true,
            crossesAntimeridian: true,
            isSpecialRegion: true,
            regionType: 'usa-alaska'
        };
        
        return [mainBounds, alaskaBounds];
    }

    if (isPolar) {
        const latCenter = (minLat + maxLat) / 2;
        if (latCenter > 60) {
            return {
                center: centroid,
                radius: Math.PI / 3,
                isPolar: true,
                crossesAntimeridian: crossesAntimeridian,
                isSpecialRegion: false,
                regionType: 'polar'
            };
        }
    }

    let maxDistance = 0;
    const sampleCount = isPolar ? 100 : 50;
    
    for (let i = 0; i <= sampleCount; i++) {
        const lat = minLat + (maxLat - minLat) * (i / sampleCount);
        for (let j = 0; j <= sampleCount; j++) {
            let lon;
            if (crossesAntimeridian) {
                const span = (360 + maxLon - minLon) % 360;
                lon = minLon + span * (j / sampleCount);
                if (lon > 180) lon -= 360;
            } else {
                lon = minLon + (maxLon - minLon) * (j / sampleCount);
            }
            
            if (d3.geoContains(geometry, [lon, lat])) {
                const distance = d3.geoDistance(centroid, [lon, lat]);
                maxDistance = Math.max(maxDistance, distance);
            }
        }
    }

    return {
        center: centroid,
        radius: maxDistance * (crossesAntimeridian ? 1.2 : 1.02),
        isPolar,
        crossesAntimeridian,
        isSpecialRegion: false,
        regionType: 'standard'
    };
}

function initializeSpatialGrid() {
    spatialGrid.clear();
    
    countryCircles.forEach(({ country, bounds }) => {
        const center = bounds.center;
        const radiusDegrees = bounds.radius * 180 / Math.PI;
        
        const minLat = Math.max(-90, Math.floor((center[1] - radiusDegrees) / GRID_SIZE) * GRID_SIZE);
        const maxLat = Math.min(90, Math.ceil((center[1] + radiusDegrees) / GRID_SIZE) * GRID_SIZE);
        
        let minLon = Math.floor((center[0] - radiusDegrees) / GRID_SIZE) * GRID_SIZE;
        let maxLon = Math.ceil((center[0] + radiusDegrees) / GRID_SIZE) * GRID_SIZE;
        
        for (let lat = minLat; lat < maxLat; lat += GRID_SIZE) {
            for (let lon = minLon; lon < maxLon; lon += GRID_SIZE) {
                const wrappedLon = ((lon + 180) % 360) - 180;
                const cellKey = `${lat},${wrappedLon}`;
                if (!spatialGrid.has(cellKey)) {
                    spatialGrid.set(cellKey, []);
                }
                spatialGrid.get(cellKey).push({ country, bounds });
            }
        }
    });
}

function getGridCell(coordinates) {
    const [lon, lat] = coordinates;
    const gridLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
    let gridLon = Math.floor(lon / GRID_SIZE) * GRID_SIZE;
    gridLon = ((gridLon + 180) % 360) - 180;
    return `${gridLat},${gridLon}`;
}

function createDotsGrid(spacing, width, height) {
    const dots = [];
    for (let x = 0; x < width; x += spacing) {
        for (let y = 0; y < height; y += spacing) {
            dots.push([x, y]);
        }
    }
    return dots;
}

function isValidCoordinate(coordinates) {
    const [lon, lat] = coordinates;
    return !isNaN(lon) && !isNaN(lat) && 
           Math.abs(lat) <= 90 && 
           isFinite(lon);
}

function wrapLongitude(lon) {
    lon = ((lon + 180) % 360) - 180;
    if (lon <= -180) lon += 360;
    if (lon > 180) lon -= 360;
    return lon;
}

// Original slow but accurate method
function getCountryAtPointSlow(point) {
    debugInfo.totalChecks++;
    
    try {
        const coordinates = currentProjection.invert(point);
        if (!coordinates || !isValidCoordinate(coordinates)) return null;
        
        let [lon, lat] = coordinates;
        lon = wrapLongitude(lon);
        
        if (lat > 50 && lon < -150) {
            debugInfo.fullChecks++;
            for (const { country, bounds } of countryCircles) {
                if (bounds.regionType === 'usa-alaska') {
                    const testLons = [lon];
                    if (lon < -170) testLons.push(lon + 360);
                    
                    for (const testLon of testLons) {
                        if (d3.geoContains(country, [testLon, lat])) {
                            return country;
                        }
                    }
                }
            }
        }
        
        const isNearAntimeridian = lon > 150 || lon < -150;
        const isHighLatitude = Math.abs(lat) > 60;
        
        if (isHighLatitude || isNearAntimeridian) {
            for (const { country, bounds } of countryCircles) {
                if (bounds.isSpecialRegion) {
                    debugInfo.fullChecks++;
                    const testLons = [lon];
                    if (lon > 150) testLons.push(lon - 360);
                    if (lon < -150) testLons.push(lon + 360);
                    
                    for (const testLon of testLons) {
                        if (d3.geoContains(country, [testLon, lat])) {
                            return country;
                        }
                    }
                }
            }
        }
        
        const lons = [lon];
        if (lon > 150) lons.push(lon - 360);
        if (lon < -150) lons.push(lon + 360);
        
        debugInfo.gridChecks++;
        const candidates = new Set(
            lons.flatMap(testLon => {
                const cell = getGridCell([testLon, lat]);
                return spatialGrid.get(cell) || [];
            })
        );

        for (const { country, bounds } of candidates) {
            debugInfo.circleChecks++;
            
            if (bounds.isPolar || bounds.crossesAntimeridian) {
                debugInfo.fullChecks++;
                if (lons.some(testLon => d3.geoContains(country, [testLon, lat]))) {
                    return country;
                }
            } else {
                const withinBounds = lons.some(testLon => 
                    d3.geoDistance(bounds.center, [testLon, lat]) <= bounds.radius
                );
                
                if (withinBounds) {
                    debugInfo.fullChecks++;
                    if (lons.some(testLon => d3.geoContains(country, [testLon, lat]))) {
                        return country;
                    }
                }
            }
        }
        
        return null;
    } catch (e) {
        console.error('Error in getCountryAtPoint:', e);
        return null;
    }
}

function isPointInProjection(point) {
    try {
        const coords = currentProjection.invert(point);
        if (!coords) return false;
        const [lon, lat] = coords;
        return !isNaN(lon) && !isNaN(lat) &&
            Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
    } catch (e) {
        return false;
    }
}

function setupProjection(projectionName, width, height) {
    const projection = d3[projectionName]()
        .fitSize([width, height], { type: "Sphere" });

    switch (projectionName) {
        case 'geoOrthographic':
        case 'geoStereographic':
            projection.clipAngle(90);
            break;
        case 'geoGnomonic':
            projection.clipAngle(60);
            break;
        case 'geoAlbers':
        case 'geoConicEqualArea':
        case 'geoConicEquidistant':
            projection
                .parallels([20, 50])
                .center([0, 40]);
            break;
    }

    return projection;
}

