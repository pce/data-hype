#!/bin/sh
# Generate TypeDoc documentation and copy to output directory
# This script handles the case where docs-output is a mounted volume

set -e

echo "Generating TypeDoc documentation..."

# Generate docs to a temp directory first
npx typedoc --out /tmp/docs-output

echo "Documentation generated successfully!"
echo "Copying to output directory..."

# Copy generated docs to the mounted volume
cp -r /tmp/docs-output/* /app/docs-output/ 2>/dev/null || true

# If the above fails (empty dir), create the files directly
if [ ! "$(ls -A /app/docs-output)" ]; then
    echo "Output directory is empty, copying files..."
    cp -r /tmp/docs-output/. /app/docs-output/
fi

echo "Documentation copied to /app/docs-output"
echo ""
echo "Files generated:"
ls -lh /app/docs-output/ | head -10
echo ""
echo "✓ Documentation build complete!"
