# IDML-JSON-Node

A Node.js converter that transforms Adobe InDesign IDML (InDesign Markup Language) files into structured JSON format.

## Overview

This project extracts content, styles, and layout information from IDML files and converts them into a JSON representation that can be used for further processing, analysis, or conversion to other formats. It handles various InDesign elements including text frames, rectangles, polygons, images, colors, and styles.

## What is IDML?

IDML (InDesign Markup Language) is Adobe InDesign's XML-based file format that represents an InDesign document as a collection of XML files packaged in a ZIP archive. This format allows for programmatic access to InDesign documents without requiring the InDesign application.

## Features

### Supported Elements

- **Text Frames**: Extracts text content with character and paragraph styling
- **Rectangles**: Processes rectangular shapes with fills, strokes, and transformations
- **Polygons**: Handles complex polygon shapes with paths
- **Graphic Lines**: Converts line elements
- **Images**: Extracts and processes embedded images (SVG and raster formats)
- **Groups**: Maintains hierarchical grouping of elements

### Style Processing

- **Character Styles**: Font family, size, color, weight, and text decorations
- **Paragraph Styles**: Alignment, spacing, indentation, and text properties
- **Object Styles**: Fill colors, stroke properties, opacity, and effects
- **Style Inheritance**: Resolves cascading styles with "BasedOn" relationships

### Color Handling

- **CMYK to RGB Conversion**: Automatic color space conversion
- **RGB to CMYK Conversion**: Reverse conversion support
- **Spot Colors**: Processes special spot color definitions
- **Gradients**: Extracts gradient definitions with stops and angles

### Document Properties

- Page dimensions (width and height)
- Bleed settings (uniform or individual sides)
- Margins (uniform or per-side)
- Transformation matrices for element positioning

## Installation

```bash
npm install
```

### Dependencies

- **jszip**: For reading IDML files (ZIP archives)
- **xmldom**: For parsing XML content within IDML files
- **canvas**: For image processing operations
- **mathjs**: For matrix transformations

## Usage

### Basic Usage

1. Place your `.idml` files in the `input/` directory
2. Run the converter:

```bash
npm start
```

3. Find the converted JSON files in the `output/` directory

### Programmatic Usage

```javascript
const { processIdml } = require("./src/idmlProcessor");

async function convert() {
  const jsonData = await processIdml("./path/to/file.idml");
  console.log(JSON.stringify(jsonData, null, 2));
}

convert();
```

## Project Structure

```
idml-json-node/
├── index.js                 # Main entry point, processes all IDML files in input/
├── package.json            # Project dependencies and metadata
├── input/                  # Directory for input IDML files
│   └── bounded-text.idml   # Example IDML file
├── output/                 # Directory for output JSON files
│   └── bounded-text.json   # Example output
└── src/                    # Source code modules
    ├── idmlProcessor.js    # Core IDML processing logic
    ├── characterStyles.js  # Character style extraction and resolution
    ├── paragraphStyles.js  # Paragraph style extraction and resolution
    ├── objectStyles.js     # Object style extraction and resolution
    ├── colorOps.js         # Color conversion and processing
    ├── imageOps.js         # Image extraction and conversion
    └── utils.js            # Utility functions (pt to px conversion, etc.)
```

## Module Descriptions

### idmlProcessor.js

The main processing engine that:

- Unzips IDML files
- Parses XML documents (designmap, styles, graphics, preferences)
- Processes spreads and pages
- Handles all page items (text frames, shapes, images)
- Applies transformations and styles
- Assembles the final JSON structure

### characterStyles.js

- Extracts character-level styling information
- Resolves style inheritance via "BasedOn" relationships
- Caches styles for performance
- Returns font, size, color, and decoration properties

### paragraphStyles.js

- Processes paragraph-level formatting
- Handles text alignment, spacing, and indentation
- Resolves style inheritance
- Caches resolved styles

### objectStyles.js

- Extracts object-level properties
- Processes fill colors and stroke properties
- Handles opacity and effects
- Resolves style cascading

### colorOps.js

- Converts CMYK to RGB and vice versa
- Retrieves color definitions from graphics resources
- Processes spot colors
- Extracts gradient information with stops and angles

### imageOps.js

- Detects and processes SVG images
- Compresses raster images
- Converts images to base64 encoding
- Handles various image formats

### utils.js

- Provides utility functions
- Converts points to pixels
- Additional helper functions for common operations

## Output Format

The converter generates a JSON structure with the following top-level properties:

```json
{
  "bleed": 0,
  "fWidth": 612,
  "fHeight": 792,
  "originX": "left",
  "originY": "top",
  "transformMatrix": [1, 0, 0, 1, 0, 0],
  "margin": 36,
  "pages": [
    {
      "pageNumber": 1,
      "elements": [
        {
          "type": "textFrame",
          "content": "Sample text",
          "styles": {...},
          "geometry": {...}
        }
      ]
    }
  ]
}
```

## How It Works

1. **File Reading**: The IDML file (a ZIP archive) is loaded and unzipped
2. **XML Parsing**: Key XML files are parsed:
   - `designmap.xml`: Document structure and spread references
   - `Resources/Styles.xml`: Style definitions
   - `Resources/Graphic.xml`: Color and graphic resources
   - `Resources/Preferences.xml`: Document settings
3. **Spread Processing**: Each spread is processed to extract pages
4. **Element Processing**: Page items are processed recursively:
   - Geometry and transformations are calculated
   - Styles are resolved and applied
   - Images are extracted and encoded
   - Text content is parsed with formatting
5. **JSON Generation**: The complete structure is assembled into JSON
6. **Output**: JSON is written to the output directory

## Transformation Handling

The converter handles complex transformations including:

- Translation (position offsets)
- Rotation
- Scaling
- Skewing
- Matrix multiplication for nested transformations

## Use Cases

- **Document Conversion**: Convert InDesign files to web-ready formats
- **Content Extraction**: Extract text and images from IDML files
- **Automated Publishing**: Integrate InDesign content into automated workflows
- **Analysis**: Analyze InDesign document structure and styling
- **Migration**: Migrate content from InDesign to other systems
- **Templating**: Process InDesign templates programmatically

## Limitations

- Relies on IDML format (InDesign CS4 and later)
- Some complex InDesign features may not be fully represented
- Image processing requires the canvas library (native dependencies)
- Large files with many images may require additional memory

## Requirements

- Node.js (v12 or higher recommended)
- NPM or Yarn package manager
- Native build tools for canvas installation (Windows: Visual Studio Build Tools)

## Future Enhancements

Potential areas for expansion:

- Support for additional InDesign elements (tables, footnotes, etc.)
- Enhanced image processing options
- Export to additional formats (HTML, PDF, etc.)
- Interactive preview generation
- Batch processing improvements
- Performance optimization for large documents

## License

ISC

## Author

Created for converting Adobe InDesign IDML files to JSON format.

---

**Note**: This tool is designed for IDML files and does not work with native `.indd` files. Use Adobe InDesign's "Export > InDesign Markup (IDML)" feature to create IDML files from `.indd` documents.
