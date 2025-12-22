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

function getParagraphStyle(styleName, stylesDOM) {
    if (styleMap.has(styleName)) {
        return styleMap.get(styleName);
    }

    // Find the ParagraphStyle element with matching Self attribute
    const styleElements = stylesDOM.getElementsByTagName('ParagraphStyle');
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
        const baseStyle = getParagraphStyle(basedOn, stylesDOM);
        style = { ...baseStyle, ...style };
    }

    styleMap.set(styleName, style);
    return style;
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

module.exports = { applyParaStyles, getParagraphStyle };
