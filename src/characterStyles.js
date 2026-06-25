const charStyleCache = new Map();

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
    const properties = {};

    // Metadata attributes to skip (not style properties)
    const skipAttrs = new Set([
        'Self', 'Name', 'Imported', 'SplitDocument', 'EmitCss', 'StyleUniqueId',
        'IncludeClass', 'ExtendedKeyboardShortcut', 'KeyboardShortcut', 'BasedOn'
    ]);

    // 1. Read all XML attributes from the element
    for (let i = 0; i < styleElement.attributes.length; i++) {
        const attr = styleElement.attributes[i];
        if (!skipAttrs.has(attr.name)) {
            properties[attr.name] = attr.value;
        }
    }

    // 2. Read child <Properties> element values
    const propsElements = styleElement.getElementsByTagName('Properties');
    if (propsElements.length > 0) {
        const propsElement = propsElements[0];
        for (let i = 0; i < propsElement.childNodes.length; i++) {
            const child = propsElement.childNodes[i];
            if (child.nodeType === 1) { // Element node
                if (child.tagName === 'BasedOn' || child.tagName === 'PreviewColor') {
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
    const attrBasedOn = styleElement.getAttribute('BasedOn');
    if (attrBasedOn) return attrBasedOn;

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
 * Resolves a character style by name, following the BasedOn inheritance chain.
 *
 * @param {string} styleName - The Self attribute value of the CharacterStyle.
 * @param {Document} stylesDOM - The parsed Styles.xml DOM.
 * @returns {Object} The fully resolved style properties.
 */
function getCharacterStyle(styleName, stylesDOM) {
    if (!styleName) return {};

    if (charStyleCache.has(styleName)) {
        return charStyleCache.get(styleName);
    }

    const styleElements = stylesDOM.getElementsByTagName('CharacterStyle');
    let styleElement = null;
    let resolvedName = styleName;

    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute('Self') === styleName) {
            styleElement = styleElements[i];
            break;
        }
    }

    // Try with "CharacterStyle/" prefix if not found
    if (!styleElement && !styleName.startsWith('CharacterStyle/')) {
        const prefixed = 'CharacterStyle/' + styleName;
        for (let i = 0; i < styleElements.length; i++) {
            if (styleElements[i].getAttribute('Self') === prefixed) {
                styleElement = styleElements[i];
                resolvedName = prefixed;
                break;
            }
        }
    }

    if (!styleElement) {
        charStyleCache.set(styleName, {});
        return {};
    }

    const ownProperties = getStyleProperties(styleElement);

    const basedOn = getBasedOn(styleElement);
    let resolvedStyle;

    if (basedOn) {
        let basedOnFull = basedOn;
        if (!basedOn.startsWith('CharacterStyle/') && basedOn.startsWith('$ID/')) {
            basedOnFull = 'CharacterStyle/' + basedOn;
        }

        const baseStyle = getCharacterStyle(basedOnFull, stylesDOM);
        resolvedStyle = { ...baseStyle, ...ownProperties };
    } else {
        resolvedStyle = { ...ownProperties };
    }

    charStyleCache.set(styleName, resolvedStyle);
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
