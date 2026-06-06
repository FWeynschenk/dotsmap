
function getRenderDimensions() {
    // Fixed rendering dimensions for deterministic output
    // These are independent of viewport size
    const renderWidth = parseInt(document.getElementById("renderWidth").value) || 1920;
    const renderHeight = parseInt(document.getElementById("renderHeight").value) || 1080;
    
    return { width: renderWidth, height: renderHeight };
}

function getDisplayDimensions() {
    // Get actual display size for viewport scaling
    const container = document.querySelector('.map-wrapper');
    if (!container) return { width: 800, height: 600 };
    
    const width = container.clientWidth - 40;
    const height = container.clientHeight - 40;
    
    return { width, height };
}

let world = { features: [] }; // Initialize with empty features
let countryNeighbors = [];    // adjacency by feature index (from topojson)
let currentProjection;
let path;
let countryColors = new Map();
let debugInfo = { totalChecks: 0, circleChecks: 0, fullChecks: 0, gridChecks: 0 };

// Enhanced Worker Pool and Cache
let workerPool = null;
let isCalculating = false;
let pendingUpdate = false; // a settings change arrived mid-calculation
let updateTimer = null;    // debounce handle for auto-update

// Settings now drive the map directly (no manual "Update" button). Debounce so
// dragging a number field or color picker coalesces into a single render.
function scheduleUpdate() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => updateMap(), 120);
}

// Single place to drive the status pill that used to live on the button.
function setStatus(text, isError = false) {
    const el = document.getElementById("progressIndicator");
    if (!el) return;
    if (!text) {
        el.style.display = "none";
        el.style.backgroundColor = "";
        return;
    }
    el.style.display = "block";
    el.textContent = text;
    el.style.backgroundColor = isError ? "#ffebee" : "";
}

// Lightweight in-memory cache so repeat clicks with identical settings are
// instant. No persistence — recomputing is cheap, and a fresh worker session
// can never serve stale results from an older algorithm.
const dotCache = new Map();
const DOT_CACHE_LIMIT = 10;

function dotCacheKey({ projectionName, width, height, spacing, packing, showLandDots, showOceanDots, region }) {
    return `${projectionName}-${width}-${height}-${spacing}-${packing || "square"}-${showLandDots}-${showOceanDots}-${region || "world"}`;
}


const colorScales = [
    d3.interpolateRainbow,
    d3.interpolateWarm,
    d3.interpolateCool,
    d3.interpolatePlasma
];

// Small, fast seeded PRNG. Same seed -> same color assignment, so the rainbow
// scheme is deterministic while the seed still lets the user explore variations.
function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function generateCountryColors(countries) {
    const scheme = document.getElementById("colorScheme").value;
    const baseColor = document.getElementById("baseColor").value;
    const seedInput = document.getElementById("rainbowSeed");
    const seed = seedInput ? (parseInt(seedInput.value) || 0) : 0;
    return generateColorScheme(countries, scheme, baseColor, seed);
}

function generateColorScheme(countries, schemeName, baseColor, seed = 0) {
    const colors = new Map();
    const rand = mulberry32(seed);

    switch (schemeName) {
        case 'rainbow':
            // Generate all colors first
            const rainbowColors = [];
            for (let i = 0; i < countries.length; i++) {
                const scaleIndex = Math.floor(i / (countries.length / colorScales.length));
                const scale = colorScales[scaleIndex];
                const basePosition = (i % (countries.length / colorScales.length)) / (countries.length / colorScales.length);
                const variation = (rand() - 0.5) * 0.1;
                rainbowColors.push(scale(basePosition + variation));
            }

            // Shuffle the colors array using Fisher-Yates algorithm
            for (let i = rainbowColors.length - 1; i > 0; i--) {
                const j = Math.floor(rand() * (i + 1));
                [rainbowColors[i], rainbowColors[j]] = [rainbowColors[j], rainbowColors[i]];
            }

            // Assign shuffled colors to countries
            countries.forEach((country, i) => {
                colors.set(country.properties.name, rainbowColors[i]);
            });
            break;

        case 'greyscale':
            countries.forEach((country, i) => {
                const value = 0.2 + (0.6 * i / countries.length);
                const variation = (rand() - 0.5) * 0.1;
                const adjustedValue = Math.max(0.1, Math.min(0.9, value + variation));
                colors.set(country.properties.name, `rgb(${Math.floor(adjustedValue * 255)},${Math.floor(adjustedValue * 255)},${Math.floor(adjustedValue * 255)})`);
            });
            break;
            
        case 'monotone':
            const hex = baseColor.replace('#', '');
            const r = parseInt(hex.substring(0, 2), 16);
            const g = parseInt(hex.substring(2, 4), 16);
            const b = parseInt(hex.substring(4, 6), 16);
            
            countries.forEach((country) => {
                colors.set(country.properties.name, 
                    `rgb(${Math.floor(r)},${Math.floor(g)},${Math.floor(b)})`
                );
            });
            break;
    }
    
    return colors;
}

function getProjectionOutline() {
    return { type: "Sphere" };
}

function setupProjection(projectionName, width, height, fitGeometry) {
    // Fall back gracefully if a projection name isn't available in this build of
    // d3 / d3-geo-projection, rather than throwing.
    const factory = typeof d3[projectionName] === "function" ? d3[projectionName] : d3.geoEquirectangular;
    if (factory === d3.geoEquirectangular && projectionName !== "geoEquirectangular") {
        console.warn(`Projection "${projectionName}" unavailable; using Equirectangular.`);
    }
    currentProjection = factory();

    // Configure projection parameters BEFORE fitSize so the fit (scale +
    // translate) is computed for the final center/parallels/clip. This must
    // stay in sync with setupProjection in fast-worker.js so the dots line up
    // exactly with the borders.
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

    // Fit to the cropped region (with padding) when one is selected, otherwise
    // to the whole sphere. Must mirror setupProjection in fast-worker.js so the
    // dots stay aligned with the borders.
    const geom = fitGeometry || { type: "Sphere" };
    const pad = fitGeometry ? Math.min(width, height) * 0.04 : 0;
    currentProjection.fitExtent([[pad, pad], [width - pad, height - pad]], geom);

    return currentProjection;
}


// ---------- Region cropping ----------

// Returns null for the whole world, otherwise { features, indices, key } for the
// currently selected crop region.
function getRegionSelection() {
    const typeEl = document.getElementById("regionType");
    if (!typeEl) return null;
    const type = typeEl.value;
    if (type === "world") return null;

    const choice = document.getElementById("regionChoice").value;
    if (!choice) return null;

    let indices = [];
    if (type === "hemisphere") {
        world.features.forEach((f, i) => { if (inHemisphere(f, choice)) indices.push(i); });
    } else if (type === "country") {
        world.features.forEach((f, i) => { if (f.properties.name === choice) indices.push(i); });
    } else if (type === "countryNeighbours") {
        indices = countryWithNeighbours(choice);
    } else if (type === "continent") {
        world.features.forEach((f, i) => { if (continentOf(f) === choice) indices.push(i); });
    } else if (type === "bloc") {
        const members = blocMembers(choice);
        world.features.forEach((f, i) => { if (members.has(f.properties.name)) indices.push(i); });
    }

    if (indices.length === 0) return null;
    return { features: indices.map(i => world.features[i]), indices, key: `${type}:${choice}` };
}

function inHemisphere(feature, hemisphere) {
    const c = d3.geoCentroid(feature); // [lon, lat]
    switch (hemisphere) {
        case "Northern": return c[1] >= 0;
        case "Southern": return c[1] < 0;
        case "Eastern":  return c[0] >= 0;
        case "Western":  return c[0] < 0;
        default: return false;
    }
}

function countryWithNeighbours(name) {
    const idx = world.features.findIndex(f => f.properties.name === name);
    if (idx < 0) return [];
    const set = new Set([idx]);
    (countryNeighbors[idx] || []).forEach(n => set.add(n));
    return [...set];
}

function countryNames() {
    return world.features
        .map(f => f.properties.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

// Rebuild the secondary "Selection" dropdown to match the chosen crop type.
function populateRegionChoices() {
    const type = document.getElementById("regionType").value;
    const wrap = document.getElementById("regionChoiceWrap");
    const choice = document.getElementById("regionChoice");

    let options = [];
    if (type === "hemisphere") {
        options = ["Northern", "Southern", "Eastern", "Western"];
    } else if (type === "country" || type === "countryNeighbours") {
        options = countryNames();
    } else if (type === "continent") {
        options = (typeof CONTINENTS !== "undefined") ? CONTINENTS : [];
    } else if (type === "bloc") {
        options = (typeof BLOCS !== "undefined") ? BLOCS : [];
    }

    if (options.length === 0) {
        wrap.style.display = "none";
        choice.innerHTML = "";
        return;
    }

    wrap.style.display = "flex";
    choice.innerHTML = "";
    for (const o of options) {
        const op = document.createElement("option");
        op.value = o;
        op.textContent = o;
        choice.appendChild(op);
    }
}


const OCEAN_DOT_COLOR = "#99ccff";

// Last-rendered dots + the style they were drawn with, kept so the SVG export
// can rebuild them as true vectors even though the live view draws them to a
// canvas for speed.
let lastDotsData = null;
let lastDotStyle = null;

// Vertices of a non-circular dot shape of "radius" r centered at (x, y).
function shapeVertices(shape, x, y, r) {
    switch (shape) {
        case "square":
            return [[x - r, y - r], [x + r, y - r], [x + r, y + r], [x - r, y + r]];
        case "diamond":
            return [[x, y - r], [x + r, y], [x, y + r], [x - r, y]];
        case "triangle": {
            const h = r * 0.8660254; // √3/2
            return [[x, y - r], [x + h, y + r / 2], [x - h, y + r / 2]];
        }
        case "hexagon": {
            const v = [];
            for (let i = 0; i < 6; i++) {
                const a = Math.PI / 3 * i; // flat-top hexagon
                v.push([x + r * Math.cos(a), y + r * Math.sin(a)]);
            }
            return v;
        }
        default:
            return null; // circle
    }
}

// Add one dot's outline to a canvas path.
function addShapePath(ctx, shape, x, y, r) {
    const v = shapeVertices(shape, x, y, r);
    if (v) {
        ctx.moveTo(v[0][0], v[0][1]);
        for (let i = 1; i < v.length; i++) ctx.lineTo(v[i][0], v[i][1]);
        ctx.closePath();
        return;
    }
    // Circle: moveTo first so consecutive arcs aren't joined by a line.
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
}

// SVG path data for one dot's shape.
function shapePathD(shape, x, y, r) {
    const v = shapeVertices(shape, x, y, r);
    if (v) {
        return "M" + v.map(p => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join("L") + "Z";
    }
    return `M${x - r},${y}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`;
}

// Partition dots into land (grouped by country color) and ocean.
function partitionDots(dotsData) {
    const landByColor = new Map();
    const oceanDots = [];
    for (const d of dotsData) {
        if (d.countryName) {
            const color = countryColors.get(d.countryName) || OCEAN_DOT_COLOR;
            let arr = landByColor.get(color);
            if (!arr) { arr = []; landByColor.set(color, arr); }
            arr.push(d);
        } else {
            oceanDots.push(d);
        }
    }
    return { landByColor, oceanDots };
}

function drawDots(dotsData, style) {
    const { landShape, landSize, oceanShape, oceanSize, oceanColor, enableHover } = style;

    const svg = d3.select("#map");
    const mainGroup = svg.select("g"); // Assume main group exists

    // Remove existing dots and detach any previous delegated hover handlers.
    mainGroup.select(".dots-group").remove();
    svg.on("mousemove.dots", null).on("mouseleave.dots", null);

    if (!dotsData || dotsData.length === 0) {
        lastDotsData = null;
        return;
    }

    lastDotsData = dotsData;
    lastDotStyle = style;

    const dotsGroup = mainGroup.append("g").attr("class", "dots-group");

    // Performance: rasterize all dots to a canvas at render resolution and embed
    // the result as a SINGLE <image>. The browser then paints one image no matter
    // how many dots there are, which is what makes massive dot counts smooth.
    // (Hit-testing/hover is handled separately via the quadtree below.)
    const { width, height } = getRenderDimensions();

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");

    const { landByColor, oceanDots } = partitionDots(dotsData);

    // Land: one fillStyle + fill() per country color. Ocean: a single fill.
    landByColor.forEach((dots, color) => {
        ctx.beginPath();
        for (const d of dots) addShapePath(ctx, landShape, d.x, d.y, landSize);
        ctx.fillStyle = color;
        ctx.fill();
    });
    if (oceanDots.length) {
        ctx.beginPath();
        for (const d of oceanDots) addShapePath(ctx, oceanShape, d.x, d.y, oceanSize);
        ctx.fillStyle = oceanColor;
        ctx.fill();
    }

    // Data URL (not a blob URL) so the embedded raster travels with the SVG when
    // it's serialized for download.
    const dataUrl = canvas.toDataURL("image/png");

    dotsGroup.append("image")
        .attr("href", dataUrl)
        .attr("xlink:href", dataUrl) // compatibility for SVG-as-<img> PNG export
        .attr("x", 0)
        .attr("y", 0)
        .attr("width", width)
        .attr("height", height)
        .attr("preserveAspectRatio", "none")
        .attr("opacity", 0.8)
        .attr("pointer-events", "none");

    if (enableHover) {
        setupDotHover(svg, dotsGroup, dotsData, landSize, oceanSize);
    }
}

// A single delegated mousemove handler + quadtree replaces per-dot listeners.
function setupDotHover(svg, dotsGroup, dotsData, landSize, oceanSize) {
    let tooltip = d3.select("body").select(".dot-tooltip");
    if (tooltip.empty()) {
        tooltip = d3.select("body").append("div")
            .attr("class", "dot-tooltip")
            .style("position", "absolute")
            .style("visibility", "hidden")
            .style("pointer-events", "none")
            .style("z-index", "1000");
    }

    const quadtree = d3.quadtree()
        .x(d => d.x)
        .y(d => d.y)
        .addAll(dotsData);

    // Highlight ring that follows the hovered dot (one element, repositioned).
    const highlight = dotsGroup.append("circle")
        .attr("fill", "none")
        .attr("stroke", "#000")
        .attr("stroke-width", 1)
        .style("visibility", "hidden")
        .style("pointer-events", "none");

    const searchRadius = Math.max(landSize, oceanSize, 4) * 2;

    svg.on("mousemove.dots", function(event) {
        // d3.pointer maps the screen event into the SVG's viewBox coordinate
        // system (accounting for preserveAspectRatio scaling), which is the
        // space the dots live in.
        const [mx, my] = d3.pointer(event, dotsGroup.node());
        const found = quadtree.find(mx, my, searchRadius);

        if (!found) {
            tooltip.style("visibility", "hidden");
            highlight.style("visibility", "hidden");
            return;
        }

        const countryName = found.countryName || "Ocean";
        const coords = found.coords;
        const coordText = coords
            ? `<br>Lat: ${coords[1].toFixed(2)}°<br>Lon: ${coords[0].toFixed(2)}°`
            : "";

        tooltip
            .style("visibility", "visible")
            .style("top", (event.pageY + 10) + "px")
            .style("left", (event.pageX + 10) + "px")
            .html(`Location: ${countryName}${coordText}`);

        highlight
            .attr("cx", found.x)
            .attr("cy", found.y)
            .attr("r", (found.countryName ? landSize : oceanSize) + 1)
            .style("visibility", "visible");
    });

    svg.on("mouseleave.dots", function() {
        tooltip.style("visibility", "hidden");
        highlight.style("visibility", "hidden");
    });
}

function updateMap() {
    if (world.features.length === 0) return; // Not ready yet

    // Use fixed rendering dimensions for deterministic output
    const { width, height } = getRenderDimensions();
    const displayDims = getDisplayDimensions();
    
    const projectionName = document.getElementById("projection").value;
    const spacing = parseInt(document.getElementById("spacing").value);
    const packing = document.getElementById("packing").value;
    const dotSize = parseInt(document.getElementById("dotSize").value);
    const landDotShape = document.getElementById("landDotShape").value;
    const oceanDotShape = document.getElementById("oceanDotShape").value;
    const oceanDotSize = parseInt(document.getElementById("oceanDotSize").value);
    const oceanDotColor = document.getElementById("oceanDotColor").value;
    const showCountries = document.getElementById("showCountries").checked;
    const showOutline = document.getElementById("showOutline").checked;
    const showOcean = document.getElementById("showOcean").checked;
    const showDots = document.getElementById("showDots").checked;
    const showGraticules = document.getElementById("showGraticules").checked;
    const showOceanDots = document.getElementById("showOceanDots").checked;
    const enableHover = document.getElementById("enableHover").checked;

    // Determine the active crop region (null = whole world). Borders, dots and
    // the projection fit are all derived from the same selection so they align.
    const selection = getRegionSelection();
    const fitGeometry = selection ? { type: "FeatureCollection", features: selection.features } : null;
    const featuresToDraw = selection ? selection.features : world.features;
    const regionKey = selection ? selection.key : "world";

    // Generate colors
    countryColors = generateCountryColors(world.features);

    const svg = d3.select("#map")
        .attr("width", displayDims.width)
        .attr("height", displayDims.height)
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

    svg.selectAll("*").remove();

    currentProjection = setupProjection(projectionName, width, height, fitGeometry);
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
            .datum(d3.geoGraticule())
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
            .data(featuresToDraw)
            .enter()
            .append("path")
            .attr("d", path)
            .attr("fill", "#e0e0e0")
            .attr("stroke", "#999")
            .attr("stroke-width", 0.5);
    }

    if (showOutline) {
        svg.append("path")
            .datum(outline)
            .attr("d", path)
            .attr("fill", "none")
            .attr("stroke", "#000")
            .attr("stroke-width", 1);
    }

    if (showDots || showOceanDots) {
        calculateDotsOptimized({
            width,
            height,
            projectionName,
            spacing,
            packing,
            showLandDots: showDots,
            showOceanDots,
            dotSize,
            landDotShape,
            oceanDotShape,
            oceanDotSize,
            oceanDotColor,
            enableHover,
            selectedIndices: selection ? selection.indices : null,
            region: regionKey
        });
    } else {
        // No dots on screen — make sure the SVG export doesn't emit a stale layer.
        lastDotsData = null;
    }
}

async function calculateDotsOptimized(params) {
    if (isCalculating) {
        // A newer set of settings arrived while we were busy; re-run once done
        // so the rendered dots always reflect the latest controls.
        pendingUpdate = true;
        return;
    }

    const style = {
        landShape: params.landDotShape,
        landSize: params.dotSize,
        oceanShape: params.oceanDotShape,
        oceanSize: params.oceanDotSize,
        oceanColor: params.oceanDotColor,
        enableHover: params.enableHover
    };

    // Check cache first
    const cached = dotCache.get(dotCacheKey(params));
    if (cached) {
        debugInfo = cached.debugInfo;
        drawDots(cached.dots, style);
        showPerformanceInfo("Instant (cached)", cached.dots.length);
        return;
    }

    // Not in cache, calculate using worker pool
    isCalculating = true;
    setStatus("Rendering map…");

    try {
        const startTime = performance.now();

        // Use parallel workers
        const result = await workerPool.calculateDotsParallel(params, (progress) => {
            setStatus(`Rendering map… ${progress}%`);
        });

        const endTime = performance.now();
        const calculationTime = (endTime - startTime).toFixed(0);
        console.log(`[OK] Calculation took ${calculationTime}ms using ${result.debugInfo.parallelWorkers || 'multiple'} workers`);

        debugInfo = result.debugInfo;

        // Cache the result (simple LRU: drop the oldest entry past the limit)
        dotCache.set(dotCacheKey(params), result);
        if (dotCache.size > DOT_CACHE_LIMIT) {
            dotCache.delete(dotCache.keys().next().value);
        }

        // Draw
        drawDots(result.dots, style);
        showPerformanceInfo(`${calculationTime}ms (${result.debugInfo.parallelWorkers || 'multi'} workers)`, result.dots.length);

        setStatus(null);
    } catch (error) {
        console.error("Calculation error:", error);
        setStatus("Error during render", true);
    } finally {
        isCalculating = false;
        if (pendingUpdate) {
            pendingUpdate = false;
            updateMap();
        }
    }
}

function showPerformanceInfo(time, dotCount) {
    const perfInfo = document.getElementById("performanceInfo");
    if (perfInfo) {
        perfInfo.innerHTML = `
            Performance<br>
            Time: ${time}<br>
            Dots: ${dotCount.toLocaleString()}<br>
            Workers: ${workerPool ? workerPool.numWorkers : 'N/A'}
        `;
        perfInfo.style.display = "block";
        
        // Auto-hide after 5 seconds
        setTimeout(() => {
            perfInfo.style.display = "none";
        }, 5000);
    }
}

async function loadPrerenderedSVG() {
    try {
        const response = await fetch('map-1763722299540.svg');
        const svgText = await response.text();
        
        // Parse the SVG
        const parser = new DOMParser();
        const svgDoc = parser.parseFromString(svgText, 'image/svg+xml');
        const loadedSvg = svgDoc.documentElement;
        
        // Get the target SVG element
        const targetSvg = document.getElementById('map');
        
        // Copy attributes
        const displayDims = getDisplayDimensions();
        targetSvg.setAttribute('width', displayDims.width);
        targetSvg.setAttribute('height', displayDims.height);
        targetSvg.setAttribute('viewBox', loadedSvg.getAttribute('viewBox'));
        targetSvg.setAttribute('preserveAspectRatio', loadedSvg.getAttribute('preserveAspectRatio'));
        
        // Copy all child elements
        while (loadedSvg.firstChild) {
            targetSvg.appendChild(loadedSvg.firstChild);
        }
        
        console.log('Prerendered SVG loaded successfully');
    } catch (error) {
        console.warn('Failed to load prerendered SVG:', error);
    }
}

// Show/hide the scheme-specific controls (base color for monotone, seed for
// rainbow) based on the active color scheme.
function updateColorControlsVisibility() {
    const scheme = document.getElementById("colorScheme").value;
    const monotone = document.getElementById("monotoneControls");
    const rainbow = document.getElementById("rainbowControls");
    if (monotone) monotone.style.display = scheme === "monotone" ? "flex" : "none";
    if (rainbow) rainbow.style.display = scheme === "rainbow" ? "flex" : "none";
}

// Show the ocean-dot styling block only when ocean dots are enabled.
function updateDotControlsVisibility() {
    const on = document.getElementById("showOceanDots").checked;
    const block = document.getElementById("oceanDotStyle");
    if (block) block.style.display = on ? "" : "none";
}

// Wire every setting so changing it re-renders automatically.
function setupAutoUpdate() {
    // Numbers/colors fire on commit (blur/enter/picker close) rather than per
    // keystroke; selects and checkboxes fire on change.
    const autoUpdateIds = [
        "projection", "renderWidth", "renderHeight", "spacing", "packing", "dotSize",
        "landDotShape", "oceanDotShape", "oceanDotSize", "oceanDotColor",
        "baseColor", "rainbowSeed", "showDots", "showOceanDots", "showCountries",
        "showOcean", "showOutline", "showGraticules", "enableHover"
    ];
    autoUpdateIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("change", scheduleUpdate);
    });

    const oceanDotsToggle = document.getElementById("showOceanDots");
    if (oceanDotsToggle) {
        oceanDotsToggle.addEventListener("change", updateDotControlsVisibility);
    }

    const colorScheme = document.getElementById("colorScheme");
    if (colorScheme) {
        colorScheme.addEventListener("change", function() {
            updateColorControlsVisibility();
            scheduleUpdate();
        });
    }

    const regionType = document.getElementById("regionType");
    if (regionType) {
        regionType.addEventListener("change", function() {
            populateRegionChoices();
            scheduleUpdate();
        });
    }
    const regionChoice = document.getElementById("regionChoice");
    if (regionChoice) {
        regionChoice.addEventListener("change", scheduleUpdate);
    }

    const randomizeSeed = document.getElementById("randomizeSeed");
    if (randomizeSeed) {
        randomizeSeed.addEventListener("click", function() {
            document.getElementById("rainbowSeed").value = Math.floor(Math.random() * 100000);
            scheduleUpdate();
        });
    }
}

async function initializeApplication() {
    try {
        setStatus("Loading…");

        // Load prerendered SVG for initial display
        await loadPrerenderedSVG();

        // Load world data
        const topology = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");

        // Initialize worker pool
        const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
        workerPool = new WorkerPool(numWorkers);

        // Initialize workers with world data
        const initData = await workerPool.init(topology);
        world.features = initData.features;
        countryNeighbors = initData.neighbors || [];
        console.log("Workers initialized with world data");

        // Populate region crop choices now that we have the country list
        populateRegionChoices();

        // Settings now drive the map automatically
        updateColorControlsVisibility();
        updateDotControlsVisibility();
        setupAutoUpdate();

        // Add download SVG button
        const downloadSvgButton = document.getElementById("downloadSvg");
        if (downloadSvgButton) {
            downloadSvgButton.addEventListener("click", function() {
                downloadAsSVG();
            });
        }

        // Add download PNG button
        const downloadPngButton = document.getElementById("downloadPng");
        if (downloadPngButton) {
            downloadPngButton.addEventListener("click", function() {
                downloadAsPNG();
            });
        }

        console.log("Application initialized successfully");

        // Render once now that everything is ready, replacing the prerendered SVG.
        updateMap();
    } catch (error) {
        console.error("Failed to initialize application:", error);
        setStatus("Error — reload page", true);
    }
}

// Replace the rasterized dots <image> inside a cloned SVG with vector <path>
// elements (one per color), so the exported SVG has real scalable dots.
function replaceRasterDotsWithVectors(svgClone) {
    const dotsGroup = svgClone.querySelector('.dots-group');
    if (!dotsGroup || !lastDotsData || lastDotsData.length === 0 || !lastDotStyle) return;

    // Drop the raster image (and any leftover hover highlight).
    while (dotsGroup.firstChild) dotsGroup.removeChild(dotsGroup.firstChild);

    // One group-level opacity matches the live image's 0.8 (and avoids
    // double-blending where dots of different colors overlap).
    dotsGroup.setAttribute('opacity', '0.8');

    const { landShape, landSize, oceanShape, oceanSize, oceanColor } = lastDotStyle;
    const svgNS = 'http://www.w3.org/2000/svg';

    // Land: one <path> per country color, in its shape/size. Ocean: one path.
    const { landByColor, oceanDots } = partitionDots(lastDotsData);

    const addPath = (segs, color) => {
        const path = document.createElementNS(svgNS, 'path');
        path.setAttribute('d', segs.join(''));
        path.setAttribute('fill', color);
        dotsGroup.appendChild(path);
    };

    landByColor.forEach((dots, color) => {
        addPath(dots.map(d => shapePathD(landShape, d.x, d.y, landSize)), color);
    });
    if (oceanDots.length) {
        addPath(oceanDots.map(d => shapePathD(oceanShape, d.x, d.y, oceanSize)), oceanColor);
    }
}

function downloadAsSVG() {
    const svg = document.getElementById('map');
    if (!svg) {
        alert("No map to download!");
        return;
    }
    
    // Clone the SVG to avoid modifying the display
    const svgClone = svg.cloneNode(true);

    // Use render dimensions for the download
    const { width, height } = getRenderDimensions();
    svgClone.setAttribute('width', width);
    svgClone.setAttribute('height', height);
    svgClone.setAttribute('viewBox', `0 0 ${width} ${height}`);

    // The live view draws dots to a raster <image> for speed; for the SVG export
    // we swap that out for true vector dots so the download is fully scalable.
    replaceRasterDotsWithVectors(svgClone);

    // Serialize the SVG
    const serializer = new XMLSerializer();
    const svgString = serializer.serializeToString(svgClone);
    
    // Create blob and download
    const blob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    const link = document.createElement('a');
    link.href = url;
    link.download = `map-${Date.now()}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
}

async function downloadAsPNG() {
    const svg = document.getElementById('map');
    if (!svg) {
        alert("No map to download!");
        return;
    }
    
    try {
        // Clone and prepare SVG
        const svgClone = svg.cloneNode(true);
        const { width, height } = getRenderDimensions();
        svgClone.setAttribute('width', width);
        svgClone.setAttribute('height', height);
        svgClone.setAttribute('viewBox', `0 0 ${width} ${height}`);
        
        // Serialize SVG
        const serializer = new XMLSerializer();
        const svgString = serializer.serializeToString(svgClone);
        
        // Create data URL
        const dataHeader = 'data:image/svg+xml;charset=utf-8';
        const svgData = `${dataHeader},${encodeURIComponent(svgString)}`;
        
        // Load as image
        const img = await loadImage(svgData);
        
        // Create canvas and draw image
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        
        // Convert to PNG and download
        canvas.toBlob((blob) => {
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `map-${Date.now()}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
        }, 'image/png', 1.0);
        
    } catch (error) {
        console.error("Failed to download PNG:", error);
        alert("Failed to download PNG. Please try SVG format instead.");
    }
}

function loadImage(url) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
    });
}

// Start initialization - wait for DOM to be fully loaded
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApplication);
} else {
    // DOM is already loaded
    initializeApplication();
}
