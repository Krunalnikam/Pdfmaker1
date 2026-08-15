import { enhanceImageData } from "./image-enhancement";

export type StudentDetails = {
  branch: string;
  enrollmentNumber: string;
  subject: string;
  examPhase: string;
};

export type UploadedImage = {
  id: string;
  name: string;
  dataUrl: string;
  originalDataUrl: string;
  size?: number;
  isCropped?: boolean;
  currentQuad?: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ];
  confidence?: number;
};

const sanitize = (value: string) =>
  value
    .trim()
    .replace(/[^a-zA-Z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "Unknown";

export const buildFileName = (d: StudentDetails) =>
  `${sanitize(d.branch)}_${sanitize(d.enrollmentNumber)}_${sanitize(d.subject)}_${sanitize(d.examPhase)}.pdf`;

/**
 * Standard A4 document dimensions in PostScript points (1 pt = 1/72 inch).
 * A4 size: 210mm x 297mm = 595.28 pt x 841.89 pt.
 */
export const A4_PORTRAIT_WIDTH = 595.28;
export const A4_PORTRAIT_HEIGHT = 841.89;

const loadImage = (dataUrl: string, pageIndex: number, imageName?: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () =>
      reject(
        new Error(
          `Page ${pageIndex + 1} (${imageName || "Image"}) could not be read or decoded. Please verify the image file.`,
        ),
      );
    img.src = dataUrl;
  });

/**
 * Optimizes an uploaded assignment image:
 * - Downscales excessive camera resolution (e.g. 4000px+ phone photos) to a clean ~1800px max dimension
 * - Discards heavy camera EXIF metadata and color profile bloat via Canvas
 * - Preserves high-quality handwriting and diagrams with adaptive compression
 * - Preserves the exact aspect ratio with zero cropping or distortion
 */
const optimizeImageForPdf = async (
  image: UploadedImage,
  index: number,
  enableSmartFilter = true,
) => {
  const img = await loadImage(image.dataUrl, index, image.name);
  const rawWidth = img.naturalWidth || img.width;
  const rawHeight = img.naturalHeight || img.height;

  if (!rawWidth || !rawHeight || rawWidth <= 0 || rawHeight <= 0) {
    throw new Error(`Page ${index + 1} (${image.name || "Image"}) has invalid dimensions.`);
  }

  // 1800px longest dimension provides crisp print-quality equivalent for text/diagrams
  const MAX_DIMENSION = 1800;
  const maxSide = Math.max(rawWidth, rawHeight);
  const scale = maxSide > MAX_DIMENSION ? MAX_DIMENSION / maxSide : 1;

  const targetWidth = Math.max(1, Math.round(rawWidth * scale));
  const targetHeight = Math.max(1, Math.round(rawHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error(`Page ${index + 1}: Canvas graphics context is unavailable.`);
  }

  // Use high quality image smoothing to prevent jagged handwriting when downscaling
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";

  // Fill pure white background to support transparent PNGs and preserve paper margins
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, targetWidth, targetHeight);

  // Draw image precisely across canvas
  ctx.drawImage(img, 0, 0, targetWidth, targetHeight);

  // Apply smart automatic document enhancement only if enabled (ON)
  if (enableSmartFilter) {
    const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
    enhanceImageData(imgData);
    ctx.putImageData(imgData, 0, 0);
  }

  // Adaptive quality to keep handwriting ultra-crisp without file bloat
  const quality = maxSide < 1200 ? 0.88 : 0.84;
  const optimizedDataUrl = canvas.toDataURL("image/jpeg", quality);

  // Release canvas dimensions to assist garbage collection
  canvas.width = 1;
  canvas.height = 1;

  return {
    dataUrl: optimizedDataUrl,
    width: targetWidth,
    height: targetHeight,
  };
};

export async function generateAssignmentPdf(
  details: StudentDetails,
  images: UploadedImage[],
  enableSmartFilter = true,
): Promise<{ blob: Blob; fileName: string }> {
  const validImages = images.filter((img) => Boolean(img?.dataUrl));
  if (validImages.length === 0) {
    throw new Error("No images provided to generate PDF. Please upload at least one page.");
  }

  const { jsPDF } = await import("jspdf");

  // Optimize and validate each image with precise per-page error tracking
  const optimizedImages: { dataUrl: string; width: number; height: number }[] = [];
  for (let i = 0; i < validImages.length; i++) {
    try {
      const optimized = await optimizeImageForPdf(validImages[i]!, i, enableSmartFilter);
      optimizedImages.push(optimized);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : `Page ${i + 1} failed to process.`;
      throw new Error(msg);
    }
  }

  const first = optimizedImages[0]!;
  const firstIsLandscape = first.width > first.height;
  const firstPageWidth = firstIsLandscape ? A4_PORTRAIT_HEIGHT : A4_PORTRAIT_WIDTH;
  const firstPageHeight = firstIsLandscape ? A4_PORTRAIT_WIDTH : A4_PORTRAIT_HEIGHT;

  // Initialize PDF with standard A4 page dimensions
  const doc = new jsPDF({
    unit: "pt",
    format: "a4",
    orientation: firstIsLandscape ? "landscape" : "portrait",
    compress: true,
  });

  for (let i = 0; i < optimizedImages.length; i++) {
    const { dataUrl, width, height } = optimizedImages[i]!;
    const isLandscape = width > height;
    const pageWidth = isLandscape ? A4_PORTRAIT_HEIGHT : A4_PORTRAIT_WIDTH;
    const pageHeight = isLandscape ? A4_PORTRAIT_WIDTH : A4_PORTRAIT_HEIGHT;
    const orientation = isLandscape ? "landscape" : "portrait";

    if (i > 0) {
      doc.addPage("a4", orientation);
    }

    // Calculate exact proportional fit inside A4 page without stretching or cropping
    const fitScale = Math.min(pageWidth / width, pageHeight / height);
    const renderWidth = width * fitScale;
    const renderHeight = height * fitScale;
    const renderX = (pageWidth - renderWidth) / 2;
    const renderY = (pageHeight - renderHeight) / 2;

    doc.addImage(dataUrl, "JPEG", renderX, renderY, renderWidth, renderHeight, undefined, "FAST");
  }

  return { blob: doc.output("blob"), fileName: buildFileName(details) };
}

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
};
