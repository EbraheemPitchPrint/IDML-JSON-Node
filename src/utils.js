/**
 * Converts points to pixels.
 * @param {number} pt - Value in points.
 * @param {number} [conversion_factor=1.333] - Conversion factor (e.g., 1pt = 1.333px).
 * @returns {number} Value in pixels.
 */
function pt_px(pt, conversion_factor = 1.333) {
    return parseFloat(pt) * conversion_factor;
}

/**
 * Multiplies two 2D affine matrices represented as [a, b, c, d, tx, ty].
 * Matrix layout:
 *   | a  c  tx |     | a  b  0 |
 *   | b  d  ty |  or | c  d  0 |  (IDML uses [a, b, c, d, tx, ty])
 *   | 0  0  1  |     | tx ty 1 |
 *
 * IDML ItemTransform = [a, b, c, d, tx, ty] where:
 *   a=scaleX*cos, b=scaleX*sin, c=-scaleY*sin, d=scaleY*cos, tx=translateX, ty=translateY
 *
 * @param {number[]} m1 - First matrix [a, b, c, d, tx, ty]
 * @param {number[]} m2 - Second matrix [a, b, c, d, tx, ty]
 * @returns {number[]} Result matrix [a, b, c, d, tx, ty]
 */
function multiplyAffineMatrices(m1, m2) {
    return [
        m1[0] * m2[0] + m1[2] * m2[1],         // a
        m1[1] * m2[0] + m1[3] * m2[1],         // b
        m1[0] * m2[2] + m1[2] * m2[3],         // c
        m1[1] * m2[2] + m1[3] * m2[3],         // d
        m1[0] * m2[4] + m1[2] * m2[5] + m1[4], // tx
        m1[1] * m2[4] + m1[3] * m2[5] + m1[5]  // ty
    ];
}

/**
 * Decomposes an IDML affine transform [a, b, c, d, tx, ty] into Fabric.js-compatible
 * properties. Also transforms the object's local origin (top-left corner from bounds)
 * through the matrix to get accurate left/top in pasteboard coords, then converts to px.
 *
 * @param {number[]} transform - The 6-element affine matrix [a, b, c, d, tx, ty]
 * @param {number} localX - The local X origin of the object (bounds left, in points)
 * @param {number} localY - The local Y origin of the object (bounds top, in points)
 * @returns {Object} Fabric.js properties: left, top, scaleX, scaleY, angle, skewX, skewY, transformMatrix
 */
function decomposeTransform(transform, localX = 0, localY = 0) {
    const [a, b, c, d, tx, ty] = transform;

    // Transform the local origin point through the affine matrix to get pasteboard position
    const worldX = a * localX + c * localY + tx;
    const worldY = b * localX + d * localY + ty;

    // Robust affine decomposition (Fabric-compatible):
    // keeps skew, scale, rotation and preserves reflection through flip flags.
    const denom = a * a + b * b;
    let scaleXRaw = Math.sqrt(denom);
    let angle = 0;
    let scaleYRaw = 1;
    let skewX = 0;

    if (scaleXRaw > 0.000001) {
        angle = Math.atan2(b, a);
        scaleYRaw = (a * d - b * c) / scaleXRaw;
        skewX = Math.atan2(a * c + b * d, denom) * (180 / Math.PI);
    } else {
        scaleXRaw = 0;
        angle = 0;
        scaleYRaw = Math.sqrt(c * c + d * d);
        skewX = 0;
    }

    let flipX = false;
    let flipY = false;

    if (scaleXRaw < 0) {
        scaleXRaw = -scaleXRaw;
        flipX = true;
    }
    if (scaleYRaw < 0) {
        scaleYRaw = -scaleYRaw;
        flipY = true;
    }

    const angleDeg = angle * (180 / Math.PI);

    // skewY is 0 in QR decomposition (absorbed into rotation)
    const skewY = 0;

    return {
        left: pt_px(worldX),
        top: pt_px(worldY),
        scaleX: Math.abs(scaleXRaw) < 0.0001 ? 1 : parseFloat(scaleXRaw.toFixed(6)),
        scaleY: Math.abs(scaleYRaw) < 0.0001 ? 1 : parseFloat(scaleYRaw.toFixed(6)),
        angle: Math.abs(angleDeg) < 0.001 ? 0 : parseFloat(angleDeg.toFixed(4)),
        skewX: Math.abs(skewX) < 0.001 ? 0 : parseFloat(skewX.toFixed(4)),
        skewY: skewY,
        flipX: flipX,
        flipY: flipY,
    };
}

/**
 * Checks if all items in a 2D array are the same.
 * @param {Array<Array<any>>} array_of_objects - The 2D array to check.
 * @returns {boolean} True if all items are the same, false otherwise.
 */
function check_all_items_same(array_of_objects) {
    if (!array_of_objects || array_of_objects.length === 0) {
        return true;
    }
    const first_item = array_of_objects[0][0];

    for (const row of array_of_objects) {
        for (const item of row) {
            if (item !== first_item) {
                return false;
            }
        }
    }

    return true;
}

module.exports = { pt_px, check_all_items_same, multiplyAffineMatrices, decomposeTransform };
