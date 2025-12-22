/* eslint-disable no-console */
const fs = require('fs/promises');
const path = require('path');
const { performance } = require('perf_hooks');

const idmlProcessorModule = require('./src/idmlProcessor');
const processIdml = idmlProcessorModule.processIdml || idmlProcessorModule;

const INPUT_DIR = path.join(__dirname, 'input');
const OUTPUT_DIR = path.join(__dirname, 'output');

async function ensureOutputDir() {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function gatherIdmlFiles() {
    const entries = await fs.readdir(INPUT_DIR, { withFileTypes: true });
    return entries
        .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.idml'))
        .map(entry => path.join(INPUT_DIR, entry.name));
}

function formatMs(ms) {
    return `${ms.toFixed(2)} ms`;
}

function formatMemory(bytes) {
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
}

async function main() {
    const startAll = performance.now();
    await ensureOutputDir();

    const files = await gatherIdmlFiles();
    if (files.length === 0) {
        console.log('No .idml files found in input directory.');
        return;
    }

    const stats = [];
    let totalPages = 0;
    let totalObjects = 0;

    for (const filePath of files) {
        const fileStart = performance.now();
        const fileName = path.basename(filePath);

        try {
            const result = await processIdml(filePath, OUTPUT_DIR);
            const duration = performance.now() - fileStart;

            const pageCount = Array.isArray(result?.pages) ? result.pages.length : 0;
            const objectCount = result?.pages?.reduce((sum, page) => sum + (page.objects?.length || 0), 0) || 0;

            totalPages += pageCount;
            totalObjects += objectCount;

            stats.push({
                file: fileName,
                duration: formatMs(duration),
                pages: pageCount,
                objects: objectCount
            });

            console.log(`✓ ${fileName} processed in ${formatMs(duration)} (${pageCount} pages, ${objectCount} objects)`);
        } catch (error) {
            const duration = performance.now() - fileStart;
            stats.push({
                file: fileName,
                duration: formatMs(duration),
                pages: 'n/a',
                objects: 'n/a',
                error: error.message
            });
            console.error(`✗ ${fileName} failed in ${formatMs(duration)} -> ${error.message}`);
        }
    }

    const totalDuration = performance.now() - startAll;
    const memoryUsage = process.memoryUsage();

    console.log('\nSummary');
    console.table(stats);

    console.log(`Files processed: ${stats.length}`);
    console.log(`Total time: ${formatMs(totalDuration)}`);
    console.log(`Average time: ${formatMs(totalDuration / stats.length)}`);
    console.log(`Total pages: ${totalPages}`);
    console.log(`Total objects: ${totalObjects}`);
    console.log(`Memory RSS: ${formatMemory(memoryUsage.rss)}`);
    console.log(`Heap used: ${formatMemory(memoryUsage.heapUsed)}`);
    console.log(`Heap total: ${formatMemory(memoryUsage.heapTotal)}`);
    console.log(`External: ${formatMemory(memoryUsage.external)}`);
}

main().catch(err => {
    console.error('Unexpected error:', err);
    process.exit(1);
});