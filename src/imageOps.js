const { createCanvas, loadImage } = require('canvas');
const { DOMParser } = require('xmldom');

/**
 * Checks if a file path indicates an SVG file.
 * @param {string} filePath - The path to the file.
 * @returns {boolean} True if the file is an SVG, false otherwise.
 */
function is_svg(filePath) {
    return filePath.toLowerCase().endsWith('.svg');
}

/**
 * Compresses an image using the canvas.
 * @param {Buffer} buffer - The image buffer.
 * @param {string} type - The image type (e.g., 'image/jpeg').
 * @param {number} [quality=0.8] - Compression quality (0-1).
 * @returns {Promise<Buffer>} A promise that resolves with the compressed image buffer.
 */
async function compress_image(buffer, type, quality = 0.8) {
    const image = await loadImage(buffer);
    const canvas = createCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    return canvas.toBuffer(type, { quality });
}

/**
 * Converts a base64 string to a Buffer.
 * @param {boolean} isMeta - True if the base64 string is metadata (e.g., XMP thumbnail).
 * @param {string} base64Str - The base64 encoded string.
 * @returns {string|Object} A base64 encoded string for the image, or an object with image data if isMeta is true, or an error message.
 */
async function convert_base64(isMeta, base64Str) {
    if (isMeta) {
        try {
            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(base64Str, "application/xml");
            const thumbElement = xmlDoc.getElementsByTagName('xmpGImg:image')[0];
            const widthElement = xmlDoc.getElementsByTagName('xmpGImg:width')[0];
            const heightElement = xmlDoc.getElementsByTagName('xmpGImg:height')[0];
            const formatElement = xmlDoc.getElementsByTagName('xmpGImg:format')[0];

            if (thumbElement && widthElement && heightElement && formatElement) {
                const imgBase64 = thumbElement.textContent.replace(/\s/g, '');
                const width = parseInt(widthElement.textContent, 10);
                const height = parseInt(heightElement.textContent, 10);
                const format = formatElement.textContent;

                const buffer = Buffer.from(imgBase64, 'base64');
                return { data: buffer.toString('base64'), width, height, format };
            }
            return 'no image';
        } catch (e) {
            console.error('Error parsing XMP metadata:', e);
            return "Error finding image";
        }
    } else {
        try {
            const buffer = Buffer.from(base64Str.replace(/\s/g, ''), 'base64');
            return buffer.toString('base64');
        } catch (e) {
            console.error(e);
            return "Error finding image";
        }
    }
}

module.exports = { is_svg, compress_image, convert_base64 };
