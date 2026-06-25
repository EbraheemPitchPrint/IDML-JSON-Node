const objStyleCache = new Map();

/**
 * Clears the object style cache. Should be called between processing different IDML files.
 */
function clearObjectStyleCache() {
    objStyleCache.clear();
}

/**
 * Extracts all relevant properties from an ObjectStyle element.
 * Reads both XML attributes and child <Properties> values.
 *
 * @param {Element} styleElement - The ObjectStyle DOM element.
 * @returns {Object} All extracted style properties.
 */
function getStyleProperties(styleElement) {
    const properties = {};

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
            if (child.nodeType === 1) {
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

function getObjectStyle(styleName, stylesDOM) {
    if (!styleName) return {};

    if (objStyleCache.has(styleName)) {
        return objStyleCache.get(styleName);
    }

    const styleElements = stylesDOM.getElementsByTagName('ObjectStyle');
    let styleElement = null;

    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute('Self') === styleName) {
            styleElement = styleElements[i];
            break;
        }
    }

    if (!styleElement && !styleName.startsWith('ObjectStyle/')) {
        const prefixed = 'ObjectStyle/' + styleName;
        for (let i = 0; i < styleElements.length; i++) {
            if (styleElements[i].getAttribute('Self') === prefixed) {
                styleElement = styleElements[i];
                break;
            }
        }
    }

    if (!styleElement) {
        objStyleCache.set(styleName, {});
        return {};
    }

    const ownProperties = getStyleProperties(styleElement);

    const basedOn = getBasedOn(styleElement);
    let resolvedStyle;

    if (basedOn) {
        let basedOnFull = basedOn;
        if (!basedOn.startsWith('ObjectStyle/') && basedOn.startsWith('$ID/')) {
            basedOnFull = 'ObjectStyle/' + basedOn;
        }

        const baseStyle = getObjectStyle(basedOnFull, stylesDOM);
        resolvedStyle = { ...baseStyle, ...ownProperties };
    } else {
        resolvedStyle = { ...ownProperties };
    }

    objStyleCache.set(styleName, resolvedStyle);
    return resolvedStyle;
}

/**
 * Applies object styles to a given item element.
 * @param {Element} itemElement - The DOM element of the page item.
 * @param {Document} stylesDOM - The parsed Styles.xml DOM.
 * @returns {Object} The resolved object style properties.
 */
function applyObjStyles(itemElement, stylesDOM) {
    const appliedStyleName = itemElement.getAttribute('AppliedObjectStyle');
    if (!appliedStyleName) {
        return {};
    }
    return getObjectStyle(appliedStyleName, stylesDOM);
}

module.exports = { applyObjStyles, clearObjectStyleCache };
