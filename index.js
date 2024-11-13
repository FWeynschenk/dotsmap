function normalizePolygon(polygon) {
    // Ensure polygon rings are correctly oriented and closed
    return polygon.map(ring => {
        if (ring[0][0] !== ring[ring.length - 1][0] || ring[0][1] !== ring[ring.length - 1][1]) {
            ring = [...ring, ring[0]];
        }
        return ring;
    });
}

function normalizeGeometry(geometry) {
    if (geometry.type === "Polygon") {
        geometry.coordinates = normalizePolygon(geometry.coordinates);
    } else if (geometry.type === "MultiPolygon") {
        geometry.coordinates = geometry.coordinates.map(normalizePolygon);
    }
    return geometry;
}

function generateColorScheme(countries, schemeName, baseColor) {
    const colors = new Map();
    
    switch (schemeName) {
        case 'rainbow':
            // Current rainbow implementation
            countries.forEach((country, i) => {
                const scaleIndex = Math.floor(i / (countries.length / colorScales.length));
                const scale = colorScales[scaleIndex];
                const basePosition = (i % (countries.length / colorScales.length)) / (countries.length / colorScales.length);
                const variation = (Math.random() - 0.5) * 0.1;
                colors.set(country.properties.name, scale(basePosition + variation));
            });
            break;
            
        case 'greyscale':
            countries.forEach((country, i) => {
                const value = 0.2 + (0.6 * i / countries.length); // Range from 20% to 80% grey
                const variation = (Math.random() - 0.5) * 0.1;
                const adjustedValue = Math.max(0.1, Math.min(0.9, value + variation));
                colors.set(country.properties.name, `rgb(${Math.floor(adjustedValue * 255)},${Math.floor(adjustedValue * 255)},${Math.floor(adjustedValue * 255)})`);
            });
            break;
            
        case 'monotone':
            // Convert hex to RGB for manipulation
            const hex = baseColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            
            countries.forEach((country, i) => {
                const intensity = 0.3 + (0.7 * i / countries.length); // Range from 30% to 100%
                const variation = (Math.random() - 0.5) * 0.1;
                const adjustedIntensity = Math.max(0.2, Math.min(1, intensity + variation));
                colors.set(country.properties.name, 
                    `rgb(${Math.floor(r * adjustedIntensity)},${Math.floor(g * adjustedIntensity)},${Math.floor(b * adjustedIntensity)})`
                );
            });
            break;
    }
    
    return colors;
}

function drawShape(selection, shape, size) {
    switch (shape) {
        case 'circle':
            selection
                .attr("d", null)
                .attr("width", null)
                .attr("height", null)
                .attr("r", size);
            break;
            
        case 'square':
            const sideLength = size * 1.8; // Adjust size to appear visually similar to circle
            selection
                .attr("r", null)
                .attr("width", sideLength)
                .attr("height", sideLength)
                .attr("x", d => d[0] - sideLength/2)
                .attr("y", d => d[1] - sideLength/2);
            break;
            
        case 'diamond':
            const diamondSize = size * 2;
            selection
                .attr("r", null)
                .attr("width", null)
                .attr("height", null)
                .attr("d", d => `M ${d[0]} ${d[1]-diamondSize} L ${d[0]+diamondSize} ${d[1]} L ${d[0]} ${d[1]+diamondSize} L ${d[0]-diamondSize} ${d[1]} Z`);
            break;
            
        case 'triangle':
            const triangleSize = size * 2;
            selection
                .attr("r", null)
                .attr("width", null)
                .attr("height", null)
                .attr("d", d => `M ${d[0]} ${d[1]-triangleSize} L ${d[0]+triangleSize} ${d[1]+triangleSize} L ${d[0]-triangleSize} ${d[1]+triangleSize} Z`);
            break;
    }
}

function updateDimensions() {
    const container = document.querySelector('.container');
    const width = container.clientWidth;
    const height = width * 0.6;
    return { width, height };
}

let world;
let currentProjection;
let path;
let countryColors = {};
let countryCircles = [];
let spatialGrid = new Map(); // Grid for spatial indexing
const GRID_SIZE = 10; // Degrees per grid cell
const graticule = d3.geoGraticule();
let debugInfo = { totalChecks: 0, circleChecks: 0, fullChecks: 0, gridChecks: 0 };

const colorScale = d3.scaleSequential(d3.interpolateRainbow);

// Enhanced color generation
const colorScales = [
    d3.interpolateRainbow,
    d3.interpolateWarm,
    d3.interpolateCool,
    d3.interpolatePlasma
];

function debugCountry(name) {
    const country = world.features.find(f => f.properties.name === name);
    if (!country) {
        console.log(`Country ${name} not found`);
        return;
    }
    console.log(`Country ${name} found:`, {
        type: country.geometry.type,
        bounds: d3.geoBounds(country),
        centroid: d3.geoCentroid(country),
        properties: country.properties
    });
}

function generateCountryColors(countries) {
    const colors = new Map();
    countries.forEach((country, i) => {
        // Use different color scales for different ranges
        const scaleIndex = Math.floor(i / (countries.length / colorScales.length));
        const scale = colorScales[scaleIndex];
        // Add slight variations within each scale
        const basePosition = (i % (countries.length / colorScales.length)) / (countries.length / colorScales.length);
        const variation = (Math.random() - 0.5) * 0.1; // Add ±5% random variation
        colors.set(country.properties.name, scale(basePosition + variation));
    });
    return colors;
}

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
    
    // Special handling for specific regions
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
        // Create two bounding circles for USA/Alaska
        const mainBounds = {
            center: centroid,
            radius: Math.PI / 4,
            isPolar: false,
            crossesAntimeridian: false,
            isSpecialRegion: true,
            regionType: 'usa-main'
        };
        
        // Specific bounds for western Alaska
        const alaskaBounds = {
            center: [-170, 65], // Centered over western Alaska
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

// Create spatial grid index
function initializeSpatialGrid() {
    spatialGrid.clear();
    
    countryCircles.forEach(({ country, bounds }) => {
        const center = bounds.center;
        const radiusDegrees = bounds.radius * 180 / Math.PI;
        
        const minLat = Math.max(-90, Math.floor((center[1] - radiusDegrees) / GRID_SIZE) * GRID_SIZE);
        const maxLat = Math.min(90, Math.ceil((center[1] + radiusDegrees) / GRID_SIZE) * GRID_SIZE);
        
        // Calculate longitude range considering antimeridian
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
    
    // Ensure longitude is in [-180, 180] range
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
           isFinite(lon); // Allow any finite longitude
}

function wrapLongitude(lon) {
    // More precise wrapping for edge cases
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
            // Check specifically for western Alaska points
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
        
        // Handle other special regions
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
        
        // Standard processing for other regions
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

function getProjectionOutline() {
    return { type: "Sphere" };
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

function updateDebugInfo() {
    const debug = document.getElementById('debug');
    if (document.getElementById('showDebug').checked) {
        debug.style.display = 'block';
        debug.innerHTML = `
            Total points checked: ${debugInfo.totalChecks}<br>
            Grid cell checks: ${debugInfo.gridChecks}<br>
            Circle bound checks: ${debugInfo.circleChecks}<br>
            Full geometry checks: ${debugInfo.fullChecks}<br>
            Grid filter efficiency: ${((1 - debugInfo.circleChecks / debugInfo.gridChecks) * 100).toFixed(1)}%<br>
            Circle filter efficiency: ${((1 - debugInfo.fullChecks / debugInfo.circleChecks) * 100).toFixed(1)}%
        `;
    } else {
        debug.style.display = 'none';
    }
}

function updateMap() {
    debugInfo = { totalChecks: 0, circleChecks: 0, fullChecks: 0, gridChecks: 0 };
    
    const { width, height } = updateDimensions();
    const projectionName = document.getElementById("projection").value;
    const spacing = parseInt(document.getElementById("spacing").value);
    const dotSize = parseInt(document.getElementById("dotSize").value);
    const showCountries = document.getElementById("showCountries").checked;
    const showOutline = document.getElementById("showOutline").checked;
    const showOcean = document.getElementById("showOcean").checked;
    const showDots = document.getElementById("showDots").checked;
    const showGraticules = document.getElementById("showGraticules").checked;
    const showOceanDots = document.getElementById("showOceanDots").checked;
    const enableHover = document.getElementById("enableHover").checked;

    const svg = d3.select("#map")
        .attr("width", width)
        .attr("height", height);

    svg.selectAll("*").remove();
    
    currentProjection = setupProjection(projectionName, width, height);
    path = d3.geoPath(currentProjection);

    const clipId = "projection-clip";
    const outline = getProjectionOutline();
    
    svg.append("defs")
        .append("clipPath")
        .attr("id", clipId)
        .append("path")
        .attr("d", path(outline));

    const mainGroup = svg.append("g")
        .attr("clip-path", `url(#${clipId})`);

    if (showOcean) {
        mainGroup.append("rect")
            .attr("width", width)
            .attr("height", height)
            .attr("fill", "#cce5ff");
    }

    if (showGraticules) {
        mainGroup.append("path")
            .datum(graticule)
            .attr("class", "graticule")
            .attr("d", path)
            .attr("fill", "none")
            .attr("stroke", "#ccc")
            .attr("stroke-width", 0.5)
            .attr("stroke-dasharray", "2,2");
    }

    if (showCountries) {
        mainGroup.append("g")
            .selectAll("path")
            .data(world.features)
            .enter()
            .append("path")
            .attr("d", path)
            .attr("fill", "#e0e0e0")
            .attr("stroke", "#999")
            .attr("stroke-width", 0.5);
    }

    if (showDots) {
        console.time('dot placement');
        const dots = createDotsGrid(spacing, width, height)
            .filter(point => isPointInProjection(point));
        
        const dotsGroup = mainGroup.append("g");
        
        // Create tooltip
        const tooltip = d3.select("body").selectAll(".dot-tooltip").data([0])
            .join("div")
            .attr("class", "dot-tooltip")
            .style("position", "absolute")
            .style("visibility", "hidden")
            .style("background-color", "rgba(255, 255, 255, 0.9)")
            .style("padding", "5px")
            .style("border", "1px solid #999")
            .style("border-radius", "4px")
            .style("pointer-events", "none")
            .style("font-family", "sans-serif")
            .style("font-size", "12px")
            .style("z-index", "1000");
    
        dotsGroup.selectAll("circle")
            .data(dots)
            .join("circle")
            .each(function(d) {
                // Store both country and coordinates for each dot
                const country = getCountryAtPoint(d);
                d.country = country;
                d.coords = currentProjection.invert(d);
            })
            .filter(d => showOceanDots || d.country)
            .attr("cx", d => d[0])
            .attr("cy", d => d[1])
            .attr("r", dotSize)
            .attr("fill", d => d.country ? countryColors.get(d.country.properties.name) : "#99ccff")
            .attr("opacity", 0.8);
    
        if (enableHover) {
            dotsGroup.selectAll("circle")
                .on("mouseover", function(event, d) {
                    if (!d.coords) return;
                    
                    const [lon, lat] = d.coords;
                    const countryName = d.country ? d.country.properties.name : "Ocean";
                    
                    tooltip
                        .style("visibility", "visible")
                        .html(`
                            Location: ${countryName}<br>
                            Lat: ${lat.toFixed(2)}°<br>
                            Lon: ${lon.toFixed(2)}°
                        `);
                    
                    // Highlight the hovered dot
                    d3.select(this)
                        .attr("stroke", "#000")
                        .attr("stroke-width", "1px")
                        .attr("opacity", 1);
                })
                .on("mousemove", function(event) {
                    tooltip
                        .style("top", (event.pageY + 10) + "px")
                        .style("left", (event.pageX + 10) + "px");
                })
                .on("mouseout", function() {
                    tooltip.style("visibility", "hidden");
                    
                    // Remove highlight
                    d3.select(this)
                        .attr("stroke", null)
                        .attr("stroke-width", null)
                        .attr("opacity", 0.8);
                });
        }
    
        console.timeEnd('dot placement');
    }

    if (showOutline) {
        svg.append("path")
            .datum(outline)
            .attr("d", path)
            .attr("fill", "none")
            .attr("stroke", "#000")
            .attr("stroke-width", 1);
    }

    updateDebugInfo();
}

Promise.all([
    d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
]).then(([topology]) => {
    world = topojson.feature(topology, topology.objects.countries);
    
    // Debug Russia's data
    debugCountry("Russia");
    world.features = world.features.map(feature => {
        // Enhance coordinate wrapping for problematic regions
        const processCoordinates = coords => {
            return coords.map(coord => {
                let [lon, lat] = coord;
                // Special handling for high latitudes
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
    
    console.time('preprocessing');
    // Pre-calculate circular bounds
    countryCircles = world.features.flatMap(country => {
        const bounds = calculateCircularBounds(country);
        if (Array.isArray(bounds)) {
            // Handle multiple bounds (like USA/Alaska)
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
    
    
    // Initialize spatial grid
    initializeSpatialGrid();
    
    // Generate enhanced colors
    countryColors = generateCountryColors(world.features);
    
    console.timeEnd('preprocessing');
    
    updateMap();

    document.getElementById("updateButton").addEventListener("click", updateMap);
    document.getElementById("showDebug").addEventListener("change", updateDebugInfo);
    
    window.addEventListener('resize', () => {
        updateMap();
    });
});