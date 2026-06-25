const charStyleCache = new Map();
const {
    extractStyleProperties,
    getBasedOnReference,
    normalizeStyleReference
} = require('./styleUtils');

/**
 * Clears the character style cache. Should be called between processing different IDML files.
 */
function clearCharacterStyleCache() {
    charStyleCache.clear();
}

/**
 * Extracts all relevant properties from a CharacterStyle element.
 * In IDML, style properties come from TWO places:
 *   1. XML attributes on the element itself (FontStyle, PointSize, FillColor, etc.)
 *   2. Child <Properties> element (AppliedFont, etc.)
 *
 * @param {Element} styleElement - The CharacterStyle DOM element.
 * @returns {Object} All extracted style properties.
 */
function getStyleProperties(styleElement) {
    const skipAttrs = new Set([
        'Self', 'Name', 'Imported', 'SplitDocument', 'EmitCss', 'StyleUniqueId',
        'IncludeClass', 'ExtendedKeyboardShortcut', 'KeyboardShortcut', 'BasedOn'
    ]);
    const skipPropertyTags = new Set(['BasedOn', 'PreviewColor']);
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
 * Resolves a character style by name, following the BasedOn inheritance chain.
 *
 * @param {string} styleName - The Self attribute value of the CharacterStyle.
 * @param {Document} stylesDOM - The parsed Styles.xml DOM.
 * @returns {Object} The fully resolved style properties.
 */
function getCharacterStyle(styleName, stylesDOM) {
    const normalizedStyleName = normalizeStyleReference(
        styleName,
        'CharacterStyle/',
        '$ID/[No character style]'
    );
    if (!normalizedStyleName) return {};

    if (charStyleCache.has(normalizedStyleName)) {
        return charStyleCache.get(normalizedStyleName);
    }

    const styleElements = stylesDOM.getElementsByTagName('CharacterStyle');
    let styleElement = null;

    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute('Self') === normalizedStyleName) {
            styleElement = styleElements[i];
            break;
        }
    }

    if (!styleElement) {
        charStyleCache.set(normalizedStyleName, {});
        return {};
    }

    const ownProperties = getStyleProperties(styleElement);

    const basedOn = getBasedOn(styleElement);
    let resolvedStyle;

    if (basedOn) {
        const baseStyle = getCharacterStyle(basedOn, stylesDOM);
        resolvedStyle = { ...baseStyle, ...ownProperties };
    } else {
        resolvedStyle = { ...ownProperties };
    }

    charStyleCache.set(normalizedStyleName, resolvedStyle);
    return resolvedStyle;
}

/**
 * Applies character styles from a story DOM.
 * @param {Document} storyDOM - The parsed Story.xml DOM.
 * @param {Document} stylesDOM - The parsed Styles.xml DOM.
 * @returns {Array<Object>} An array of resolved character style properties.
 */
function applyCharStyles(storyDOM, stylesDOM) {
    const charRanges = Array.from(storyDOM.getElementsByTagName('CharacterStyleRange'));
    const styles = [];

    for (const range of charRanges) {
        const appliedStyleName = range.getAttribute('AppliedCharacterStyle');
        if (appliedStyleName) {
            styles.push(getCharacterStyle(appliedStyleName, stylesDOM));
        }
    }

    return styles;
}

module.exports = { applyCharStyles, getCharacterStyle, clearCharacterStyleCache };
