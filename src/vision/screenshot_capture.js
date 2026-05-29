// SmallCode — Screenshot Capture Layer
// Captures a desktop screenshot on Windows using portable Python + Pillow (ImageGrab).

const child_process = require('child_process');
const path = require('path');
const fs = require('fs');

let mockCaptureFn = null;

/**
 * Injects a mock capture function for testing.
 * @param {Function|null} fn
 */
function setMockCapture(fn) {
  mockCaptureFn = fn;
}

/**
 * Resolves the path to the portable Python executable.
 * Falls back to 'python' if not found.
 */
function getPythonExecutable() {
  const drive = process.cwd().slice(0, 2); // e.g. "D:" or "C:"
  const portablePath = path.join(drive, 'PortablePython', 'python.exe');
  if (fs.existsSync(portablePath)) {
    return portablePath;
  }
  // Try static drive paths
  if (fs.existsSync('D:\\PortablePython\\python.exe')) return 'D:\\PortablePython\\python.exe';
  if (fs.existsSync('C:\\PortablePython\\python.exe')) return 'C:\\PortablePython\\python.exe';
  return 'python';
}

/**
 * Capture a screenshot and save it to the specified output file.
 * Returns { success: true, filePath } or throws a structured error.
 */
function captureScreenshot(outputPath) {
  if (mockCaptureFn) {
    return mockCaptureFn(outputPath);
  }

  const pythonBin = getPythonExecutable();
  
  // Inline python script to take screenshot using PIL
  const pyScript = `import sys
try:
    from PIL import ImageGrab
except ImportError:
    print("ERROR: Pillow is not installed", file=sys.stderr)
    sys.exit(2)
try:
    img = ImageGrab.grab()
    img.save(r"${outputPath}")
except Exception as e:
    print(f"ERROR: Capture failed: {e}", file=sys.stderr)
    sys.exit(3)
`;

  const result = child_process.spawnSync(pythonBin, ['-c', pyScript], { encoding: 'utf-8' });
  
  if (result.error) {
    // Check if python was not found at all
    if (result.error.code === 'ENOENT') {
      throw new Error(`Python executable not found. Checked: ${pythonBin}`);
    }
    throw new Error(`Failed to execute Python screenshot process: ${result.error.message}`);
  }

  if (result.status !== 0) {
    const stderr = (result.stderr || '').trim();
    if (stderr.includes('Pillow is not installed') || stderr.includes("No module named 'PIL'")) {
      throw new Error('Pillow/PIL library is not installed in the Python environment');
    }
    throw new Error(`Screenshot capture failed: ${stderr || 'Unknown Python error'}`);
  }

  if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
    throw new Error('Screenshot file was not created or is empty');
  }

  return { success: true, filePath: outputPath };
}

module.exports = {
  captureScreenshot,
  setMockCapture,
  getPythonExecutable
};
