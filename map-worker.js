importScripts(
    "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js",
    "https://cdn.jsdelivr.net/npm/d3-geo-projection@4"
);

let world;
let currentProjection;
let spatialGrid = new Map();
let countryCircles = [];
const GRID_SIZE = 10;
let debugInfo = { totalChecks: 0, circleChecks: 0, fullChecks: 0, gridChecks: 0 };

// --- Moved Functions ---

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

function getCountryAtPoint(point) {
    debugInfo.totalChecks++;
    
    try {
        const coordinates = currentProjection.invert(point);
        if (!coordinates || !isValidCoordinate(coordinates)) return null;
        
        let [lon, lat] = coordinates;
        lon = wrapLongitude(lon);
        
        // Special handling for Alaska region
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
    currentProjection = d3[projectionName]()
        .fitSize([width, height], { type: "Sphere" });

    switch (projectionName) {
        case 'geoOrthographic':
        case 'geoStereographic':
            currentProjection.clipAngle(90);
            break;
        case 'geoGnomonic':
            currentProjection.clipAngle(60);
            break;
        case 'geoAlbers':
        case 'geoConicEqualArea':
        case 'geoConicEquidistant':
            currentProjection
                .parallels([20, 50])
                .center([0, 40]);
            break;
    }

    return currentProjection;
}

function createDotsGrid(spacing, width, height) {
    const dots = [];
    // Important: We can process this in chunks if needed, but for now let's do it all
    for (let x = 0; x < width; x += spacing) {
        for (let y = 0; y < height; y += spacing) {
            dots.push([x, y]);
        }
    }
    return dots;
}

// --- Message Handler ---

self.onmessage = function(e) {
    const { type } = e.data;

    if (type === 'init') {
        world = e.data.world;
        
        // Pre-process world data (same as original code)
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

        countryCircles = world.features.flatMap(country => {
            const bounds = calculateCircularBounds(country);
            if (Array.isArray(bounds)) {
                return bounds.map(bound => ({ country, bounds: bound }));
            }
            return [{ country, bounds }];
        });

        initializeSpatialGrid();
        self.postMessage({ type: 'initComplete' });
    
    } else if (type === 'calculate') {
        const { width, height, spacing, projectionName } = e.data;
        
        debugInfo = { totalChecks: 0, circleChecks: 0, fullChecks: 0, gridChecks: 0 };
        setupProjection(projectionName, width, height);
        
        const rawDots = createDotsGrid(spacing, width, height);
        const results = [];
        
        for (const point of rawDots) {
            if (isPointInProjection(point)) {
                const country = getCountryAtPoint(point);
                // Return relevant data. We can't pass the full country object easily if it has circular refs or is huge, 
                // but here it's just JSON data. Passing the name is lighter.
                // But the main thread needs to color it.
                // If we pass the country name, main thread can look it up or just use the name for coloring.
                
                results.push({
                    x: point[0],
                    y: point[1],
                    countryName: country ? country.properties.name : null,
                    coords: currentProjection.invert(point) // Optional, if needed for hover
                });
            }
        }
        
        self.postMessage({ 
            type: 'result', 
            dots: results,
            debugInfo 
        });
    }
};

