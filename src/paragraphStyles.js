const paraStyleCache = new Map();
const {
    extractStyleProperties,
    getBasedOnReference,
    normalizeStyleReference
} = require('./styleUtils');

/**
 * Clears the paragraph style cache. Should be called between processing different IDML files.
 */
function clearParagraphStyleCache() {
    paraStyleCache.clear();
}

/**
 * Extracts all relevant properties from a ParagraphStyle element.
 * In IDML, style properties come from TWO places:
 *   1. XML attributes on the element itself (FontStyle, PointSize, FillColor, etc.)
 *   2. Child <Properties> element (AppliedFont, Leading, BasedOn, etc.)
 *
 * @param {Element} styleElement - The ParagraphStyle DOM element.
 * @returns {Object} All extracted style properties.
 */
function getStyleProperties(styleElement) {
    const skipAttrs = new Set([
        'Self', 'Name', 'Imported', 'SplitDocument', 'EmitCss', 'StyleUniqueId',
        'IncludeClass', 'ExtendedKeyboardShortcut', 'NextStyle', 'KeyboardShortcut',
        'BasedOn', 'EmptyNestedStyles', 'EmptyLineStyles', 'EmptyGrepStyles'
    ]);
    const skipPropertyTags = new Set(['BasedOn', 'PreviewColor', 'TabList']);
    return extractStyleProperties(styleElement, { skipAttrs, skipPropertyTags });
}

/**
 * Gets the BasedOn value from a style element.
 * BasedOn can be either an XML attribute or inside <Properties>.
 *
 * @param {Element} styleElement - The style DOM element.
 * @returns {string|null} The BasedOn style reference, or null.
 */
function getBasedOn(styleElement) {
    return getBasedOnReference(styleElement);
}

/**
 * Resolves a paragraph style by name, following the BasedOn inheritance chain.
 * Properties from the current style override those from the base style.
 *
 * @param {string} styleName - The Self attribute value of the ParagraphStyle.
 * @param {Document} stylesDOM - The parsed Styles.xml DOM.
 * @returns {Object} The fully resolved style properties.
 */
function getParagraphStyle(styleName, stylesDOM) {
    const normalizedStyleName = normalizeStyleReference(
        styleName,
        'ParagraphStyle/',
        '$ID/[No paragraph style]'
    );
    if (!normalizedStyleName) return {};

    if (paraStyleCache.has(normalizedStyleName)) {
        return paraStyleCache.get(normalizedStyleName);
    }

    // Find the ParagraphStyle element with matching Self attribute
    const styleElements = stylesDOM.getElementsByTagName('ParagraphStyle');
    let styleElement = null;

    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute('Self') === normalizedStyleName) {
            styleElement = styleElements[i];
            break;
        }
    }

    if (!styleElement) {
        paraStyleCache.set(normalizedStyleName, {});
        return {};
    }

    // Get this style's own properties
    const ownProperties = getStyleProperties(styleElement);

    // Resolve BasedOn chain
    const basedOn = getBasedOn(styleElement);
    let resolvedStyle;

    if (basedOn) {
        const baseStyle = getParagraphStyle(basedOn, stylesDOM);
        // Base style properties, then override with own properties
        resolvedStyle = { ...baseStyle, ...ownProperties };
    } else {
        resolvedStyle = { ...ownProperties };
    }

    paraStyleCache.set(normalizedStyleName, resolvedStyle);
    return resolvedStyle;
}

/**
 * Applies paragraph styles from a story DOM.
 * @param {Document} storyDOM - The parsed Story.xml DOM.
 * @param {Document} stylesDOM - The parsed Styles.xml DOM.
 * @returns {Array<Object>} An array of resolved paragraph style properties.
 */
function applyParaStyles(storyDOM, stylesDOM) {
    const paraRanges = Array.from(storyDOM.getElementsByTagName('ParagraphStyleRange'));
    const styles = [];

    for (const range of paraRanges) {
        const appliedStyleName = range.getAttribute('AppliedParagraphStyle');
        if (appliedStyleName) {
            styles.push(getParagraphStyle(appliedStyleName, stylesDOM));
        }
    }

    return styles;
}

module.exports = { applyParaStyles, getParagraphStyle, clearParagraphStyleCache };
