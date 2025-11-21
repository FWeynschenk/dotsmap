
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
let cacheManager = null;
let isCalculating = false;
let lookupMapBuilt = false;


const colorScales = [
    d3.interpolateRainbow,
    d3.interpolateWarm,
    d3.interpolateCool,
    d3.interpolatePlasma
];

function generateCountryColors(countries) {
    const scheme = document.getElementById("colorScheme").value;
    const baseColor = document.getElementById("baseColor").value;
    return generateColorScheme(countries, scheme, baseColor);
}

function generateColorScheme(countries, schemeName, baseColor) {
    const colors = new Map();
    
    switch (schemeName) {
        case 'rainbow':
            // Generate all colors first
            const rainbowColors = [];
            for (let i = 0; i < countries.length; i++) {
                const scaleIndex = Math.floor(i / (countries.length / colorScales.length));
                const scale = colorScales[scaleIndex];
                const basePosition = (i % (countries.length / colorScales.length)) / (countries.length / colorScales.length);
                const variation = (Math.random() - 0.5) * 0.1;
                rainbowColors.push(scale(basePosition + variation));
            }
            
            // Shuffle the colors array using Fisher-Yates algorithm
            for (let i = rainbowColors.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
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
                const variation = (Math.random() - 0.5) * 0.1;
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
        console.log("Already calculating, skipping...");
        return;
    }
    
    const { width, height, projectionName, spacing, showOceanDots, dotSize, enableHover } = params;
    
    // Check cache first
    const cached = cacheManager.get(params);
    if (cached) {
        debugInfo = cached.debugInfo;
        drawDots(cached.dots, dotSize, enableHover, showOceanDots);
        showPerformanceInfo("Instant (cached)", cached.dots.length);
        return;
    }
    
    // Not in cache, calculate using worker pool
    isCalculating = true;
    const updateButton = document.getElementById("updateButton");
    const progressIndicator = document.getElementById("progressIndicator");
    
    updateButton.textContent = "Calculating...";
    updateButton.disabled = true;
    if (progressIndicator) {
        progressIndicator.style.display = "block";
        progressIndicator.textContent = "Initializing parallel workers...";
    }
    
    try {
        const startTime = performance.now();
        
        // Use parallel workers
        const result = await workerPool.calculateDotsParallel(params, (progress) => {
            updateButton.textContent = `Calculating... ${progress}%`;
            if (progressIndicator) {
                progressIndicator.textContent = `Processing chunks: ${progress}% complete`;
            }
        });
        
        const endTime = performance.now();
        const calculationTime = (endTime - startTime).toFixed(0);
        console.log(`[OK] Calculation took ${calculationTime}ms using ${result.debugInfo.parallelWorkers || 'multiple'} workers`);
        
        debugInfo = result.debugInfo;
        
        // Cache the result
        cacheManager.set(params, result);
        
        // Draw
        drawDots(result.dots, dotSize, enableHover, showOceanDots);
        showPerformanceInfo(`${calculationTime}ms (${result.debugInfo.parallelWorkers || 'multi'} workers)`, result.dots.length);
        
        updateButton.textContent = "Update Map";
    } catch (error) {
        console.error("Calculation error:", error);
        updateButton.textContent = "Error - Try Again";
        if (progressIndicator) {
            progressIndicator.textContent = "Error occurred during calculation";
            progressIndicator.style.backgroundColor = "#ffebee";
        }
    } finally {
        updateButton.disabled = false;
        isCalculating = false;
        if (progressIndicator) {
            setTimeout(() => {
                progressIndicator.style.display = "none";
                progressIndicator.style.backgroundColor = "#e3f2fd";
            }, 2000);
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

async function initializeApplication() {
    try {
        // Show loading message
        const updateButton = document.getElementById("updateButton");
        updateButton.textContent = "Loading...";
        updateButton.disabled = true;
        
        // Load prerendered SVG for initial display
        await loadPrerenderedSVG();
        
        // Load world data
        const topology = await d3.json("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json");
        
        // Initialize cache manager
        cacheManager = new CacheManager(10, true);
        console.log('Cache stats:', cacheManager.getStats());
        
        // Initialize worker pool
        const numWorkers = Math.min(navigator.hardwareConcurrency || 4, 6);
        workerPool = new WorkerPool(numWorkers);
        
        // Initialize workers with world data
        world.features = await workerPool.init(topology);
        console.log("Workers initialized with world data");
        
        // Setup event listeners
        document.getElementById("updateButton").addEventListener("click", updateMap);
        
        document.getElementById("colorScheme").addEventListener("change", function() {
            const isMonotone = this.value === "monotone";
            document.getElementById("monotoneControls").style.display = isMonotone ? "flex" : "none";
            updateMap();
        });
        
        // Add button to build lookup map for ultra-fast performance
        const buildLookupButton = document.getElementById("buildLookupMap");
        if (buildLookupButton) {
            buildLookupButton.addEventListener("click", async function() {
                if (lookupMapBuilt) {
                    alert("Lookup map already built!");
                    return;
                }
                
                const { width, height } = getRenderDimensions();
                const projectionName = document.getElementById("projection").value;
                
                this.textContent = "Building 0%...";
                this.disabled = true;
                
                try {
                    await workerPool.buildLookupMap(
                        { width, height, projectionName, resolution: 2 },
                        (progress) => {
                            this.textContent = `Building ${progress}%...`;
                        }
                    );
                    
                    lookupMapBuilt = true;
                    this.textContent = "[OK] Lookup Map Built";
                    this.style.backgroundColor = "#4CAF50";
                    
                    // Clear cache since we now have a faster method
                    cacheManager.clear();
                    
                    alert("Ultra-fast lookup map built! Calculations will now be much faster.");
                } catch (error) {
                    console.error("Failed to build lookup map:", error);
                    this.textContent = "Build Lookup Map";
                    this.disabled = false;
                }
            });
        }
        
        // Add button to clear cache
        const clearCacheButton = document.getElementById("clearCache");
        if (clearCacheButton) {
            clearCacheButton.addEventListener("click", function() {
                cacheManager.clear();
                lookupMapBuilt = false;
                alert("Cache cleared!");
            });
        }
        
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
        
        updateButton.textContent = "Update Map";
        updateButton.disabled = false;
        
        console.log("Application initialized successfully");
    } catch (error) {
        console.error("Failed to initialize application:", error);
        const updateButton = document.getElementById("updateButton");
        updateButton.textContent = "Error - Reload Page";
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
