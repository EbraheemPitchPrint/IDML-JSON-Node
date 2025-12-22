const fs = require('fs');
const JSZip = require('jszip');
const { DOMParser } = require('xmldom');
const { get_color, get_spot_color, get_gradient } = require('./colorOps.js');
const { is_svg, compress_image, convert_base64 } = require('./imageOps.js');
const { applyCharStyles, getCharacterStyle } = require('./characterStyles.js');
const { applyParaStyles, getParagraphStyle } = require('./paragraphStyles.js');
const { applyObjStyles } = require('./objectStyles.js');
const { pt_px } = require('./utils.js');
const { matrix, multiply } = require('mathjs');

/**
 * Processes an IDML file and extracts its content into a JSON structure.
 * @param {string} filePath - The path to the IDML file.
 * @returns {Promise<Object>} A promise that resolves with the JSON representation of the IDML document.
 */
async function processIdml(filePath) {
    console.log('Starting IDML processing...');

    const fileContent = fs.readFileSync(filePath);
    const zip = await JSZip.loadAsync(fileContent);
    const parser = new DOMParser();

    async function parseXml(fileName) {
        try {
            const xmlString = await zip.file(fileName).async("string");
            const parsedDoc = parser.parseFromString(xmlString, "application/xml");
            if (parsedDoc.getElementsByTagName("parsererror").length > 0) {
                console.error(`Error parsing ${fileName}:`, parsedDoc.getElementsByTagName("parsererror")[0].textContent);
                throw new Error(`Failed to parse XML file: ${fileName}`);
            }
            return parsedDoc;
        } catch (error) {
            console.error(`Could not read or parse file ${fileName}:`, error);
            throw error;
        }
    }

    const designmapDOM = await parseXml("designmap.xml");
    const stylesDOM = await parseXml("Resources/Styles.xml");
    const graphicDOM = await parseXml("Resources/Graphic.xml");
    const preferencesDOM = await parseXml("Resources/Preferences.xml");

    function getDocumentData(preferencesDOM) {
        const docPref = preferencesDOM.getElementsByTagName('DocumentPreference')[0];
        const marginPref = preferencesDOM.getElementsByTagName('MarginPreference')[0];

        let bleed = 0;
        if (docPref && docPref.getAttribute('DocumentBleedUniformSize') === 'true') {
            bleed = parseFloat(docPref.getAttribute('DocumentBleedBottomOffset'));
        } else if (docPref) {
            bleed = [
                parseFloat(docPref.getAttribute('DocumentBleedTopOffset')),
                parseFloat(docPref.getAttribute('DocumentBleedBottomOffset')),
                parseFloat(docPref.getAttribute('DocumentBleedInsideOrLeftOffset')),
                parseFloat(docPref.getAttribute('DocumentBleedOutsideOrRightOffset'))
            ];
        }

        let margin = null;
        if (marginPref) {
            const mt = parseFloat(marginPref.getAttribute('Top'));
            const mr = parseFloat(marginPref.getAttribute('Right'));
            const mb = parseFloat(marginPref.getAttribute('Bottom'));
            const ml = parseFloat(marginPref.getAttribute('Left'));
            if (mt === mr && mt === mb && mt === ml) {
                margin = mt;
            } else {
                margin = [mt, mr, mb, ml];
            }
        }

        return {
            bleed: bleed,
            fWidth: docPref ? parseFloat(docPref.getAttribute('PageWidth')) : 0,
            fHeight: docPref ? parseFloat(docPref.getAttribute('PageHeight')) : 0,
            originX: 'left',
            originY: 'top',
            transformMatrix: [1, 0, 0, 1, 0, 0],
            margin: margin
        };
    }

    const documentData = getDocumentData(preferencesDOM);

    // Get spread paths - check for both namespaced and non-namespaced elements
    let spreadElements = designmapDOM.getElementsByTagName('Spread');
    if (spreadElements.length === 0) {
        // Try with namespace prefix
        spreadElements = designmapDOM.getElementsByTagNameNS('*', 'Spread');
    }
    const spreadPaths = Array.from(spreadElements)
        .map(spread => spread.getAttribute('src'))
        .filter(src => src); // Filter out null/undefined values

    console.log('Found spread paths:', spreadPaths);
    const pages = [];

    async function processPageItem(itemElement, stylesDOM, graphicDOM, zip, parseXml, parent) {
        let processedItem = null;
        const tagName = itemElement.tagName;

        if (tagName === 'Rectangle') {
            processedItem = await getRect(itemElement, stylesDOM, graphicDOM, parent);
        } else if (tagName === 'TextFrame') {
            processedItem = await getTextFrame(itemElement, stylesDOM, graphicDOM, zip, parseXml, parent);
        } else if (tagName === 'Polygon') {
            processedItem = await getPolygon(itemElement, stylesDOM, graphicDOM, parent);
        } else if (tagName === 'GraphicLine') {
            processedItem = await getGraphicLine(itemElement, stylesDOM, graphicDOM, parent);
        } else if (tagName === 'Oval') {
            processedItem = await getOval(itemElement, stylesDOM, graphicDOM, parent);
        } else if (tagName === 'Image') {
            processedItem = await getImage(itemElement, stylesDOM, graphicDOM, zip, parent);
        } else if (tagName === 'EPS') {
            processedItem = await getEps(itemElement, stylesDOM, graphicDOM, zip, parent);
        } else if (tagName === 'SVG') {
            processedItem = await getSvg(itemElement, stylesDOM, graphicDOM, zip, parent);
        } else if (tagName === 'Group') {
            processedItem = await getGroup(itemElement, stylesDOM, graphicDOM, zip, parseXml, parent);
        }

        return processedItem;
    }

    async function getRect(itemElement, stylesDOM, graphicDOM, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);
        const pathPoints = Array.from(itemElement.getElementsByTagName('PathPointType'));

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        const topLeft = pathPoints[0].getAttribute('LeftDirection').split(' ').map(parseFloat);
        const bottomRight = pathPoints[2].getAttribute('LeftDirection').split(' ').map(parseFloat);

        let width = bottomRight[0] - topLeft[0];
        let height = bottomRight[1] - topLeft[1];

        if (height < 0) {
            topLeft[1] = topLeft[1] + height;
            height = Math.abs(height);
        }

        let finalItemTransform = itemTransform;
        let parentTransform = parent.getAttribute('ItemTransform');

        if (parent.tagName !== 'Spread') {
            const m1 = matrix(parent.getAttribute('ItemTransform').split(' ').map(parseFloat));
            const m2 = matrix(itemTransform);
            const m = multiply(m1, m2);
            finalItemTransform = (typeof m.toArray === 'function') ? m.toArray().flat() : (Array.isArray(m) ? m.flat() : m);
        }

        const strokeColor = get_color(itemElement.getAttribute('StrokeColor') || objectStyle.StrokeColor, graphicDOM);
        const fillVal = get_color(itemElement.getAttribute('FillColor') || objectStyle.FillColor, graphicDOM);
        const spot = get_spot_color(itemElement.getAttribute('FillColor') || objectStyle.StrokeColor, graphicDOM);

        const strokeWeight = objectStyle.StrokeWeight || itemElement.getAttribute('StrokeWeight') || 0;

        let pageItem = {
            type: 'rect',
            transformMatrix: finalItemTransform,
            width: pt_px(width),
            height: pt_px(height),
            Name: itemElement.getAttribute('Name'),
            fill: fillVal ? fillVal.rgb : "rgb(0, 0, 0)",
            cmyk: fillVal ? fillVal.cmyk : "[0, 0, 0, 100]",
            strokeWidth: pt_px(strokeWeight),
            stroke: strokeColor ? strokeColor.rgb : "rgb(0, 0, 0)",
        };

        const transparencySettings = itemElement.getElementsByTagName('TransparencySetting')[0];
        if (transparencySettings) {
            const blendingSettings = transparencySettings.getElementsByTagName('BlendingSetting')[0];
            if (blendingSettings) {
                pageItem.opacity = parseFloat(blendingSettings.getAttribute('Opacity')) / 100;
            }
        }

        const gradientFill = itemElement.getAttribute('GradientFill') || objectStyle.GradientFill;
        if (gradientFill) {
            const gradient = get_gradient(gradientFill, graphicDOM);
            if (gradient) {
                gradient.GradientFillStart = itemElement.getAttribute('GradientFillStart') || objectStyle.GradientFillStart;
                gradient.GradientFillLength = itemElement.getAttribute('GradientFillLength') || objectStyle.GradientFillLength;
                gradient.GradientFillAngle = itemElement.getAttribute('GradientFillAngle') || objectStyle.GradientFillAngle;
                pageItem.gradient = gradient;
            }
        }

        if (spot) {
            pageItem.spot = spot;
        }

        return pageItem;
    }

    async function getTextFrame(itemElement, stylesDOM, graphicDOM, zip, parseXml, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);
        const pathPoints = Array.from(itemElement.getElementsByTagName('PathPointType'));

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        const topLeft = pathPoints[0].getAttribute('Anchor').split(' ').map(parseFloat);
        const bottomRight = pathPoints[2] ? pathPoints[2].getAttribute('Anchor').split(' ').map(parseFloat) : pathPoints[1].getAttribute('Anchor').split(' ').map(parseFloat);

        let width = Math.abs(bottomRight[0] - topLeft[0]);
        let height = Math.abs(bottomRight[1] - topLeft[1]);

        const parentStory = itemElement.getAttribute('ParentStory');
        const storyData = await get_story_data(parentStory, zip, stylesDOM, graphicDOM, parseXml);

        const textFramePref = itemElement.getElementsByTagName('TextFramePreference')[0];
        const verticalJustification = textFramePref ? textFramePref.getAttribute('VerticalJustification') : '';

        const dropShadowSettings = {};
        const transparencySetting = itemElement.getElementsByTagName('TransparencySetting')[0];
        if (transparencySetting) {
            const dropShadowSetting = transparencySetting.getElementsByTagName('DropShadowSetting')[0];
            if (dropShadowSetting) {
                for (let i = 0; i < dropShadowSetting.attributes.length; i++) {
                    const attr = dropShadowSetting.attributes[i];
                    if (attr.value === 'true') {
                        dropShadowSettings[attr.name] = attr.value;
                    }
                }
            }
        }

        const { text, styles, font, fontSize, leading, tracking, justification, fontStyle, strokeWeight, fillColor, strokeColor, capitalization, cmyk, spot, underline, position } = storyData;

        const finalFontFamily = font === 'No Font' ? 'Arial' : font;
        const finalFontSize = fontSize === 'No Font Size' ? 12 : parseFloat(fontSize);
        const finalLineHeight = leading === 'Auto' || !leading ? 1.13 : parseFloat(leading);
        const finalTextAlign = justification === 'CenterAlign' || justification === 'CenterJustified' ? 'center' : justification === 'RightAlign' ? 'right' : 'left';
        const finalFontStyle = fontStyle.includes('Black') ? 'Bold' : fontStyle === 'No Font Style' ? 'Regular' : fontStyle;
        const finalStrokeWidth = strokeWeight || 0;
        const finalCapitalization = capitalization === 'AllCaps';

        const newLineCount = (text.match(/\n/g) || []).length + 1;
        const trueHeight = (pt_px(finalFontSize) * newLineCount) * finalLineHeight;
        const padding = height > trueHeight ? (height - trueHeight) / 2 : 0;

        // fillColor and strokeColor are already RGB strings from storyData, no need to convert again

        let pageItem = {
            type: 'Textbox',
            transformMatrix: itemTransform,
            width: pt_px(width),
            height: pt_px(height),
            Name: itemElement.getAttribute('Name'),
            text: finalCapitalization ? text.toUpperCase() : text,
            textAlign: finalTextAlign,
            parent_story: parentStory,
            shadow: dropShadowSettings,
            fontStyle: finalFontStyle,
            fontSize: pt_px(finalFontSize),
            lineHeight: finalLineHeight,
            charSpacing: tracking === 'No Tracking' ? 0 : parseFloat(tracking),
            strokeWidth: pt_px(finalStrokeWidth),
            fill: fillColor,  // Already RGB string from storyData
            cmyk: cmyk,  // Already CMYK string from storyData
            fontFamily: finalFontFamily,
            stroke: strokeColor,  // Already RGB string from storyData
            padding: padding,
            styles: styles,
            VerticalJustification: verticalJustification,
        };

        if (spot) {
            pageItem.spot = spot;
        }

        const gradientFill = itemElement.getAttribute('GradientFill') || objectStyle.FillColor;
        if (gradientFill) {
            const gradient = get_gradient(gradientFill, graphicDOM);
            if (gradient) {
                gradient.GradientFillStart = itemElement.getAttribute('GradientFillStart') || objectStyle.GradientFillStart;
                gradient.GradientFillLength = itemElement.getAttribute('GradientFillLength') || objectStyle.GradientFillLength;
                gradient.GradientFillAngle = itemElement.getAttribute('GradientFillAngle') || objectStyle.GradientFillAngle;
                pageItem.gradient = gradient;
            }
        }

        return pageItem;
    }

    async function get_story_data(parentStory, zip, stylesDOM, graphicDOM, parseXml) {
        const storyPath = `Stories/Story_${parentStory}.xml`;
        const storyDOM = await parseXml(storyPath);
        const storyRoot = storyDOM.getElementsByTagName('Story')[0];

        let text = '';
        const allCharStyles = []; // Store style for each character
        let pItems = {};
        let charIndex = 0;

        const paragraphStyleRanges = Array.from(storyRoot.getElementsByTagName('ParagraphStyleRange'));

        for (const paraRange of paragraphStyleRanges) {
            const paraStyleName = paraRange.getAttribute('AppliedParagraphStyle');
            const paraStyle = getParagraphStyle(paraStyleName, stylesDOM);

            // Base paragraph styles
            pItems.font = paraStyle.AppliedFont || 'No Font';
            pItems.leading = paraStyle.Leading || 1.13;
            pItems.tracking = paraStyle.Tracking || 'No Tracking';
            pItems.fillColor = paraStyle.FillColor || 'No Fill';
            pItems.fontStyle = paraStyle.FontStyle || 'No Font Style';
            pItems.fontSize = paraStyle.PointSize || 'No Font Size';
            pItems.justification = paraStyle.Justification || 'left';

            const charStyleRanges = Array.from(paraRange.getElementsByTagName('CharacterStyleRange'));

            for (const charRange of charStyleRanges) {
                const charStyleName = charRange.getAttribute('AppliedCharacterStyle');
                const charStyleDef = getCharacterStyle(charStyleName, stylesDOM);

                // Get Properties/AppliedFont from child Properties element if it exists
                let appliedFontFromProps = null;
                const propsElements = charRange.getElementsByTagName('Properties');
                if (propsElements.length > 0) {
                    const appliedFontElements = propsElements[0].getElementsByTagName('AppliedFont');
                    if (appliedFontElements.length > 0) {
                        appliedFontFromProps = appliedFontElements[0].textContent;
                    }
                }

                const contentNodes = Array.from(charRange.childNodes).filter(n => n.tagName === 'Content' || n.tagName === 'Br');

                for (const contentNode of contentNodes) {
                    if (contentNode.tagName === 'Br') {
                        text += '\n';
                        allCharStyles.push(null); // Linebreak has no style
                    } else {
                        const contentText = contentNode.textContent;
                        text += contentText;

                        // Read attributes directly from CharacterStyleRange element, then fall back to style definition, then paragraph style
                        const font = appliedFontFromProps || charRange.getAttribute('AppliedFont') || charStyleDef.AppliedFont || pItems.font;
                        const fill = charRange.getAttribute('FillColor') || charStyleDef.FillColor || pItems.fillColor;
                        const fontStyle = charRange.getAttribute('FontStyle') || charStyleDef.FontStyle || pItems.fontStyle;
                        const fontSize = charRange.getAttribute('PointSize') || charStyleDef.PointSize || pItems.fontSize;
                        const strokeWeight = charRange.getAttribute('StrokeWeight') || charStyleDef.StrokeWeight || 0;
                        const strokeColor = charRange.getAttribute('StrokeColor') || charStyleDef.StrokeColor;
                        const underline = charRange.getAttribute('Underline') || charStyleDef.Underline;
                        const capitalization = charRange.getAttribute('Capitalization') || charStyleDef.Capitalization;
                        const position = charRange.getAttribute('Position') || charStyleDef.Position;

                        const spot = get_spot_color(fill, graphicDOM);
                        const fillColorObj = fill && fill !== 'No Fill' ? get_color(fill, graphicDOM) : "rgb(0, 0, 0)";
                        const strokeColorObj = strokeColor ? get_color(strokeColor, graphicDOM) : "rgb(0, 0, 0)";

                        // Create full style object for this range
                        const rangeStyle = {
                            fontFamily: font,
                            fill: fillColorObj ? fillColorObj.rgb : "rgb(0, 0, 0)",
                            cmyk: fillColorObj ? fillColorObj.cmyk : "[0, 0, 0, 100]",
                            fontStyle: fontStyle,
                            fontSize: fontSize,
                            strokeWeight: strokeWeight,
                            stroke: strokeColorObj ? strokeColorObj.rgb : "rgb(0, 0, 0)",
                            underline: underline === 'true',
                            capitalization: capitalization,
                            position: position,
                            spot: spot
                        };

                        // Store this style for each character in the range
                        for (let i = 0; i < contentText.length; i++) {
                            allCharStyles.push(rangeStyle);
                        }
                    }
                }
            }
        }

        // Determine base style: use first character's style if it exists
        let baseStyle;
        if (allCharStyles.length > 0 && allCharStyles[0] !== null) {
            // Use the first character's style as the base (this represents the document's default styling)
            baseStyle = allCharStyles[0];
        } else {
            // Fallback to paragraph defaults if no character styles exist
            baseStyle = {
                fontFamily: pItems.font,
                fill: pItems.fillColor !== 'No Fill' ? (get_color(pItems.fillColor, graphicDOM) || {}).rgb || "rgb(0, 0, 0)" : "rgb(0, 0, 0)",
                cmyk: pItems.fillColor !== 'No Fill' ? (get_color(pItems.fillColor, graphicDOM) || {}).cmyk || "[0, 0, 0, 100]" : "[0, 0, 0, 100]",
                fontStyle: pItems.fontStyle,
                fontSize: pItems.fontSize,
                strokeWeight: 0,
                stroke: null,
                underline: false,
                capitalization: undefined,
                position: undefined,
                spot: null
            };
        }

        // Build styles object with only characters that differ from base style
        const styles = {};

        for (let i = 0; i < allCharStyles.length; i++) {
            const currentStyle = allCharStyles[i];

            if (currentStyle === null) {
                continue;
            }

            // Compare with base paragraph style to find differences
            const styleChanges = {};

            if (currentStyle.fontFamily !== baseStyle.fontFamily) {
                styleChanges.fontFamily = currentStyle.fontFamily;
            }
            if (currentStyle.fill !== baseStyle.fill || currentStyle.cmyk !== baseStyle.cmyk) {
                if (currentStyle.fill !== baseStyle.fill) {
                    styleChanges.fill = currentStyle.fill;
                }
                if (currentStyle.cmyk !== baseStyle.cmyk) {
                    styleChanges.cmyk = currentStyle.cmyk;
                }
            }
            if (currentStyle.fontStyle !== baseStyle.fontStyle) {
                styleChanges.fontStyle = currentStyle.fontStyle;
            }
            if (currentStyle.fontSize !== baseStyle.fontSize) {
                styleChanges.fontSize = pt_px(currentStyle.fontSize);
            }
            if (currentStyle.strokeWeight !== baseStyle.strokeWeight) {
                styleChanges.strokeWeight = pt_px(currentStyle.strokeWeight);
            }
            if (currentStyle.stroke !== baseStyle.stroke) {
                styleChanges.stroke = currentStyle.stroke;
            }
            if (currentStyle.underline !== baseStyle.underline) {
                styleChanges.underline = currentStyle.underline;
            }
            if (currentStyle.capitalization !== baseStyle.capitalization) {
                styleChanges.capitalization = currentStyle.capitalization;
            }
            if (currentStyle.position !== baseStyle.position) {
                styleChanges.position = currentStyle.position;
            }
            if (currentStyle.spot !== baseStyle.spot) {
                styleChanges.spot = currentStyle.spot;
            }

            // Only add to styles if there are differences
            if (Object.keys(styleChanges).length > 0) {
                styles[i] = styleChanges;
            }
        }

        // Convert styles object to array format only if there are differences
        const stylesArray = Object.keys(styles).length > 0 ? styles : [];


        return {
            text,
            styles: stylesArray,
            font: baseStyle.fontFamily,
            fillColor: baseStyle.fill,
            strokeColor: baseStyle.stroke,
            fontStyle: baseStyle.fontStyle,
            fontSize: baseStyle.fontSize,
            strokeWeight: baseStyle.strokeWeight,
            leading: pItems.leading,
            tracking: pItems.tracking,
            justification: pItems.justification,
            cmyk: baseStyle.cmyk,
            spot: baseStyle.spot,
            underline: baseStyle.underline,
            capitalization: baseStyle.capitalization,
            position: baseStyle.position
        };
    } async function getPolygon(itemElement, stylesDOM, graphicDOM, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);
        const pathPoints = Array.from(itemElement.getElementsByTagName('PathPointType'));

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        const points = pathPoints.map(p => {
            const anchor = p.getAttribute('Anchor').split(' ').map(parseFloat);
            return { x: pt_px(anchor[0]), y: pt_px(anchor[1]) };
        });

        let finalItemTransform = itemTransform;
        if (parent.tagName !== 'Spread') {
            const m1 = matrix(parent.getAttribute('ItemTransform').split(' ').map(parseFloat));
            const m2 = matrix(itemTransform);
            const m = multiply(m1, m2);
            finalItemTransform = (typeof m.toArray === 'function') ? m.toArray().flat() : (Array.isArray(m) ? m.flat() : m);
        }

        const strokeColor = get_color(itemElement.getAttribute('StrokeColor') || objectStyle.StrokeColor, graphicDOM);
        const fillVal = get_color(itemElement.getAttribute('FillColor') || objectStyle.FillColor, graphicDOM);
        const spot = get_spot_color(itemElement.getAttribute('FillColor') || objectStyle.StrokeColor, graphicDOM);

        const strokeWeight = objectStyle.StrokeWeight || itemElement.getAttribute('StrokeWeight') || 0;

        let pageItem = {
            type: 'Polygon',
            transformMatrix: finalItemTransform,
            Name: itemElement.getAttribute('Name'),
            points: points,
            fill: fillVal ? fillVal.rgb : "rgb(0, 0, 0)",
            cmyk: fillVal ? fillVal.cmyk : "[0, 0, 0, 100]",
            strokeWidth: pt_px(strokeWeight),
            stroke: strokeColor ? strokeColor.rgb : "rgb(0, 0, 0)",
        };

        if (spot) {
            pageItem.spot = spot;
        }

        const gradientFill = itemElement.getAttribute('GradientFill') || objectStyle.FillColor;
        if (gradientFill) {
            const gradient = get_gradient(gradientFill, graphicDOM);
            if (gradient) {
                gradient.GradientFillStart = itemElement.getAttribute('GradientFillStart') || objectStyle.GradientFillStart;
                gradient.GradientFillLength = itemElement.getAttribute('GradientFillLength') || objectStyle.GradientFillLength;
                gradient.GradientFillAngle = itemElement.getAttribute('GradientFillAngle') || objectStyle.GradientFillAngle;
                pageItem.gradient = gradient;
            }
        }

        const textPath = itemElement.getElementsByTagName('TextPath')[0];
        if (textPath) {
            const parentStory = textPath.getAttribute('ParentStory');
            const storyData = await get_story_data(parentStory, zip, stylesDOM, graphicDOM, parseXml);
            return {
                ...pageItem,
                type: 'Textbox',
                text: storyData.text,
                styles: storyData.styles,
                ...storyData
            };
        }

        return pageItem;
    }

    async function getGraphicLine(itemElement, stylesDOM, graphicDOM, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);
        const pathPoints = Array.from(itemElement.getElementsByTagName('PathPointType'));

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        const p1 = pathPoints[0].getAttribute('Anchor').split(' ').map(parseFloat);
        const p2 = pathPoints[1].getAttribute('Anchor').split(' ').map(parseFloat);

        let finalItemTransform = itemTransform;
        if (parent.tagName !== 'Spread') {
            const m1 = matrix(parent.getAttribute('ItemTransform').split(' ').map(parseFloat));
            const m2 = matrix(itemTransform);
            const m = multiply(m1, m2);
            finalItemTransform = (typeof m.toArray === 'function') ? m.toArray().flat() : (Array.isArray(m) ? m.flat() : m);
        }

        const strokeColor = get_color(itemElement.getAttribute('StrokeColor') || objectStyle.StrokeColor, graphicDOM);
        const fillVal = get_color(itemElement.getAttribute('FillColor') || objectStyle.FillColor, graphicDOM);
        const spot = get_spot_color(itemElement.getAttribute('FillColor') || objectStyle.StrokeColor, graphicDOM);

        const strokeWeight = objectStyle.StrokeWeight || itemElement.getAttribute('StrokeWeight') || 0;

        let pageItem = {
            type: 'Line',
            transformMatrix: finalItemTransform,
            Name: itemElement.getAttribute('Name'),
            strokeWidth: pt_px(strokeWeight),
            x1: pt_px(p1[0]),
            y1: pt_px(p1[1]),
            x2: pt_px(p2[0]),
            y2: pt_px(p2[1]),
            fill: fillVal ? fillVal.rgb : "rgb(0, 0, 0)",
            cmyk: fillVal ? fillVal.cmyk : "[0, 0, 0, 100]",
            stroke: strokeColor ? strokeColor.rgb : "rgb(0, 0, 0)",
        };

        if (spot) {
            pageItem.spot = spot;
        }

        const gradientFill = itemElement.getAttribute('GradientFill') || objectStyle.FillColor;
        if (gradientFill) {
            const gradient = get_gradient(gradientFill, graphicDOM);
            if (gradient) {
                gradient.GradientFillStart = itemElement.getAttribute('GradientFillStart') || objectStyle.GradientFillStart;
                gradient.GradientFillLength = itemElement.getAttribute('GradientFillLength') || objectStyle.GradientFillLength;
                gradient.GradientFillAngle = itemElement.getAttribute('GradientFillAngle') || objectStyle.GradientFillAngle;
                pageItem.gradient = gradient;
            }
        }

        return pageItem;
    }

    async function getOval(itemElement, stylesDOM, graphicDOM, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);
        const pathPoints = Array.from(itemElement.getElementsByTagName('PathPointType'));

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        const x_values = pathPoints.map(pp => parseFloat(pp.getAttribute('Anchor').split(' ')[0]));
        const y_values = pathPoints.map(pp => parseFloat(pp.getAttribute('Anchor').split(' ')[1]));
        const left = Math.min(...x_values);
        const top = Math.min(...y_values);
        const width = Math.max(...x_values) - left;
        const height = Math.max(...y_values) - top;

        const rx = width / 2;
        const ry = height / 2;

        let finalItemTransform = itemTransform;
        if (parent.tagName !== 'Spread') {
            const m1 = matrix(parent.getAttribute('ItemTransform').split(' ').map(parseFloat));
            const m2 = matrix(itemTransform);
            const m = multiply(m1, m2);
            finalItemTransform = (typeof m.toArray === 'function') ? m.toArray().flat() : (Array.isArray(m) ? m.flat() : m);
        }

        const strokeColor = get_color(itemElement.getAttribute('StrokeColor') || objectStyle.StrokeColor, graphicDOM);
        const fillVal = get_color(itemElement.getAttribute('FillColor') || objectStyle.FillColor, graphicDOM);
        const spot = get_spot_color(itemElement.getAttribute('FillColor') || objectStyle.StrokeColor, graphicDOM);

        const strokeWeight = objectStyle.StrokeWeight || itemElement.getAttribute('StrokeWeight') || 0;

        let pageItem = {
            type: 'Ellipse',
            transformMatrix: finalItemTransform,
            rx: pt_px(rx),
            ry: pt_px(ry),
            Name: itemElement.getAttribute('Name'),
            fill: fillVal ? fillVal.rgb : "rgb(0, 0, 0)",
            cmyk: fillVal ? fillVal.cmyk : "[0, 0, 0, 100]",
            strokeWidth: pt_px(strokeWeight),
            stroke: strokeColor ? strokeColor.rgb : "rgb(0, 0, 0)",
        };

        if (spot) {
            pageItem.spot = spot;
        }

        const gradientFill = itemElement.getAttribute('GradientFill') || objectStyle.FillColor;
        if (gradientFill) {
            const gradient = get_gradient(gradientFill, graphicDOM);
            if (gradient) {
                gradient.GradientFillStart = itemElement.getAttribute('GradientFillStart') || objectStyle.GradientFillStart;
                gradient.GradientFillLength = itemElement.getAttribute('GradientFillLength') || objectStyle.GradientFillLength;
                gradient.GradientFillAngle = itemElement.getAttribute('GradientFillAngle') || objectStyle.GradientFillAngle;
                pageItem.gradient = gradient;
            }
        }

        return pageItem;
    }

    async function getImage(itemElement, stylesDOM, graphicDOM, zip, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);
        const linkElement = itemElement.getElementsByTagName('Link')[0];
        const contentsElement = itemElement.getElementsByTagName('Contents')[0];
        const graphicBoundsElement = itemElement.getElementsByTagName('GraphicBounds')[0];

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        const left = parseFloat(graphicBoundsElement.getAttribute('Left'));
        const right = parseFloat(graphicBoundsElement.getAttribute('Right'));
        const top = parseFloat(graphicBoundsElement.getAttribute('Top'));
        const bottom = parseFloat(graphicBoundsElement.getAttribute('Bottom'));
        const width = right - left;
        const height = bottom - top;

        let finalItemTransform = itemTransform;
        if (parent.tagName !== 'Spread') {
            const m1 = matrix(parent.getAttribute('ItemTransform').split(' ').map(parseFloat));
            const m2 = matrix(itemTransform);
            const m = multiply(m1, m2);
            finalItemTransform = (typeof m.toArray === 'function') ? m.toArray().flat() : (Array.isArray(m) ? m.flat() : m);
        }

        let pageItem = {
            type: 'image',
            transformMatrix: finalItemTransform,
            width: pt_px(width),
            height: pt_px(height),
            Name: itemElement.getAttribute('Name'),
        };

        if (linkElement) {
            const linkResourceURI = linkElement.getAttribute('LinkResourceURI');
            const linkedFileName = linkResourceURI.split('/').pop();
            const linkedFile = zip.file(`Links/${linkedFileName}`);
            if (linkedFile) {
                const buffer = await linkedFile.async('nodebuffer');
                const compressedBuffer = await compress_image(buffer, 'image/jpeg');
                pageItem.url = `data:image/jpeg;base64,${compressedBuffer.toString('base64')}`;
            }
        } else if (contentsElement) {
            const base64Str = contentsElement.textContent;
            const imageData = await convert_base64(false, base64Str);
            if (typeof imageData === 'string' && imageData.startsWith('Error')) {
                pageItem.error = imageData;
                pageItem.type = 'rect';
                pageItem.fill = 'rgb(211,211,211)';
            } else {
                pageItem.url = `data:image/jpeg;base64,${imageData}`;
            }
        }

        return pageItem;
    }

    async function getEps(itemElement, stylesDOM, graphicDOM, zip, parent) {
        return getImage(itemElement, stylesDOM, graphicDOM, zip, parent);
    }

    async function getSvg(itemElement, stylesDOM, graphicDOM, zip, parent) {
        return getImage(itemElement, stylesDOM, graphicDOM, zip, parent);
    }

    async function getGroup(itemElement, stylesDOM, graphicDOM, zip, parseXml, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        let finalItemTransform = itemTransform;
        if (parent.tagName !== 'Spread') {
            const m1 = matrix(parent.getAttribute('ItemTransform').split(' ').map(parseFloat));
            const m2 = matrix(itemTransform);
            const m = multiply(m1, m2);
            finalItemTransform = (typeof m.toArray === 'function') ? m.toArray().flat() : (Array.isArray(m) ? m.flat() : m);
        }

        const objects = [];
        const children = Array.from(itemElement.childNodes).filter(n => n.nodeType === 1);

        for (const childElement of children) {
            let processedChild = await processPageItem(childElement, stylesDOM, graphicDOM, zip, parseXml, itemElement);
            if (processedChild) {
                objects.push(processedChild);
            }
        }

        let pageItem = {
            type: 'group',
            transformMatrix: finalItemTransform,
            Name: itemElement.getAttribute('Name'),
            StrokeWeight: itemElement.getAttribute('StrokeWeight'),
            StrokeColor: itemElement.getAttribute('StrokeColor'),
            objects: objects
        };

        return pageItem;
    }

    for (const spreadPath of spreadPaths) {
        const spreadDOM = await parseXml(spreadPath);
        const spreadElement = spreadDOM.getElementsByTagName('Spread')[0];

        if (!spreadElement) {
            console.warn(`No Spread element found in ${spreadPath}`);
            continue;
        }

        const pageElements = Array.from(spreadElement.getElementsByTagName('Page'));

        for (const pageElement of pageElements) {
            const page = {
                id: pageElement.getAttribute('Self'),
                objects: [], // Changed from 'items' to 'objects' to match Python
                pageData: {
                    fWidth: documentData.fWidth,
                    fHeight: documentData.fHeight,
                    bleed: documentData.bleed,
                    margin: documentData.margin,
                    originX: documentData.originX,
                    originY: documentData.originY,
                    title: pageElement.getAttribute('Self')
                }
            };

            // Get all direct children of the Spread element, excluding Page elements
            const pageItems = Array.from(spreadElement.childNodes).filter(n =>
                n.nodeType === 1 && n.tagName !== 'Page' && n.tagName !== 'FlattenerPreference'
            );

            for (const itemElement of pageItems) {
                let processedItem = await processPageItem(itemElement, stylesDOM, graphicDOM, zip, parseXml, spreadElement);
                if (processedItem) {
                    page.objects.push(processedItem);
                }
            }

            pages.push(page);
        }
    }

    // Collect used fonts and images from pages
    const usedFonts = new Set();
    const imageAssets = [];

    for (const page of pages) {
        for (const obj of page.objects) {
            // Collect fonts from textboxes
            if (obj.type === 'Textbox' && obj.fontFamily) {
                usedFonts.add(obj.fontFamily);
                console.log('Found font:', obj.fontFamily);
            }
            // Collect images
            if (obj.type === 'image' && obj.url) {
                console.log('Found image:', obj.Name);
                imageAssets.push({
                    type: 'image',
                    id: `image-${obj.Name || 'unnamed'}`,
                    url: obj.url,
                    name: obj.Name
                });
            }
            // Check nested objects in groups
            if (obj.objects && Array.isArray(obj.objects)) {
                const collectFromGroup = (objects) => {
                    for (const child of objects) {
                        if (child.type === 'Textbox' && child.fontFamily) {
                            usedFonts.add(child.fontFamily);
                        }
                        if (child.type === 'image' && child.url) {
                            imageAssets.push({
                                type: 'image',
                                id: `image-${child.Name || 'unnamed'}`,
                                url: child.url,
                                name: child.Name
                            });
                        }
                        if (child.objects && Array.isArray(child.objects)) {
                            collectFromGroup(child.objects);
                        }
                    }
                };
                collectFromGroup(obj.objects);
            }
        }
    }

    const finalJson = {
        designId: 'Generated-by-Node',
        title: 'IDML-Node-Conversion',
        assets: [],
        pages: pages,
        documentData: documentData
    };

    // Add image assets
    finalJson.assets.push(...imageAssets);

    // Extract font files for used fonts only
    const fontFamilies = Array.from(designmapDOM.getElementsByTagName('FontFamily'))
        .filter(font => usedFonts.has(font.getAttribute('Name')))
        .map(font => {
            return {
                type: 'font',
                name: font.getAttribute('Name'),
                fontStyles: Array.from(font.getElementsByTagName('FontStyle')).map(fs => fs.getAttribute('Name'))
            };
        });

    for (const font of fontFamilies) {
        const fontName = font.name.replace(/\s/g, '').replace(/\-/g, '').toLowerCase();
        const fontFiles = Object.keys(zip.files).filter(fileName =>
            fileName.startsWith('Document Fonts/') &&
            fileName.toLowerCase().includes(fontName) &&
            !fileName.endsWith('.lst')
        );

        for (const fontFile of fontFiles) {
            const fontBuffer = await zip.file(fontFile).async('nodebuffer');
            const fontBase64 = fontBuffer.toString('base64');
            const fontUrl = `data:font/opentype;base64,${fontBase64}`;
            finalJson.assets.push({
                type: 'font',
                id: `font-${font.name}`,
                name: font.name,
                url: fontUrl,
                fontStyles: font.fontStyles
            });
        }
    }

    return finalJson;
}

module.exports = { processIdml };