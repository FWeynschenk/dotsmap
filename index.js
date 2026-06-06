
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

function dotCacheKey({ projectionName, width, height, spacing, showOceanDots }) {
    return `${projectionName}-${width}-${height}-${spacing}-${showOceanDots}`;
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

function setupProjection(projectionName, width, height) {
    currentProjection = d3[projectionName]();

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

    currentProjection.fitSize([width, height], { type: "Sphere" });

    return currentProjection;
}


function drawDots(dotsData, dotSize, enableHover, showOceanDots) {
    const svg = d3.select("#map");
    const mainGroup = svg.select("g"); // Assume main group exists
    
    // Remove existing dots
    mainGroup.select(".dots-group").remove();

    if (!dotsData || dotsData.length === 0) return;

    const dotsGroup = mainGroup.append("g").attr("class", "dots-group");
    
    // Create tooltip if not exists
    let tooltip = d3.select("body").select(".dot-tooltip");
    if (tooltip.empty()) {
        tooltip = d3.select("body").append("div")
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
    }

    dotsGroup.selectAll("circle")
        .data(dotsData)
        .join("circle")
        .attr("cx", d => d.x)
        .attr("cy", d => d.y)
        .attr("r", dotSize)
        .attr("fill", d => d.countryName ? (countryColors.get(d.countryName) || "#99ccff") : "#99ccff")
        .attr("opacity", 0.8);

    if (enableHover) {
        dotsGroup.selectAll("circle")
            .on("mouseover", function(event, d) {
                if (!d.coords) return;
                
                const [lon, lat] = d.coords;
                const countryName = d.countryName || "Ocean";
                
                tooltip
                    .style("visibility", "visible")
                    .html(`
                        Location: ${countryName}<br>
                        Lat: ${lat.toFixed(2)}°<br>
                        Lon: ${lon.toFixed(2)}°
                    `);
                
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
                d3.select(this)
                    .attr("stroke", null)
                    .attr("stroke-width", null)
                    .attr("opacity", 0.8);
            });
    }
}

function updateMap() {
    if (world.features.length === 0) return; // Not ready yet

    // Use fixed rendering dimensions for deterministic output
    const { width, height } = getRenderDimensions();
    const displayDims = getDisplayDimensions();
    
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

    // Generate colors
    countryColors = generateCountryColors(world.features);

    const svg = d3.select("#map")
        .attr("width", displayDims.width)
        .attr("height", displayDims.height)
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("preserveAspectRatio", "xMidYMid meet");

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
            .data(world.features)
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

    if (showDots) {
        calculateDotsOptimized({
            width,
            height,
            projectionName,
            spacing,
            showOceanDots,
            dotSize,
            enableHover
        });
    }
}

async function calculateDotsOptimized(params) {
    if (isCalculating) {
        // A newer set of settings arrived while we were busy; re-run once done
        // so the rendered dots always reflect the latest controls.
        pendingUpdate = true;
        return;
    }

    const { width, height, projectionName, spacing, showOceanDots, dotSize, enableHover } = params;

    // Check cache first
    const cached = dotCache.get(dotCacheKey(params));
    if (cached) {
        debugInfo = cached.debugInfo;
        drawDots(cached.dots, dotSize, enableHover, showOceanDots);
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
        drawDots(result.dots, dotSize, enableHover, showOceanDots);
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

// Wire every setting so changing it re-renders automatically.
function setupAutoUpdate() {
    // Numbers/colors fire on commit (blur/enter/picker close) rather than per
    // keystroke; selects and checkboxes fire on change.
    const autoUpdateIds = [
        "projection", "renderWidth", "renderHeight", "spacing", "dotSize",
        "baseColor", "rainbowSeed", "showDots", "showOceanDots", "showCountries",
        "showOcean", "showOutline", "showGraticules", "enableHover"
    ];
    autoUpdateIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener("change", scheduleUpdate);
    });

    const colorScheme = document.getElementById("colorScheme");
    if (colorScheme) {
        colorScheme.addEventListener("change", function() {
            updateColorControlsVisibility();
            scheduleUpdate();
        });
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
        world.features = await workerPool.init(topology);
        console.log("Workers initialized with world data");

        // Settings now drive the map automatically
        updateColorControlsVisibility();
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
