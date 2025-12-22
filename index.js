const fs = require('fs');
const path = require('path');
const { processIdml } = require('./src/idmlProcessor');

async function main() {
    const inputDir = './input';
    const outputDir = './output';

    fs.readdir(inputDir, async (err, files) => {
        if (err) {
            console.error('Error reading input directory:', err);
            return;
        }

        for (const file of files) {
            if (path.extname(file).toLowerCase() === '.idml') {
                const inputFilePath = path.join(inputDir, file);
                const outputFilePath = path.join(outputDir, `${path.basename(file, '.idml')}.json`);

                console.log(`Processing ${inputFilePath}...`);

                try {
                    const jsonData = await processIdml(inputFilePath);
                    fs.writeFileSync(outputFilePath, JSON.stringify(jsonData, null, 2));
                    console.log(`Successfully converted ${inputFilePath} to ${outputFilePath}`);
                } catch (error) {
                    console.error(`Error processing ${inputFilePath}:`, error);
                }
            }
        }
    });
}

main();