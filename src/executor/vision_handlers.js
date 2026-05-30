async function handleVisionScreenshot() {
  try {
    const { saveScreenshot } = require('../vision/image_artifact_store');
    const metadata = saveScreenshot();
    return {
      action: 'Captured',
      imageId: metadata.imageId,
      filePath: metadata.filePath,
      width: metadata.width,
      height: metadata.height,
      byteSize: metadata.byteSize,
      result: `Screenshot captured: ${metadata.filePath} (${metadata.width}x${metadata.height})`
    };
  } catch (err) {
    return { error: `Failed to capture screenshot: ${err.message}` };
  }
}

async function handleVisionList() {
  try {
    const { listImages } = require('../vision/image_artifact_store');
    const images = listImages();
    return {
      result: JSON.stringify(images, null, 2)
    };
  } catch (err) {
    return { error: `Failed to list screenshots: ${err.message}` };
  }
}

async function handleVisionDescribe(args, config) {
  try {
    const { saveScreenshot } = require('../vision/image_artifact_store');
    const { queryVisionModel } = require('../vision/vision_payload_builder');
    
    let imagePath = args.image_path;
    if (!imagePath) {
      const metadata = saveScreenshot();
      imagePath = metadata.filePath;
    }

    const queryResult = await queryVisionModel({
      text: "Describe this image in detail.",
      imagePath,
      config
    });

    if (queryResult.error) {
      return {
        error: queryResult.error,
        imagePath,
        hint: queryResult.hint
      };
    }

    return {
      result: queryResult.text,
      imagePath
    };
  } catch (err) {
    return { error: `Vision describe failed: ${err.message}` };
  }
}

async function handleVisionAsk(args, config) {
  try {
    const { saveScreenshot } = require('../vision/image_artifact_store');
    const { queryVisionModel } = require('../vision/vision_payload_builder');
    
    let imagePath = args.image_path;
    if (!imagePath) {
      const metadata = saveScreenshot();
      imagePath = metadata.filePath;
    }

    const queryResult = await queryVisionModel({
      text: args.question,
      imagePath,
      config
    });

    if (queryResult.error) {
      return {
        error: queryResult.error,
        imagePath,
        hint: queryResult.hint
      };
    }

    return {
      result: queryResult.text,
      imagePath
    };
  } catch (err) {
    return { error: `Vision ask failed: ${err.message}` };
  }
}

module.exports = {
  handleVisionScreenshot,
  handleVisionList,
  handleVisionDescribe,
  handleVisionAsk
};
