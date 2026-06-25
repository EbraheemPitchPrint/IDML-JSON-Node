const fs = require('fs');
const crypto = require('crypto');
const JSZip = require('jszip');
const { DOMParser } = require('xmldom');
const { get_color, get_spot_color, get_gradient, COLOR_CONVERSION_POLICY } = require('./colorOps.js');
const { is_svg, compress_image, convert_base64 } = require('./imageOps.js');
const { applyCharStyles, getCharacterStyle, clearCharacterStyleCache } = require('./characterStyles.js');
const { applyParaStyles, getParagraphStyle, clearParagraphStyleCache } = require('./paragraphStyles.js');
const { applyObjStyles, clearObjectStyleCache } = require('./objectStyles.js');
const { pt_px, multiplyAffineMatrices, decomposeTransform } = require('./utils.js');

/**
 * Processes an IDML file and extracts its content into a JSON structure.
 * @param {string} filePath - The path to the IDML file.
 * @returns {Promise<Object>} A promise that resolves with the JSON representation of the IDML document.
 */
async function processIdml(filePath) {
    console.log('Starting IDML processing...');
    const diagnostics = [];

    // Clear style caches between files to avoid cross-contamination
    clearParagraphStyleCache();
    clearCharacterStyleCache();
    clearObjectStyleCache();

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
        } else if (tagName === 'SplineItem') {
            processedItem = await getSplineItem(itemElement, stylesDOM, graphicDOM, zip, parseXml, parent);
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

    /**
     * Resolves a shape property: inline value takes priority over object style value.
     * Returns null if the resolved value is Swatch/None (transparent).
     */
    function resolveShapeAttr(itemElement, objectStyle, attrName) {
        const inline = itemElement.getAttribute(attrName);
        // inline takes priority when present
        if (inline !== null && inline !== '') return inline;
        return objectStyle[attrName] || null;
    }

    function shouldMultiplyParentTransform(parent) {
        return parent && parent.tagName !== 'Spread' && parent.tagName !== 'Group';
    }

    function toStrokeLineCap(value) {
        if (!value) return 'butt';
        const normalized = value.toLowerCase();
        if (normalized.includes('round')) return 'round';
        if (normalized.includes('project') || normalized.includes('square')) return 'square';
        return 'butt';
    }

    function toStrokeLineJoin(value) {
        if (!value) return 'miter';
        const normalized = value.toLowerCase();
        if (normalized.includes('round')) return 'round';
        if (normalized.includes('bevel')) return 'bevel';
        return 'miter';
    }

    function toStrokeAlignment(value) {
        if (!value) return 'center';
        const normalized = value.toLowerCase();
        if (normalized.includes('inside')) return 'inside';
        if (normalized.includes('outside')) return 'outside';
        return 'center';
    }

    function parseDashArray(value) {
        if (!value) return null;
        const numbers = value
            .split(/[\s,]+/)
            .map(v => parseFloat(v))
            .filter(v => Number.isFinite(v) && v > 0)
            .map(pt_px);

        return numbers.length > 0 ? numbers : null;
    }

    function parsePointPair(value) {
        if (!value) return [0, 0];
        const parts = value.split(/\s+/).map(parseFloat);
        const x = Number.isFinite(parts[0]) ? parts[0] : 0;
        const y = Number.isFinite(parts[1]) ? parts[1] : 0;
        return [x, y];
    }

    function parseNumber(value, fallback = 0) {
        const parsed = parseFloat(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function parseBool(value, fallback = false) {
        if (value === null || value === undefined || value === '') return fallback;
        if (typeof value === 'boolean') return value;
        const normalized = String(value).trim().toLowerCase();
        if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
        if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
        return fallback;
    }

    function clamp01(value) {
        return Math.max(0, Math.min(1, value));
    }

    function parseOpacityPercent(value, fallback = null) {
        if (value === null || value === undefined || value === '') return fallback;
        const parsed = parseFloat(value);
        if (!Number.isFinite(parsed)) return fallback;
        return clamp01(parsed / 100);
    }

    function resolveBlendMode(value) {
        if (!value) return null;
        const normalized = value.toLowerCase().replace(/[^a-z]/g, '');
        const map = {
            normal: 'source-over',
            multiply: 'multiply',
            screen: 'screen',
            overlay: 'overlay',
            darken: 'darken',
            lighten: 'lighten',
            colordodge: 'color-dodge',
            colorburn: 'color-burn',
            hardlight: 'hard-light',
            softlight: 'soft-light',
            difference: 'difference',
            exclusion: 'exclusion',
            hue: 'hue',
            saturation: 'saturation',
            color: 'color',
            luminosity: 'luminosity'
        };
        return map[normalized] || 'source-over';
    }

    function addWarning(code, message, context = {}) {
        diagnostics.push({
            level: 'warning',
            code,
            message,
            context
        });
    }

    function applyOpacityAndBlend(pageItem, itemElement, objectStyle) {
        const transparencySettings = itemElement.getElementsByTagName('TransparencySetting')[0];
        const blendingSettings = transparencySettings ? transparencySettings.getElementsByTagName('BlendingSetting')[0] : null;

        const opacity = parseOpacityPercent(
            blendingSettings ? blendingSettings.getAttribute('Opacity') : resolveShapeAttr(itemElement, objectStyle, 'Opacity')
        );
        if (opacity !== null) {
            pageItem.opacity = opacity;
        }

        const blendMode =
            (blendingSettings && (blendingSettings.getAttribute('BlendMode') || blendingSettings.getAttribute('Mode'))) ||
            resolveShapeAttr(itemElement, objectStyle, 'BlendMode') ||
            resolveShapeAttr(itemElement, objectStyle, 'TransparencyBlendSpace');

        if (blendMode) {
            pageItem.idmlBlendMode = blendMode;
            pageItem.globalCompositeOperation = resolveBlendMode(blendMode);
        }
    }

    function applyOverprintFallback(pageItem, itemElement, objectStyle) {
        const overprintFill = parseBool(
            resolveShapeAttr(itemElement, objectStyle, 'OverprintFill') || resolveShapeAttr(itemElement, objectStyle, 'FillOverprint')
        );
        const overprintStroke = parseBool(
            resolveShapeAttr(itemElement, objectStyle, 'OverprintStroke') || resolveShapeAttr(itemElement, objectStyle, 'StrokeOverprint')
        );

        if (overprintFill || overprintStroke) {
            pageItem.idmlOverprint = {
                fill: overprintFill,
                stroke: overprintStroke,
                supported: false,
                fallback: 'ignored'
            };

            addWarning(
                'OVERPRINT_UNSUPPORTED',
                'Overprint is not directly supported in Fabric.js output and was ignored.',
                {
                    objectName: pageItem.Name || itemElement.getAttribute('Self') || null,
                    fill: overprintFill,
                    stroke: overprintStroke
                }
            );
        }
    }

    function getSwatchGradientRef(colorRef, graphicDOM) {
        if (!colorRef || !graphicDOM || !/^Swatch\//.test(colorRef)) return null;
        const swatches = graphicDOM.getElementsByTagName('Swatch');
        for (let i = 0; i < swatches.length; i++) {
            const swatch = swatches[i];
            if (swatch.getAttribute('Self') !== colorRef) continue;
            const gradientRef = swatch.getAttribute('Color');
            return gradientRef && /^Gradient\//.test(gradientRef) ? gradientRef : null;
        }
        return null;
    }

    function getDefaultGradientRef(graphicDOM) {
        if (!graphicDOM) return null;
        const gradients = graphicDOM.getElementsByTagName('Gradient');
        if (!gradients || gradients.length === 0) return null;
        return gradients[0].getAttribute('Self') || null;
    }

    function resolveGradientRef(itemElement, objectStyle, graphicDOM, mode) {
        const isFill = mode === 'fill';
        const colorAttr = isFill ? 'FillColor' : 'StrokeColor';
        const explicitGradientAttr = isFill ? 'GradientFill' : 'GradientStroke';

        const colorRef = resolveShapeAttr(itemElement, objectStyle, colorAttr);
        if (colorRef && /^Gradient\//.test(colorRef)) return colorRef;

        const explicitRef = resolveShapeAttr(itemElement, objectStyle, explicitGradientAttr);
        if (explicitRef && /^Gradient\//.test(explicitRef)) return explicitRef;

        const swatchGradientRef = getSwatchGradientRef(colorRef, graphicDOM);
        if (swatchGradientRef) return swatchGradientRef;

        // If an explicit non-gradient color is set, keep solid color behavior.
        if (colorRef && colorRef !== 'Swatch/None') {
            return null;
        }

        const start = resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillStart' : 'GradientStrokeStart');
        const length = parseNumber(resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillLength' : 'GradientStrokeLength'), 0);
        const angle = parseNumber(resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillAngle' : 'GradientStrokeAngle'), 0);
        const hiliteLength = parseNumber(resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillHiliteLength' : 'GradientStrokeHiliteLength'), 0);
        const hiliteAngle = parseNumber(resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillHiliteAngle' : 'GradientStrokeHiliteAngle'), 0);
        const [startX, startY] = parsePointPair(start);

        const hasGradientGeometry =
            Math.abs(startX) > 0.0001 ||
            Math.abs(startY) > 0.0001 ||
            length > 0.0001 ||
            Math.abs(angle) > 0.0001 ||
            hiliteLength > 0.0001 ||
            Math.abs(hiliteAngle) > 0.0001;

        if (hasGradientGeometry) {
            return getDefaultGradientRef(graphicDOM);
        }

        return null;
    }

    function normalizeGradientStops(stops) {
        if (!Array.isArray(stops) || stops.length === 0) {
            return [
                { offset: 0, color: 'rgb(0, 0, 0)', opacity: 1 },
                { offset: 1, color: 'rgb(255, 255, 255)', opacity: 1 }
            ];
        }

        const mapped = stops.map((stop, index) => {
            const rawLocation = parseNumber(stop.location, index === 0 ? 0 : 100);
            const normalizedOffset = rawLocation > 1 ? rawLocation / 100 : rawLocation;
            const offset = Math.max(0, Math.min(1, normalizedOffset));
            return {
                offset,
                color: stop.stopColorRGB || 'rgb(0, 0, 0)',
                opacity: 1
            };
        });

        return mapped.sort((a, b) => a.offset - b.offset);
    }

    function buildFabricGradient(gradientData, itemElement, objectStyle, mode) {
        if (!gradientData) return null;

        const isFill = mode === 'fill';
        const startAttr = resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillStart' : 'GradientStrokeStart');
        const lengthAttr = resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillLength' : 'GradientStrokeLength');
        const angleAttr = resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillAngle' : 'GradientStrokeAngle');
        const hiliteLengthAttr = resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillHiliteLength' : 'GradientStrokeHiliteLength');
        const hiliteAngleAttr = resolveShapeAttr(itemElement, objectStyle, isFill ? 'GradientFillHiliteAngle' : 'GradientStrokeHiliteAngle');

        const [startXPt, startYPt] = parsePointPair(startAttr);
        const lengthPt = parseNumber(lengthAttr, 0);
        const angleDeg = parseNumber(angleAttr, 0);
        const angleRad = (angleDeg * Math.PI) / 180;

        const x1 = pt_px(startXPt);
        const y1 = pt_px(startYPt);
        const x2 = pt_px(startXPt + (lengthPt * Math.cos(angleRad)));
        const y2 = pt_px(startYPt + (lengthPt * Math.sin(angleRad)));

        const gradientType = (gradientData.type || '').toLowerCase().includes('radial') ? 'radial' : 'linear';
        const colorStops = normalizeGradientStops(gradientData.stops);

        if (gradientType === 'radial') {
            const hlLengthPt = parseNumber(hiliteLengthAttr, 0);
            const hlAngleDeg = parseNumber(hiliteAngleAttr, angleDeg);
            const hlAngleRad = (hlAngleDeg * Math.PI) / 180;
            const fxPt = startXPt + (hlLengthPt * Math.cos(hlAngleRad));
            const fyPt = startYPt + (hlLengthPt * Math.sin(hlAngleRad));

            return {
                type: 'radial',
                gradientUnits: 'pixels',
                coords: {
                    x1: pt_px(fxPt),
                    y1: pt_px(fyPt),
                    r1: 0,
                    x2: x1,
                    y2: y1,
                    r2: pt_px(Math.max(lengthPt, 1))
                },
                colorStops
            };
        }

        return {
            type: 'linear',
            gradientUnits: 'pixels',
            coords: { x1, y1, x2, y2 },
            colorStops
        };
    }

    /**
     * Resolves fill/stroke colors for a shape, handling Swatch/None as transparent.
     */
    function resolveShapeColors(itemElement, objectStyle, graphicDOM) {
        const fillRef = resolveShapeAttr(itemElement, objectStyle, 'FillColor');
        const strokeRef = resolveShapeAttr(itemElement, objectStyle, 'StrokeColor');
        const isNoneFill = !fillRef || fillRef === 'Swatch/None';
        const isNoneStroke = !strokeRef || strokeRef === 'Swatch/None';

        const fillVal = isNoneFill ? null : get_color(fillRef, graphicDOM);
        const strokeColor = isNoneStroke ? null : get_color(strokeRef, graphicDOM);
        const spot = isNoneFill ? null : get_spot_color(fillRef, graphicDOM);

        // StrokeWeight: inline (including "0") takes priority over object style
        const inlineSW = itemElement.getAttribute('StrokeWeight');
        const strokeWeight = parseFloat(inlineSW !== null && inlineSW !== '' ? inlineSW : (objectStyle.StrokeWeight || 0));

        const parseCornerRadius = (value) => {
            if (value === null || value === undefined || value === '') return 0;
            const parsed = parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
        };

        const cornerOptionDefault = resolveShapeAttr(itemElement, objectStyle, 'CornerOption') || 'None';
        const cornerRadiusDefault = resolveShapeAttr(itemElement, objectStyle, 'CornerRadius') || resolveShapeAttr(itemElement, objectStyle, 'TopLeftCornerRadius') || '0';

        const cornerOptions = {
            topLeft: resolveShapeAttr(itemElement, objectStyle, 'TopLeftCornerOption') || cornerOptionDefault,
            topRight: resolveShapeAttr(itemElement, objectStyle, 'TopRightCornerOption') || cornerOptionDefault,
            bottomRight: resolveShapeAttr(itemElement, objectStyle, 'BottomRightCornerOption') || cornerOptionDefault,
            bottomLeft: resolveShapeAttr(itemElement, objectStyle, 'BottomLeftCornerOption') || cornerOptionDefault,
        };

        const cornerRadiiPt = {
            topLeft: parseCornerRadius(resolveShapeAttr(itemElement, objectStyle, 'TopLeftCornerRadius') || cornerRadiusDefault),
            topRight: parseCornerRadius(resolveShapeAttr(itemElement, objectStyle, 'TopRightCornerRadius') || cornerRadiusDefault),
            bottomRight: parseCornerRadius(resolveShapeAttr(itemElement, objectStyle, 'BottomRightCornerRadius') || cornerRadiusDefault),
            bottomLeft: parseCornerRadius(resolveShapeAttr(itemElement, objectStyle, 'BottomLeftCornerRadius') || cornerRadiusDefault),
        };

        const roundedFlags = {
            topLeft: /rounded/i.test(cornerOptions.topLeft),
            topRight: /rounded/i.test(cornerOptions.topRight),
            bottomRight: /rounded/i.test(cornerOptions.bottomRight),
            bottomLeft: /rounded/i.test(cornerOptions.bottomLeft),
        };

        const roundedRadii = [
            roundedFlags.topLeft ? cornerRadiiPt.topLeft : 0,
            roundedFlags.topRight ? cornerRadiiPt.topRight : 0,
            roundedFlags.bottomRight ? cornerRadiiPt.bottomRight : 0,
            roundedFlags.bottomLeft ? cornerRadiiPt.bottomLeft : 0,
        ];

        const allRounded = roundedFlags.topLeft && roundedFlags.topRight && roundedFlags.bottomRight && roundedFlags.bottomLeft;
        const sameRoundedRadius = allRounded && roundedRadii.every(r => Math.abs(r - roundedRadii[0]) < 0.0001);
        const uniformRoundedRadiusPt = sameRoundedRadius ? roundedRadii[0] : 0;

        const cornerOptionValues = Object.values(cornerOptions);
        const cornerRadiusValues = Object.values(cornerRadiiPt);
        const hasCornerStyling = cornerOptionValues.some(v => v && !/^none$/i.test(v)) || cornerRadiusValues.some(v => v > 0);
        const hasMixedCornerStyling =
            new Set(cornerOptionValues).size > 1 ||
            new Set(cornerRadiusValues.map(v => Number(v.toFixed(4)))).size > 1;

        return {
            fillVal,
            strokeColor,
            spot,
            strokeWeight,
            isNoneFill,
            uniformRoundedRadiusPt,
            cornerOptions,
            cornerRadiiPt,
            hasCornerStyling,
            hasMixedCornerStyling
        };
    }

    /**
     * Adds common shape properties (fill, stroke, opacity, gradient, corner radius, spot).
     */
    function applyShapeStyles(pageItem, itemElement, objectStyle, graphicDOM, shapeColors) {
        const {
            fillVal,
            strokeColor,
            spot,
            strokeWeight,
            isNoneFill,
            uniformRoundedRadiusPt,
            cornerOptions,
            cornerRadiiPt,
            hasCornerStyling,
            hasMixedCornerStyling
        } = shapeColors;

        // Fill
        if (isNoneFill) {
            pageItem.fill = 'transparent';
        } else {
            pageItem.fill = fillVal ? fillVal.rgb : "rgb(0, 0, 0)";
            pageItem.cmyk = fillVal ? fillVal.cmyk : "[0, 0, 0, 100]";
        }

        // Stroke (only if weight > 0 and not Swatch/None)
        if (strokeWeight > 0 && strokeColor) {
            pageItem.strokeWidth = pt_px(strokeWeight);
            pageItem.stroke = strokeColor.rgb;

            const strokeCap = resolveShapeAttr(itemElement, objectStyle, 'EndCap') ||
                resolveShapeAttr(itemElement, objectStyle, 'StrokeEndCap');
            const strokeJoin = resolveShapeAttr(itemElement, objectStyle, 'JoinType') ||
                resolveShapeAttr(itemElement, objectStyle, 'StrokeJoin');
            const strokeMiterLimit = parseFloat(resolveShapeAttr(itemElement, objectStyle, 'MiterLimit') || '10');
            const strokeDashAndGap = resolveShapeAttr(itemElement, objectStyle, 'StrokeDashAndGap') ||
                resolveShapeAttr(itemElement, objectStyle, 'StrokeDashArray') ||
                resolveShapeAttr(itemElement, objectStyle, 'DashAndGap');
            const strokeAlignment = resolveShapeAttr(itemElement, objectStyle, 'StrokeAlignment');
            const strokeType = resolveShapeAttr(itemElement, objectStyle, 'StrokeType');

            pageItem.strokeLineCap = toStrokeLineCap(strokeCap);
            pageItem.strokeLineJoin = toStrokeLineJoin(strokeJoin);

            if (Number.isFinite(strokeMiterLimit) && strokeMiterLimit > 0) {
                pageItem.strokeMiterLimit = strokeMiterLimit;
            }

            const dashArray = parseDashArray(strokeDashAndGap);
            if (dashArray) {
                pageItem.strokeDashArray = dashArray;
            }

            if (strokeAlignment) {
                pageItem.strokeAlignment = toStrokeAlignment(strokeAlignment);
                pageItem.idmlStrokeAlignment = strokeAlignment;
            }

            if (strokeType) {
                pageItem.idmlStrokeType = strokeType;
            }
        }

        // Spot color
        if (spot) {
            pageItem.spot = spot;
        }

        // Corner radius/types (rectangles only)
        if (pageItem.type === 'rect') {
            if (uniformRoundedRadiusPt > 0) {
                pageItem.rx = pt_px(uniformRoundedRadiusPt);
                pageItem.ry = pt_px(uniformRoundedRadiusPt);
            }

            if (hasCornerStyling) {
                pageItem.cornerOptions = cornerOptions;
                pageItem.cornerRadii = {
                    topLeft: pt_px(cornerRadiiPt.topLeft),
                    topRight: pt_px(cornerRadiiPt.topRight),
                    bottomRight: pt_px(cornerRadiiPt.bottomRight),
                    bottomLeft: pt_px(cornerRadiiPt.bottomLeft),
                };
                if (hasMixedCornerStyling) {
                    pageItem.hasMixedCorners = true;
                }
            }
        }

        applyOpacityAndBlend(pageItem, itemElement, objectStyle);
        applyOverprintFallback(pageItem, itemElement, objectStyle);

        // Gradient fill
        const gradientFillRef = resolveGradientRef(itemElement, objectStyle, graphicDOM, 'fill');
        if (gradientFillRef && gradientFillRef !== 'Swatch/None') {
            const gradient = get_gradient(gradientFillRef, graphicDOM);
            if (gradient) {
                const legacyGradient = {
                    ...gradient,
                    GradientFillStart: resolveShapeAttr(itemElement, objectStyle, 'GradientFillStart'),
                    GradientFillLength: resolveShapeAttr(itemElement, objectStyle, 'GradientFillLength'),
                    GradientFillAngle: resolveShapeAttr(itemElement, objectStyle, 'GradientFillAngle')
                };
                pageItem.gradient = legacyGradient;

                const fabricFillGradient = buildFabricGradient(gradient, itemElement, objectStyle, 'fill');
                if (fabricFillGradient) {
                    pageItem.fill = fabricFillGradient;
                    pageItem.fillGradient = fabricFillGradient;
                }
            }
        }

        if (pageItem.strokeWidth > 0) {
            const gradientStrokeRef = resolveGradientRef(itemElement, objectStyle, graphicDOM, 'stroke');
            if (gradientStrokeRef && gradientStrokeRef !== 'Swatch/None') {
                const strokeGradient = get_gradient(gradientStrokeRef, graphicDOM);
                if (strokeGradient) {
                    const fabricStrokeGradient = buildFabricGradient(strokeGradient, itemElement, objectStyle, 'stroke');
                    if (fabricStrokeGradient) {
                        pageItem.stroke = fabricStrokeGradient;
                        pageItem.strokeGradient = fabricStrokeGradient;
                    }
                }
            }
        }

        return pageItem;
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

        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        // Decompose transform: topLeft is the local origin in points
        const decomposed = decomposeTransform(finalItemTransform, topLeft[0], topLeft[1]);

        const shapeColors = resolveShapeColors(itemElement, objectStyle, graphicDOM);

        let pageItem = {
            type: 'rect',
            left: decomposed.left,
            top: decomposed.top,
            originX: 'left',
            originY: 'top',
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
            width: pt_px(width),
            height: pt_px(height),
            Name: itemElement.getAttribute('Name'),
        };

        applyShapeStyles(pageItem, itemElement, objectStyle, graphicDOM, shapeColors);

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

        const parsedLeading = parseFloat(leading);
        let finalLineHeight = 1.13;
        if (leading !== 'Auto' && leading && !Number.isNaN(parsedLeading) && parsedLeading > 0) {
            if (parsedLeading > 3 && finalFontSize > 0) {
                finalLineHeight = Number((parsedLeading / finalFontSize).toFixed(3));
            } else {
                finalLineHeight = parsedLeading;
            }
        }
        const parseTrackingValue = (value) => {
            if (value === 'No Tracking' || value === null || value === undefined || value === '') {
                return 0;
            }
            const parsed = parseFloat(value);
            return Number.isFinite(parsed) ? parsed : 0;
        };

        const finalTextAlign = justification === 'CenterAlign' || justification === 'CenterJustified' ? 'center' : justification === 'RightAlign' ? 'right' : 'left';
        const finalFontWeight = fontStyle ? (fontStyle.includes('Black') ? 'Bold' : fontStyle === 'No Font Style' ? 'Regular' : fontStyle) : 'Regular';
        const finalCapitalization = capitalization === 'AllCaps';

        const newLineCount = (text.match(/\n/g) || []).length + 1;
        const trueHeight = (pt_px(finalFontSize) * newLineCount) * finalLineHeight;
        const padding = height > trueHeight ? (height - trueHeight) / 2 : 0;

        // fillColor and strokeColor are already RGB strings from storyData, no need to convert again

        // Apply parent chaining for TextFrame too
        let finalItemTransform = itemTransform;
        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        // Decompose transform: topLeft is the local origin in points
        const decomposed = decomposeTransform(finalItemTransform, topLeft[0], topLeft[1]);

        let pageItem = {
            type: 'Textbox',
            left: decomposed.left,
            top: decomposed.top,
            originX: 'left',
            originY: 'top',
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
            width: pt_px(width),
            height: pt_px(height),
            Name: itemElement.getAttribute('Name'),
            text: finalCapitalization ? text.toUpperCase() : text,
            textAlign: finalTextAlign,
            parent_story: parentStory,
            shadow: dropShadowSettings,
            fontWeight: finalFontWeight,
            fontSize: pt_px(finalFontSize),
            lineHeight: finalLineHeight,
            charSpacing: parseTrackingValue(tracking),
            fill: fillColor,
            cmyk: cmyk,
            fontFamily: finalFontFamily,
            padding: padding,
            styles: styles,
            VerticalJustification: verticalJustification,
        };

        if (spot) {
            pageItem.spot = spot;
        }

        applyOpacityAndBlend(pageItem, itemElement, objectStyle);
        applyOverprintFallback(pageItem, itemElement, objectStyle);

        const gradientFillRef = resolveGradientRef(itemElement, objectStyle, graphicDOM, 'fill');
        if (gradientFillRef && gradientFillRef !== 'Swatch/None') {
            const gradient = get_gradient(gradientFillRef, graphicDOM);
            if (gradient) {
                const legacyGradient = {
                    ...gradient,
                    GradientFillStart: resolveShapeAttr(itemElement, objectStyle, 'GradientFillStart'),
                    GradientFillLength: resolveShapeAttr(itemElement, objectStyle, 'GradientFillLength'),
                    GradientFillAngle: resolveShapeAttr(itemElement, objectStyle, 'GradientFillAngle')
                };
                pageItem.gradient = legacyGradient;

                const fabricGradient = buildFabricGradient(gradient, itemElement, objectStyle, 'fill');
                if (fabricGradient) {
                    pageItem.fill = fabricGradient;
                    pageItem.fillGradient = fabricGradient;
                }
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

        const paragraphStyleRanges = Array.from(storyRoot.getElementsByTagName('ParagraphStyleRange'));

        for (const paraRange of paragraphStyleRanges) {
            const paraStyleName = paraRange.getAttribute('AppliedParagraphStyle');
            const paraStyle = getParagraphStyle(paraStyleName, stylesDOM);

            // Read inline overrides on the ParagraphStyleRange element itself
            // These override anything from the paragraph style definition
            const paraInlineFont = null; // Font is always in Properties/AppliedFont
            let paraInlineFontFromProps = null;
            const paraPropsElements = paraRange.getElementsByTagName('Properties');
            if (paraPropsElements.length > 0) {
                const paraAppliedFontEls = paraPropsElements[0].getElementsByTagName('AppliedFont');
                if (paraAppliedFontEls.length > 0) {
                    paraInlineFontFromProps = paraAppliedFontEls[0].textContent;
                }
            }

            // Cascade: inline para override > paragraph style definition
            // These are the "paragraph-level" resolved values
            const paraFont = paraInlineFontFromProps || paraStyle.AppliedFont || 'Minion Pro';
            const paraLeading = paraRange.getAttribute('Leading') || paraStyle.Leading || 'Auto';
            const paraTracking = paraRange.getAttribute('Tracking') || paraStyle.Tracking || '0';
            const paraFillColor = paraRange.getAttribute('FillColor') || paraStyle.FillColor || 'Color/Black';
            const paraFontWeight = paraRange.getAttribute('FontStyle') || paraStyle.FontStyle || 'Regular';
            const paraFontSize = paraRange.getAttribute('PointSize') || paraStyle.PointSize || '12';
            const paraJustification = paraRange.getAttribute('Justification') || paraStyle.Justification || 'LeftAlign';
            const paraStrokeWeight = paraRange.getAttribute('StrokeWeight') || paraStyle.StrokeWeight || '0';
            const paraStrokeColor = paraRange.getAttribute('StrokeColor') || paraStyle.StrokeColor || null;
            const paraCapitalization = paraRange.getAttribute('Capitalization') || paraStyle.Capitalization || 'Normal';
            const paraUnderline = paraRange.getAttribute('Underline') || paraStyle.Underline || 'false';
            const paraPosition = paraRange.getAttribute('Position') || paraStyle.Position || 'Normal';

            // Store resolved paragraph values for this range
            pItems = {
                font: paraFont,
                leading: paraLeading,
                tracking: paraTracking,
                fillColor: paraFillColor,
                fontWeight: paraFontWeight,
                fontSize: paraFontSize,
                justification: paraJustification,
                strokeWeight: paraStrokeWeight,
                strokeColor: paraStrokeColor,
                capitalization: paraCapitalization,
                underline: paraUnderline,
                position: paraPosition
            };

            const charStyleRanges = Array.from(paraRange.getElementsByTagName('CharacterStyleRange'));

            for (const charRange of charStyleRanges) {
                const charStyleName = charRange.getAttribute('AppliedCharacterStyle');
                const charStyleDef = getCharacterStyle(charStyleName, stylesDOM);

                // Get Properties/AppliedFont from child Properties element on charRange
                let charInlineFontFromProps = null;
                const charPropsElements = charRange.getElementsByTagName('Properties');
                if (charPropsElements.length > 0) {
                    const appliedFontElements = charPropsElements[0].getElementsByTagName('AppliedFont');
                    if (appliedFontElements.length > 0) {
                        charInlineFontFromProps = appliedFontElements[0].textContent;
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

                        // Full cascade: inline charRange attr > charStyle def > paragraph resolved
                        const font = charInlineFontFromProps || charStyleDef.AppliedFont || pItems.font;
                        const fill = charRange.getAttribute('FillColor') || charStyleDef.FillColor || pItems.fillColor;
                        const fontWeight = charRange.getAttribute('FontStyle') || charStyleDef.FontStyle || pItems.fontWeight;
                        const fontSize = charRange.getAttribute('PointSize') || charStyleDef.PointSize || pItems.fontSize;
                        const strokeWeight = charRange.getAttribute('StrokeWeight') || charStyleDef.StrokeWeight || pItems.strokeWeight;
                        const tracking = charRange.getAttribute('Tracking') || charStyleDef.Tracking || pItems.tracking;
                        const strokeColor = charRange.getAttribute('StrokeColor') || charStyleDef.StrokeColor || pItems.strokeColor;
                        const underline = charRange.getAttribute('Underline') || charStyleDef.Underline || pItems.underline;
                        const capitalization = charRange.getAttribute('Capitalization') || charStyleDef.Capitalization || pItems.capitalization;
                        const position = charRange.getAttribute('Position') || charStyleDef.Position || pItems.position;

                        const spot = get_spot_color(fill, graphicDOM);
                        const fillColorObj = fill ? get_color(fill, graphicDOM) : null;
                        const strokeColorObj = strokeColor ? get_color(strokeColor, graphicDOM) : null;

                        // Create full style object for this range
                        const rangeStyle = {
                            fontFamily: font,
                            fill: fillColorObj ? fillColorObj.rgb : "rgb(0, 0, 0)",
                            cmyk: fillColorObj ? fillColorObj.cmyk : "[0, 0, 0, 100]",
                            fontWeight: fontWeight,
                            fontSize: fontSize,
                            strokeWeight: strokeWeight,
                            stroke: strokeColorObj ? strokeColorObj.rgb : "rgb(0, 0, 0)",
                            charSpacing: tracking === 'No Tracking' ? 0 : (Number.isFinite(parseFloat(tracking)) ? parseFloat(tracking) : 0),
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
            baseStyle = allCharStyles[0];
        } else {
            // Fallback to paragraph defaults if no character styles exist
            const fallbackFill = pItems.fillColor ? get_color(pItems.fillColor, graphicDOM) : null;
            baseStyle = {
                fontFamily: pItems.font || 'Minion Pro',
                fill: fallbackFill ? fallbackFill.rgb : "rgb(0, 0, 0)",
                cmyk: fallbackFill ? fallbackFill.cmyk : "[0, 0, 0, 100]",
                fontWeight: pItems.fontWeight || 'Regular',
                fontSize: pItems.fontSize || '12',
                strokeWeight: pItems.strokeWeight || '0',
                stroke: "rgb(0, 0, 0)",
                charSpacing: pItems.tracking === 'No Tracking' ? 0 : (Number.isFinite(parseFloat(pItems.tracking)) ? parseFloat(pItems.tracking) : 0),
                underline: false,
                capitalization: 'Normal',
                position: 'Normal',
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

            // Compare with base style to find differences
            const styleChanges = {};

            if (currentStyle.fontFamily !== baseStyle.fontFamily) {
                styleChanges.fontFamily = currentStyle.fontFamily;
                styleChanges.fontWeight = currentStyle.fontWeight;
            }
            if (currentStyle.fill !== baseStyle.fill) {
                styleChanges.fill = currentStyle.fill;
            }
            if (currentStyle.cmyk !== baseStyle.cmyk) {
                styleChanges.cmyk = currentStyle.cmyk;
            }
            if (currentStyle.fontWeight !== baseStyle.fontWeight) {
                styleChanges.fontWeight = currentStyle.fontWeight;
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
            if (currentStyle.charSpacing !== baseStyle.charSpacing) {
                styleChanges.charSpacing = currentStyle.charSpacing;
            }
            if (currentStyle.underline !== baseStyle.underline) {
                styleChanges.underline = currentStyle.underline;
            }
            if (currentStyle.capitalization !== baseStyle.capitalization && currentStyle.capitalization !== 'Normal') {
                styleChanges.capitalization = currentStyle.capitalization;
            }
            if (currentStyle.position !== baseStyle.position && currentStyle.position !== 'Normal') {
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
            fontStyle: baseStyle.fontWeight,
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

        const anchors = pathPoints.map(p => p.getAttribute('Anchor').split(' ').map(parseFloat));

        // Use local bounds origin for decomposition and local point coordinates
        const minX = Math.min(...anchors.map(a => a[0]));
        const minY = Math.min(...anchors.map(a => a[1]));
        const maxX = Math.max(...anchors.map(a => a[0]));
        const maxY = Math.max(...anchors.map(a => a[1]));
        const points = anchors.map(a => ({ x: pt_px(a[0] - minX), y: pt_px(a[1] - minY) }));

        let finalItemTransform = itemTransform;
        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        const decomposed = decomposeTransform(finalItemTransform, minX, minY);

        const shapeColors = resolveShapeColors(itemElement, objectStyle, graphicDOM);

        let pageItem = {
            type: 'Polygon',
            left: decomposed.left,
            top: decomposed.top,
            originX: 'left',
            originY: 'top',
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
            Name: itemElement.getAttribute('Name'),
            width: pt_px(maxX - minX),
            height: pt_px(maxY - minY),
            points: points,
        };

        applyShapeStyles(pageItem, itemElement, objectStyle, graphicDOM, shapeColors);

        const textPath = itemElement.getElementsByTagName('TextPath')[0];
        if (textPath) {
            const parentStory = textPath.getAttribute('ParentStory');
            const storyData = await get_story_data(parentStory, zip, stylesDOM, graphicDOM, parseXml);
            const textPathTracking = storyData.tracking;
            const textPathCharSpacing = textPathTracking === 'No Tracking'
                ? 0
                : (Number.isFinite(parseFloat(textPathTracking)) ? parseFloat(textPathTracking) : 0);
            return {
                ...pageItem,
                type: 'Textbox',
                text: storyData.text,
                styles: storyData.styles,
                charSpacing: textPathCharSpacing,
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
        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        // Use the min of both endpoints as local origin
        const localX = Math.min(p1[0], p2[0]);
        const localY = Math.min(p1[1], p2[1]);
        const decomposed = decomposeTransform(finalItemTransform, localX, localY);

        const shapeColors = resolveShapeColors(itemElement, objectStyle, graphicDOM);

        let pageItem = {
            type: 'Line',
            left: decomposed.left,
            top: decomposed.top,
            originX: 'left',
            originY: 'top',
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
            Name: itemElement.getAttribute('Name'),
            x1: pt_px(p1[0] - localX),
            y1: pt_px(p1[1] - localY),
            x2: pt_px(p2[0] - localX),
            y2: pt_px(p2[1] - localY),
        };

        applyShapeStyles(pageItem, itemElement, objectStyle, graphicDOM, shapeColors);

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
        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        // Decompose using the center of the oval as origin (left + rx, top + ry)
        const decomposed = decomposeTransform(finalItemTransform, left + rx, top + ry);

        const shapeColors = resolveShapeColors(itemElement, objectStyle, graphicDOM);

        let pageItem = {
            type: 'Ellipse',
            left: decomposed.left,
            top: decomposed.top,
            originX: 'center',
            originY: 'center',
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
            rx: pt_px(rx),
            ry: pt_px(ry),
            Name: itemElement.getAttribute('Name'),
        };

        applyShapeStyles(pageItem, itemElement, objectStyle, graphicDOM, shapeColors);

        return pageItem;
    }

    async function getSplineItem(itemElement, stylesDOM, graphicDOM, zip, parseXml, parent) {
        const attrib = itemElement.attributes;
        const objectStyle = applyObjStyles(itemElement, stylesDOM);
        const pathPoints = Array.from(itemElement.getElementsByTagName('PathPointType'));

        if (pathPoints.length === 0) {
            return null;
        }

        const parsePoint = (value) => {
            if (!value) return [0, 0];
            return value.split(' ').map(parseFloat);
        };

        const anchors = pathPoints.map(p => parsePoint(p.getAttribute('Anchor')));
        const minX = Math.min(...anchors.map(a => a[0]));
        const minY = Math.min(...anchors.map(a => a[1]));

        const itemTransform = Array.from(attrib).find(a => a.name === 'ItemTransform').value.split(' ').map(parseFloat);

        let finalItemTransform = itemTransform;
        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        const decomposed = decomposeTransform(finalItemTransform, minX, minY);

        const toLocalPx = (point) => [pt_px(point[0] - minX), pt_px(point[1] - minY)];
        const isSamePoint = (p1, p2) => Math.abs(p1[0] - p2[0]) < 1e-6 && Math.abs(p1[1] - p2[1]) < 1e-6;

        const path = [];
        const firstAnchor = parsePoint(pathPoints[0].getAttribute('Anchor'));
        const [firstX, firstY] = toLocalPx(firstAnchor);
        path.push(['M', firstX, firstY]);

        for (let i = 1; i < pathPoints.length; i++) {
            const prev = pathPoints[i - 1];
            const curr = pathPoints[i];

            const prevAnchor = parsePoint(prev.getAttribute('Anchor'));
            const prevRight = parsePoint(prev.getAttribute('RightDirection') || prev.getAttribute('Anchor'));
            const currAnchor = parsePoint(curr.getAttribute('Anchor'));
            const currLeft = parsePoint(curr.getAttribute('LeftDirection') || curr.getAttribute('Anchor'));

            const isBezier = !isSamePoint(prevRight, prevAnchor) || !isSamePoint(currLeft, currAnchor);

            if (isBezier) {
                const [cp1x, cp1y] = toLocalPx(prevRight);
                const [cp2x, cp2y] = toLocalPx(currLeft);
                const [x, y] = toLocalPx(currAnchor);
                path.push(['C', cp1x, cp1y, cp2x, cp2y, x, y]);
            } else {
                const [x, y] = toLocalPx(currAnchor);
                path.push(['L', x, y]);
            }
        }

        const pathOpenAttr = itemElement.getAttribute('PathOpen');
        const isOpenPath = pathOpenAttr === 'true';
        if (!isOpenPath && pathPoints.length > 2) {
            path.push(['Z']);
        }

        const shapeColors = resolveShapeColors(itemElement, objectStyle, graphicDOM);

        let pageItem = {
            type: 'path',
            left: decomposed.left,
            top: decomposed.top,
            originX: 'left',
            originY: 'top',
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
            Name: itemElement.getAttribute('Name'),
            path: path,
        };

        applyShapeStyles(pageItem, itemElement, objectStyle, graphicDOM, shapeColors);

        const textPath = itemElement.getElementsByTagName('TextPath')[0];
        if (textPath) {
            const parentStory = textPath.getAttribute('ParentStory');
            const storyData = await get_story_data(parentStory, zip, stylesDOM, graphicDOM, parseXml);
            const textPathTracking = storyData.tracking;
            const textPathCharSpacing = textPathTracking === 'No Tracking'
                ? 0
                : (Number.isFinite(parseFloat(textPathTracking)) ? parseFloat(textPathTracking) : 0);
            return {
                ...pageItem,
                type: 'Textbox',
                text: storyData.text,
                styles: storyData.styles,
                charSpacing: textPathCharSpacing,
                ...storyData
            };
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
        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        const decomposed = decomposeTransform(finalItemTransform, left, top);

        let pageItem = {
            type: 'image',
            left: decomposed.left,
            top: decomposed.top,
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
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
        if (shouldMultiplyParentTransform(parent)) {
            const parentMatrix = parent.getAttribute('ItemTransform').split(' ').map(parseFloat);
            finalItemTransform = multiplyAffineMatrices(parentMatrix, itemTransform);
        }

        // Decompose group transform (no local origin offset for groups)
        const decomposed = decomposeTransform(finalItemTransform, 0, 0);

        const objects = [];
        const children = Array.from(itemElement.childNodes).filter(n => n.nodeType === 1);

        for (let childIndex = 0; childIndex < children.length; childIndex++) {
            const childElement = children[childIndex];
            let processedChild = await processPageItem(childElement, stylesDOM, graphicDOM, zip, parseXml, itemElement);
            if (processedChild) {
                processedChild.zIndex = childIndex;
                objects.push(processedChild);
            }
        }

        let pageItem = {
            type: 'group',
            left: decomposed.left,
            top: decomposed.top,
            scaleX: decomposed.scaleX,
            scaleY: decomposed.scaleY,
            flipX: decomposed.flipX,
            flipY: decomposed.flipY,
            angle: decomposed.angle,
            skewX: decomposed.skewX,
            skewY: decomposed.skewY,
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
            const pageWidth = documentData.fWidth;
            const pageHeight = documentData.fHeight;
            const canvasObjects = [];

            // Extract the page's ItemTransform to get its offset from the spread origin
            const pageTransformStr = pageElement.getAttribute('ItemTransform');
            const pageTransform = pageTransformStr ? pageTransformStr.split(' ').map(parseFloat) : [1, 0, 0, 1, 0, 0];
            const pageOffsetX = pageTransform[4]; // tx
            const pageOffsetY = pageTransform[5]; // ty

            // Get all direct children of the Spread element, excluding Page elements
            const pageItems = Array.from(spreadElement.childNodes).filter(n =>
                n.nodeType === 1 && n.tagName !== 'Page' && n.tagName !== 'FlattenerPreference'
            );

            for (let itemIndex = 0; itemIndex < pageItems.length; itemIndex++) {
                const itemElement = pageItems[itemIndex];
                let processedItem = await processPageItem(itemElement, stylesDOM, graphicDOM, zip, parseXml, spreadElement);
                if (processedItem) {
                    // Adjust object position to be relative to the page instead of the spread
                    // Subtract the page offset (convert from points to pixels)
                    if (processedItem.left !== undefined) {
                        processedItem.left -= pt_px(pageOffsetX);
                    }
                    if (processedItem.top !== undefined) {
                        processedItem.top -= pt_px(pageOffsetY);
                    }
                    processedItem.zIndex = itemIndex;
                    canvasObjects.push(processedItem);
                }
            }

            const page = {
                id: pageElement.getAttribute('Self'),
                canvas: {
                    version: "3.4.0",
                    objects: canvasObjects,
                    clipPath: {
                        type: "rect",
                        version: "3.4.0",
                        originX: "left",
                        originY: "top",
                        left: 0,
                        top: 0,
                        width: pt_px(pageWidth + 112),
                        height: pt_px(pageHeight + 194),
                        fill: "rgb(0,0,0)",
                        stroke: null,
                        strokeWidth: 0,
                        strokeDashArray: null,
                        strokeLineCap: "butt",
                        strokeDashOffset: 0,
                        strokeLineJoin: "miter",
                        strokeMiterLimit: 4,
                        scaleX: 1,
                        scaleY: 1,
                        angle: 0,
                        flipX: false,
                        flipY: false,
                        opacity: 1,
                        shadow: null,
                        visible: true,
                        clipTo: null,
                        backgroundColor: "",
                        fillRule: "nonzero",
                        paintFirst: "fill",
                        globalCompositeOperation: "source-over",
                        transformMatrix: [1, 0, 0, 1, 0, 0]
                    },
                    height: pt_px(pageHeight),
                    width: pt_px(pageWidth),
                    zoom: 0.23915343915343917
                },
                pageData: {
                    fWidth: pt_px(documentData.fWidth),
                    fHeight: pt_px(documentData.fHeight),
                    bleed: documentData.bleed,
                    margin: documentData.margin,
                    originX: documentData.originX,
                    originY: documentData.originY,
                    title: pageElement.getAttribute('Self'),
                    transformMatrix: [1, 0, 0, 1, 0, 0]
                }
            };

            pages.push(page);
        }
    }

    // Collect used fonts and images from pages
    const usedFonts = new Set();
    const imageAssets = [];

    const collectFontFromValue = (fontValue) => {
        if (fontValue) {
            usedFonts.add(fontValue);
        }
    };

    const collectFontsFromStyles = (styles) => {
        if (!styles || Array.isArray(styles)) {
            return;
        }
        for (const style of Object.values(styles)) {
            if (style && style.fontFamily) {
                collectFontFromValue(style.fontFamily);
            }
        }
    };

    const collectFromObject = (obj) => {
        if (!obj) {
            return;
        }

        if (obj.type === 'Textbox') {
            collectFontFromValue(obj.fontFamily);
            collectFontsFromStyles(obj.styles);
        }

        if (obj.type === 'image' && obj.url) {
            console.log('Found image:', obj.Name);
            imageAssets.push({
                type: 'image',
                id: `image-${obj.Name || 'unnamed'}`,
                url: obj.url,
                name: obj.Name
            });
        }

        if (obj.objects && Array.isArray(obj.objects)) {
            for (const child of obj.objects) {
                collectFromObject(child);
            }
        }
    };

    for (const page of pages) {
        for (const obj of page.canvas.objects) {
            collectFromObject(obj);
        }
    }

    for (const fontName of usedFonts) {
        console.log('Found font:', fontName);
    }

    const uniqueFonts = Array.from(usedFonts).sort((a, b) => a.localeCompare(b));

    const finalJson = {
        designId: crypto.randomBytes(16).toString('hex'),
        title: 'IDML-Node-Conversion',
        colorConversionPolicy: COLOR_CONVERSION_POLICY,
        fonts: uniqueFonts,
        assets: [],
        pages: pages,
        documentData: documentData,
        diagnostics: {
            warnings: diagnostics
        },
        isvx: true
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