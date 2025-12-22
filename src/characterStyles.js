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

function getCharacterStyle(styleName, stylesDOM) {
    if (styleMap.has(styleName)) {
        return styleMap.get(styleName);
    }

    // Find the CharacterStyle element with matching Self attribute
    const styleElements = stylesDOM.getElementsByTagName('CharacterStyle');
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
        const baseStyle = getCharacterStyle(basedOn, stylesDOM);
        style = { ...baseStyle, ...style };
    }

    styleMap.set(styleName, style);
    return style;
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

module.exports = { applyCharStyles, getCharacterStyle };
