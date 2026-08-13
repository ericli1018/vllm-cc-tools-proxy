import { HttpError } from '../lib/http.js';


const PROCESSING_CODES = new Set([
  'subprocess_timeout',
  'subprocess_start_failed',
  'subprocess_output_too_large',
  'subprocess_failed',
  'invalid_image',
  'unsupported_image',
]);

const SAFE_CODES = new Set([
  'invalid_visual_crop_arguments',
  'unknown_visual_source',
  'visual_crop_round_limit',
  'visual_crop_depth_limit',
  'invalid_visual_crop_coordinates',
  'invalid_visual_crop_rectangle',
  'crop_region_too_small',
  'visual_crop_count_limit',
  'visual_crop_batch_limit',
  'unsupported_visual_tool',
  'crop_processing_failed',
]);

export function cropToolError(error, fallbackCode = 'crop_processing_failed') {
  if (error?.name === 'AbortError') throw error;
  const code = SAFE_CODES.has(error?.code) ? error.code : fallbackCode;
  const retryable = !['visual_crop_round_limit', 'visual_crop_depth_limit', 'visual_crop_count_limit', 'visual_crop_batch_limit', 'unsupported_visual_tool'].includes(code);
  const messages = {
    invalid_visual_crop_arguments: 'Crop arguments were not valid JSON or did not match the required schema.',
    unknown_visual_source: 'The requested source_id is not available in this visual-analysis request.',
    visual_crop_round_limit: 'The crop correction round limit has been reached.',
    visual_crop_depth_limit: 'The maximum visual crop depth has been reached. Continue from the existing images and crops.',
    invalid_visual_crop_coordinates: 'Crop coordinates must contain four integers in the range 0 through 1000.',
    invalid_visual_crop_rectangle: 'Crop coordinates must describe a rectangle with positive width and height.',
    crop_region_too_small: 'Requested crop region is smaller than the allowed minimum.',
    visual_crop_count_limit: 'The maximum number of crops for this source has been reached.',
    visual_crop_batch_limit: 'Too many crop requests were returned in one model response.',
    unsupported_visual_tool: 'The requested visual tool is not available.',
    crop_processing_failed: 'The requested crop could not be generated.',
  };
  return {
    ok: false,
    error: {
      code,
      message: messages[code],
      retryable,
      constraints: {
        bbox_coordinate_range: [0, 1000],
        minimum_area_ratio: 0.01,
        maximum_crops_per_response: 4,
      },
    },
  };
}

export function asCropHttpError(code, message) {
  return new HttpError(422, message, { code });
}


export function recoverableCropToolError(error, { processing = false } = {}) {
  if (error?.name === 'AbortError') throw error;
  if (SAFE_CODES.has(error?.code)) return cropToolError(error);
  if (processing && error instanceof HttpError && PROCESSING_CODES.has(error.code)) {
    return cropToolError(error, 'crop_processing_failed');
  }
  return null;
}
