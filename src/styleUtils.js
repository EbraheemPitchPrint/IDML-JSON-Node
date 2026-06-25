const INHERIT_VALUES = new Set(['', 'NothingEnum', 'n']);

function isExplicitStyleValue(value) {
    return value !== null && value !== undefined && !INHERIT_VALUES.has(String(value));
}

function getDirectChildElement(element, tagName) {
    if (!element) return null;
    for (let i = 0; i < element.childNodes.length; i++) {
        const child = element.childNodes[i];
        if (child.nodeType === 1 && child.tagName === tagName) {
            return child;
        }
    }
    return null;
}

function extractStyleProperties(element, options = {}) {
    const properties = {};
    const skipAttrs = options.skipAttrs || new Set();
    const skipPropertyTags = options.skipPropertyTags || new Set();

    if (!element) {
        return properties;
    }

    for (let i = 0; i < element.attributes.length; i++) {
        const attr = element.attributes[i];
        if (!skipAttrs.has(attr.name) && isExplicitStyleValue(attr.value)) {
            properties[attr.name] = attr.value;
        }
    }

    const propsElement = getDirectChildElement(element, 'Properties');
    if (propsElement) {
        for (let i = 0; i < propsElement.childNodes.length; i++) {
            const child = propsElement.childNodes[i];
            if (child.nodeType !== 1 || skipPropertyTags.has(child.tagName)) {
                continue;
            }
            const value = child.textContent;
            if (isExplicitStyleValue(value)) {
                properties[child.tagName] = value;
            }
        }
    }

    return properties;
}

function getBasedOnReference(styleElement) {
    const attrBasedOn = styleElement ? styleElement.getAttribute('BasedOn') : null;
    if (isExplicitStyleValue(attrBasedOn)) return attrBasedOn;

    const propsElement = getDirectChildElement(styleElement, 'Properties');
    const basedOnElement = getDirectChildElement(propsElement, 'BasedOn');
    if (basedOnElement && isExplicitStyleValue(basedOnElement.textContent)) {
        return basedOnElement.textContent;
    }

    return null;
}

function normalizeStyleReference(styleName, prefix, noStyleName) {
    if (!isExplicitStyleValue(styleName) || styleName === noStyleName) {
        return null;
    }

    if (styleName.startsWith(prefix)) {
        return styleName;
    }

    return `${prefix}${styleName}`;
}

function pickStyleValue(...values) {
    for (const value of values) {
        if (isExplicitStyleValue(value)) {
            return value;
        }
    }
    return undefined;
}

module.exports = {
    extractStyleProperties,
    getBasedOnReference,
    getDirectChildElement,
    isExplicitStyleValue,
    normalizeStyleReference,
    pickStyleValue
};
