const styleMap = new Map();

function getStyleProperties(styleElement) {
    const properties = {};
    const propsElements = styleElement.getElementsByTagName('Properties');
    if (propsElements.length > 0) {
        const propsElement = propsElements[0];
        for (let i = 0; i < propsElement.childNodes.length; i++) {
            const child = propsElement.childNodes[i];
            if (child.nodeType === 1) { // Element node
                properties[child.tagName] = child.textContent;
            }
        }
    }
    return properties;
}

function getObjectStyle(styleName, stylesDOM) {
    if (styleMap.has(styleName)) {
        return styleMap.get(styleName);
    }

    // Find the ObjectStyle element with matching Self attribute
    const styleElements = stylesDOM.getElementsByTagName('ObjectStyle');
    let styleElement = null;
    for (let i = 0; i < styleElements.length; i++) {
        if (styleElements[i].getAttribute('Self') === styleName) {
            styleElement = styleElements[i];
            break;
        }
    }

    if (!styleElement) {
        return {};
    }

    let style = getStyleProperties(styleElement);

    const basedOn = styleElement.getAttribute('BasedOn');
    if (basedOn) {
        const baseStyle = getObjectStyle(basedOn, stylesDOM);
        style = { ...baseStyle, ...style };
    }

    styleMap.set(styleName, style);
    return style;
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

module.exports = { applyObjStyles };
