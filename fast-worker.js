importScripts(
    "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js",
    "https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js",
    "https://cdn.jsdelivr.net/npm/d3-geo-projection@4"
);

let world;
let featureColors = []; // Precomputed fill color string per feature index

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
        }
    } catch (err) {
        console.error("Worker error:", err);
        self.postMessage({ type: 'error', error: err.message });
    }
};

function initializeWorld(topology) {
    // Use the raw spherical features unmodified. d3.geoPath (used both here for
    // rasterization and on the main thread for the borders) handles antimeridian
    // cutting and polar regions correctly, so mangling longitudes here would only
    // desync the dots from the rendered borders.
    world = topojson.feature(topology, topology.objects.countries);

    // Precompute a unique fill color per feature. The country index (i + 1) is
    // encoded into the R and G channels; 0/transparent means ocean.
    featureColors = world.features.map((_, i) => {
        const idx = i + 1;
        const r = idx & 0xff;
        const g = (idx >> 8) & 0xff;
        return `rgb(${r},${g},0)`;
    });

    self.postMessage({ type: 'features', features: world.features });
}

// --- Rasterization-based country lookup ---
//
// Instead of testing every dot against every candidate polygon with
// d3.geoContains (slow, and only as accurate as the bounding-circle
// approximations), we render the projected countries to an offscreen canvas
// using the SAME projection that draws the borders, giving each country a
// unique color. A dot's country is then whatever color sits under its pixel.
// This is O(1) per dot and pixel-perfect with the rendered borders.
function rasterizeCountries(projection, offsetX, rasterWidth, rasterHeight) {
    const canvas = new OffscreenCanvas(rasterWidth, rasterHeight);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // Shift the world so this chunk's column range maps to [0, rasterWidth).
    ctx.translate(-offsetX, 0);

    const path = d3.geoPath(projection, ctx);

    for (let i = 0; i < world.features.length; i++) {
        ctx.beginPath();
        path(world.features[i]);
        ctx.fillStyle = featureColors[i];
        ctx.fill();
    }

    return ctx.getImageData(0, 0, rasterWidth, rasterHeight);
}

// Process a chunk of the grid spanning x in [startX, endX).
function processChunk(params, chunkId) {
    const { width, height, projectionName, spacing, showOceanDots, startX, endX } = params;

    const projection = setupProjection(projectionName, width, height);

    const rasterWidth = endX - startX;
    const image = rasterizeCountries(projection, startX, rasterWidth, height);
    const data = image.data;

    const results = [];

    for (let x = startX; x < endX; x += spacing) {
        const col = x - startX;
        for (let y = 0; y < height; y += spacing) {
            const point = [x, y];

            // invert serves double duty: it clips points outside the projected
            // sphere (corners of an orthographic, gaps in interrupted maps) and
            // provides the lat/lon shown in the hover tooltip.
            const coords = projection.invert(point);
            if (!isValidCoordinate(coords)) continue;

            const country = lookupCountry(data, col, y, rasterWidth);
            if (!country && !showOceanDots) continue;

            results.push({
                x,
                y,
                countryName: country ? country.properties.name : null,
                coords
            });
        }
    }

    return results;
}

// Single-worker fallback that rasterizes the whole map at once.
function calculateDots({ width, height, projectionName, spacing, showOceanDots }) {
    return {
        dots: processChunk(
            { width, height, projectionName, spacing, showOceanDots, startX: 0, endX: width },
            0
        ),
        debugInfo: { totalChecks: 0 }
    };
}

// --- Helper Functions ---

// Decode the country sitting under raster pixel (col, y). Only fully-covered,
// opaque interior pixels are accepted, so antialiased border/coast pixels fall
// through to ocean rather than being mis-assigned to the wrong country.
function lookupCountry(data, col, y, rasterWidth) {
    const i = (y * rasterWidth + col) * 4;
    if (data[i + 3] < 255) return null; // antialiased edge or ocean
    const idx = data[i] + (data[i + 1] << 8);
    if (idx <= 0 || idx > world.features.length) return null;
    return world.features[idx - 1];
}

function isValidCoordinate(coordinates) {
    if (!coordinates) return false;
    const [lon, lat] = coordinates;
    return !isNaN(lon) && !isNaN(lat) &&
        Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
}

function setupProjection(projectionName, width, height) {
    // Fall back gracefully if a projection name isn't available, rather than
    // throwing (must mirror setupProjection in index.js).
    const factory = typeof d3[projectionName] === "function" ? d3[projectionName] : d3.geoEquirectangular;
    const projection = factory();

    // Configure projection parameters BEFORE fitSize so the fit (scale +
    // translate) is computed for the final center/parallels/clip.
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

    projection.fitSize([width, height], { type: "Sphere" });

    return projection;
}
