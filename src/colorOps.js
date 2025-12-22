/**
 * Converts CMYK color values to RGB.
 * @param {Array<number>} cmyk - An array of CMYK values [c, m, y, k].
 * @returns {Object} An object containing the CMYK string and RGB string.
 */
function cmyk_to_rgb(cmyk) {
    const [c, m, y, k] = cmyk;
    const r = Math.round(255 * (1 - c / 100) * (1 - k / 100));
    const g = Math.round(255 * (1 - m / 100) * (1 - k / 100));
    const b = Math.round(255 * (1 - y / 100) * (1 - k / 100));

    const rgb_str = `rgb(${r}, ${g}, ${b})`;
    const cmyk_str = `[${cmyk.join(', ')}]`;

    return {
        cmyk: cmyk_str,
        rgb: rgb_str
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
    if (r === 0 && g === 0 && b === 0) {
        return "[0, 0, 0, 100]";
    }

    let c = 1 - r / 255;
    let m = 1 - g / 255;
    let y = 1 - b / 255;

    const k = Math.min(c, m, y);

    c = (c - k) / (1 - k);
    m = (m - k) / (1 - k);
    y = (y - k) / (1 - k);

    const cmyk = [Math.round(c * 100), Math.round(m * 100), Math.round(y * 100), Math.round(k * 100)];
    return `[${cmyk.join(', ')}]`;
}

/**
 * Retrieves color information from the graphics DOM.
 * @param {string} colorName - The name of the color to retrieve.
 * @param {Document} graphicsDOM - The parsed Graphic.xml DOM.
 * @returns {Object|null} An object containing RGB and CMYK values, or null if not found.
 */
function get_color(colorName, graphicsDOM) {
    if (!colorName || !graphicsDOM) {
        return null;
    }

    // Find the Color element with matching Self attribute
    const colorElements = graphicsDOM.getElementsByTagName('Color');
    let colorElement = null;
    for (let i = 0; i < colorElements.length; i++) {
        if (colorElements[i].getAttribute('Self') === colorName) {
            colorElement = colorElements[i];
            break;
        }
    }

    if (!colorElement) {
        return null;
    }

    const space = colorElement.getAttribute('Space');
    const colorValue = colorElement.getAttribute('ColorValue').split(' ').map(Number);

    if (space === 'RGB') {
        const rgb = `rgb(${colorValue.join(', ')})`;
        const cmyk = rgb_to_cmyk(colorValue[0], colorValue[1], colorValue[2]);
        return { rgb, cmyk };
    } else if (space === 'CMYK') {
        const result = cmyk_to_rgb(colorValue);
        return { rgb: result.rgb, cmyk: result.cmyk };
    }

    return null;
}

/**
 * Retrieves spot color information from the graphics DOM.
 * @param {string} colorName - The name of the spot color to retrieve.
 * @param {Document} graphicsDOM - The parsed Graphic.xml DOM.
 * @returns {Object|null} An object containing RGB and CMYK values for the spot color, or null if not found.
 */
function get_spot_color(colorName, graphicsDOM) {
    if (!colorName || !graphicsDOM) {
        return null;
    }

    // Find the Color element with matching Self attribute and Model="Spot"
    const colorElements = graphicsDOM.getElementsByTagName('Color');
    let colorElement = null;
    for (let i = 0; i < colorElements.length; i++) {
        if (colorElements[i].getAttribute('Self') === colorName &&
            colorElements[i].getAttribute('Model') === 'Spot') {
            colorElement = colorElements[i];
            break;
        }
    }

    if (!colorElement) {
        return null;
    }

    const space = colorElement.getAttribute('Space');
    const colorValue = colorElement.getAttribute('ColorValue').split(' ').map(Number);

    let rgb = null;
    let cmyk = null;

    if (space === 'RGB') {
        rgb = `rgb(${colorValue.join(', ')})`;
        cmyk = rgb_to_cmyk(colorValue[0], colorValue[1], colorValue[2]);
    } else if (space === 'CMYK') {
        const cmykObj = cmyk_to_rgb(colorValue);
        rgb = cmykObj.rgb;
        cmyk = cmykObj.cmyk;
    } else if (space === 'LAB') {
        // LAB conversion is more complex and might require a dedicated library
        // For now, we'll return LAB string directly
        rgb = `lab(${colorValue.join(', ')})`;
        cmyk = null; // CMYK conversion from LAB is also complex
    }

    return {
        rgb: rgb,
        cmyk: cmyk
    };
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

module.exports = { cmyk_to_rgb, rgb_to_cmyk, get_color, get_spot_color, get_gradient };
