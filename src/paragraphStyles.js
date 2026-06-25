const paraStyleCache = new Map();

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
    const properties = {};

    // Metadata attributes to skip (not style properties)
    const skipAttrs = new Set([
        'Self', 'Name', 'Imported', 'SplitDocument', 'EmitCss', 'StyleUniqueId',
        'IncludeClass', 'ExtendedKeyboardShortcut', 'NextStyle', 'KeyboardShortcut',
        'BasedOn', 'EmptyNestedStyles', 'EmptyLineStyles', 'EmptyGrepStyles'
    ]);

    // 1. Read all XML attributes from the element
    for (let i = 0; i < styleElement.attributes.length; i++) {
        const attr = styleElement.attributes[i];
        if (!skipAttrs.has(attr.name)) {
            properties[attr.name] = attr.value;
        }
    }

    // 2. Read child <Properties> element values (these supplement attributes)
    const propsElements = styleElement.getElementsByTagName('Properties');
    if (propsElements.length > 0) {
        const propsElement = propsElements[0];
        for (let i = 0; i < propsElement.childNodes.length; i++) {
            const child = propsElement.childNodes[i];
            if (child.nodeType === 1) { // Element node
                // Skip BasedOn (handled separately) and non-style metadata
                if (child.tagName === 'BasedOn' || child.tagName === 'PreviewColor' ||
                    child.tagName === 'TabList') {
                    continue;
                }
                properties[child.tagName] = child.textContent;
            }
        }
    }

    return properties;
}

/**
 * Gets the BasedOn value from a style element.
 * BasedOn can be either an XML attribute or inside <Properties>.
 *
 * @param {Element} styleElement - The style DOM element.
 * @returns {string|null} The BasedOn style reference, or null.
 */
function getBasedOn(styleElement) {
    // Check attribute first
    const attrBasedOn = styleElement.getAttribute('BasedOn');
    if (attrBasedOn) return attrBasedOn;

    // Check Properties/BasedOn element
    const propsElements = styleElement.getElementsByTagName('Properties');
    if (propsElements.length > 0) {
        const basedOnElements = propsElements[0].getElementsByTagName('BasedOn');
        if (basedOnElements.length > 0) {
            const value = basedOnElements[0].textContent;
            if (value) return value;
        }
    }

    return null;
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
    if (!styleName) return {};

    if (paraStyleCache.has(styleName)) {
        return paraStyleCache.get(styleName);
    }

    // Find the ParagraphStyle element with matching Self attribute
    const styleElements = stylesDOM.getElementsByTagName('ParagraphStyle');
    let styleElement = null;
    let resolvedName = styleName;

    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute('Self') === styleName) {
            styleElement = styleElements[i];
            break;
        }
    }

    // Try with "ParagraphStyle/" prefix if not found
    if (!styleElement && !styleName.startsWith('ParagraphStyle/')) {
        const prefixed = 'ParagraphStyle/' + styleName;
        for (let i = 0; i < styleElements.length; i++) {
            if (styleElements[i].getAttribute('Self') === prefixed) {
                styleElement = styleElements[i];
                resolvedName = prefixed;
                break;
            }
        }
    }

    if (!styleElement) {
        paraStyleCache.set(styleName, {});
        return {};
    }

    // Get this style's own properties
    const ownProperties = getStyleProperties(styleElement);

    // Resolve BasedOn chain
    const basedOn = getBasedOn(styleElement);
    let resolvedStyle;

    if (basedOn) {
        // Normalise BasedOn reference
        let basedOnFull = basedOn;
        if (!basedOn.startsWith('ParagraphStyle/') && basedOn.startsWith('$ID/')) {
            basedOnFull = 'ParagraphStyle/' + basedOn;
        }

        const baseStyle = getParagraphStyle(basedOnFull, stylesDOM);
        // Base style properties, then override with own properties
        resolvedStyle = { ...baseStyle, ...ownProperties };
    } else {
        resolvedStyle = { ...ownProperties };
    }

    paraStyleCache.set(styleName, resolvedStyle);
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
