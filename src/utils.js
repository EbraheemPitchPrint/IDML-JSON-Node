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

module.exports = { pt_px, check_all_items_same };
