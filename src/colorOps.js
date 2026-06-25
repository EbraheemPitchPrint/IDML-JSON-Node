/**
 * Converts CMYK color values to RGB.
 * @param {Array<number>} cmyk - An array of CMYK values [c, m, y, k].
 * @returns {Object} An object containing the CMYK string and RGB string.
 */
const COLOR_CONVERSION_POLICY = 'device-cmyk-v1';

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function parseColorArray(value, expectedLength) {
    if (!value) return null;
    const parsed = value
        .split(/[\s,]+/)
        .map(Number)
        .filter(v => Number.isFinite(v));

    if (parsed.length < expectedLength) return null;
    return parsed.slice(0, expectedLength);
}

function findElementBySelf(graphicsDOM, tagName, ref) {
    if (!graphicsDOM || !ref) return null;
    const elements = graphicsDOM.getElementsByTagName(tagName);
    for (let i = 0; i < elements.length; i++) {
        if (elements[i].getAttribute('Self') === ref) {
            return elements[i];
        }
    }
    return null;
}

function parsePercent(value, fallback = 100) {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return clamp(parsed, 0, 100);
}

function tintRgb(rgbArray, tintPercent) {
    const factor = clamp(tintPercent, 0, 100) / 100;
    return rgbArray.map(channel => {
        const c = clamp(channel, 0, 255);
        return Math.round(255 - ((255 - c) * factor));
    });
}

function tintCmyk(cmykArray, tintPercent) {
    const factor = clamp(tintPercent, 0, 100) / 100;
    return cmykArray.map(channel => Math.round(clamp(channel, 0, 100) * factor));
}

function formatRgb(rgbArray) {
    const [r, g, b] = rgbArray.map(v => clamp(Math.round(v), 0, 255));
    return `rgb(${r}, ${g}, ${b})`;
}

function formatCmyk(cmykArray) {
    const rounded = cmykArray.map(v => clamp(Math.round(v), 0, 100));
    return `[${rounded.join(', ')}]`;
}

function cmyk_to_rgb(cmyk) {
    const [rawC, rawM, rawY, rawK] = Array.isArray(cmyk) ? cmyk : [0, 0, 0, 100];
    const c = clamp(Number(rawC) || 0, 0, 100);
    const m = clamp(Number(rawM) || 0, 0, 100);
    const y = clamp(Number(rawY) || 0, 0, 100);
    const k = clamp(Number(rawK) || 0, 0, 100);

    const r = Math.round(255 * (1 - c / 100) * (1 - k / 100));
    const g = Math.round(255 * (1 - m / 100) * (1 - k / 100));
    const b = Math.round(255 * (1 - y / 100) * (1 - k / 100));

    const rgb_str = formatRgb([r, g, b]);
    const cmyk_str = formatCmyk([c, m, y, k]);

    return {
        cmyk: cmyk_str,
        rgb: rgb_str,
        policy: COLOR_CONVERSION_POLICY,
        model: 'process'
    };
}

/**
 * Converts RGB color values to CMYK.
 * @param {number} r - Red component (0-255).
 * @param {number} g - Green component (0-255).
 * @param {number} b - Blue component (0-255).
 * @returns {string} CMYK string representation.
 */
function rgb_to_cmyk(r, g, b) {
    const rr = clamp(Number(r) || 0, 0, 255);
    const gg = clamp(Number(g) || 0, 0, 255);
    const bb = clamp(Number(b) || 0, 0, 255);

    if (rr === 0 && gg === 0 && bb === 0) {
        return "[0, 0, 0, 100]";
    }

    let c = 1 - rr / 255;
    let m = 1 - gg / 255;
    let y = 1 - bb / 255;

    const k = Math.min(c, m, y);

    c = (c - k) / (1 - k);
    m = (m - k) / (1 - k);
    y = (y - k) / (1 - k);

    const cmyk = [Math.round(c * 100), Math.round(m * 100), Math.round(y * 100), Math.round(k * 100)];
    return formatCmyk(cmyk);
}

function resolveColorReference(colorName, graphicsDOM) {
    if (!colorName || !graphicsDOM) {
        return null;
    }

    let currentRef = colorName;
    let tintPercent = 100;
    let swatchRef = null;
    let colorElement = null;

    for (let depth = 0; depth < 8 && currentRef; depth++) {
        if (currentRef.startsWith('Swatch/')) {
            const swatchElement = findElementBySelf(graphicsDOM, 'Swatch', currentRef);
            if (!swatchElement) break;
            swatchRef = currentRef;
            tintPercent = (tintPercent * parsePercent(
                swatchElement.getAttribute('Tint') || swatchElement.getAttribute('TintValue'),
                100
            )) / 100;
            currentRef = swatchElement.getAttribute('Color');
            continue;
        }

        if (currentRef.startsWith('Tint/')) {
            const tintElement = findElementBySelf(graphicsDOM, 'Tint', currentRef);
            if (!tintElement) break;
            tintPercent = (tintPercent * parsePercent(
                tintElement.getAttribute('TintValue') || tintElement.getAttribute('Tint'),
                100
            )) / 100;
            currentRef = tintElement.getAttribute('BaseColor') || tintElement.getAttribute('Color') || tintElement.getAttribute('ParentColor');
            continue;
        }

        colorElement = findElementBySelf(graphicsDOM, 'Color', currentRef);
        if (colorElement) {
            break;
        }

        // Fallback for unprefixed names
        colorElement = findElementBySelf(graphicsDOM, 'Color', `Color/${currentRef}`);
        if (colorElement) {
            break;
        }

        break;
    }

    if (!colorElement) {
        return null;
    }

    return {
        colorElement,
        tintPercent,
        swatchRef
    };
}

function convertResolvedColor(resolved) {
    if (!resolved || !resolved.colorElement) {
        return null;
    }

    const { colorElement, tintPercent, swatchRef } = resolved;
    const space = colorElement.getAttribute('Space');
    const model = colorElement.getAttribute('Model') || 'Process';
    const colorValue = parseColorArray(colorElement.getAttribute('ColorValue'), space === 'CMYK' ? 4 : 3);

    if (!colorValue) {
        return null;
    }

    let rgb = null;
    let cmyk = null;

    if (space === 'RGB') {
        const tintedRgb = tintRgb(colorValue, tintPercent);
        rgb = formatRgb(tintedRgb);
        cmyk = rgb_to_cmyk(tintedRgb[0], tintedRgb[1], tintedRgb[2]);
    } else if (space === 'CMYK') {
        const tintedCmyk = tintCmyk(colorValue, tintPercent);
        const result = cmyk_to_rgb(tintedCmyk);
        rgb = result.rgb;
        cmyk = result.cmyk;
    } else if (space === 'LAB') {
        rgb = `lab(${colorValue.join(', ')})`;
        cmyk = null;
    } else {
        return null;
    }

    return {
        rgb,
        cmyk,
        model: model.toLowerCase(),
        space,
        tint: tintPercent,
        swatch: swatchRef,
        policy: COLOR_CONVERSION_POLICY
    };
}

/**
 * Retrieves color information from the graphics DOM.
 * @param {string} colorName - The name of the color to retrieve.
 * @param {Document} graphicsDOM - The parsed Graphic.xml DOM.
 * @returns {Object|null} An object containing RGB and CMYK values, or null if not found.
 */
function get_color(colorName, graphicsDOM) {
    const resolved = resolveColorReference(colorName, graphicsDOM);
    return convertResolvedColor(resolved);
}

/**
 * Retrieves spot color information from the graphics DOM.
 * @param {string} colorName - The name of the spot color to retrieve.
 * @param {Document} graphicsDOM - The parsed Graphic.xml DOM.
 * @returns {Object|null} An object containing RGB and CMYK values for the spot color, or null if not found.
 */
function get_spot_color(colorName, graphicsDOM) {
    const resolved = resolveColorReference(colorName, graphicsDOM);
    if (!resolved || !resolved.colorElement) {
        return null;
    }

    if ((resolved.colorElement.getAttribute('Model') || '').toLowerCase() !== 'spot') {
        return null;
    }

    return convertResolvedColor(resolved);
}

/**
 * Retrieves gradient information from the graphics DOM.
 * @param {string} gradientName - The name of the gradient to retrieve.
 * @param {Document} graphicsDOM - The parsed Graphic.xml DOM.
 * @returns {Object|null} An object containing gradient data (id, type, stops), or null if not found.
 */
function get_gradient(gradientName, graphicsDOM) {
    if (!gradientName || !graphicsDOM) {
        return null;
    }

    // Find the Gradient element with matching Self attribute
    const gradientElements = graphicsDOM.getElementsByTagName('Gradient');
    let gradientElement = null;
    for (let i = 0; i < gradientElements.length; i++) {
        if (gradientElements[i].getAttribute('Self') === gradientName) {
            gradientElement = gradientElements[i];
            break;
        }
    }

    if (!gradientElement) {
        return null;
    }

    const gradientColors = {
        id: gradientElement.getAttribute('Self'),
        type: gradientElement.getAttribute('Type'),
        stops: []
    };

    const stopElements = Array.from(gradientElement.getElementsByTagName('GradientStop'));
    for (const stopElement of stopElements) {
        const stopColorName = stopElement.getAttribute('StopColor');
        const colors = get_color(stopColorName, graphicsDOM); // Re-use get_color for stop colors
        gradientColors.stops.push({
            stopColorRGB: colors ? colors.rgb : null,
            stopColorCMYK: colors ? colors.cmyk : null,
            location: stopElement.getAttribute('Location'),
            midpoint: stopElement.getAttribute('Midpoint'),
        });
    }

    return gradientColors;
}

module.exports = { cmyk_to_rgb, rgb_to_cmyk, get_color, get_spot_color, get_gradient, COLOR_CONVERSION_POLICY };
