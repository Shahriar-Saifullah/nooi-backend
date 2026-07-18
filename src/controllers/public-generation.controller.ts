import { Response, Request } from 'express';
import { supabase } from '../services/supabase';
import { callGeminiImageModel } from './project.controller';

// ─── Multer file type (matches the shape used in project.controller.ts) ──────

interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// ─── Landing page preview generation ──────────────────────────────────────────
// Public endpoint — no auth, no project required, since the visitor may not
// have an account yet. Generates a one-off image from a text prompt and an
// optional floor plan upload, with no persistence beyond the generated image
// itself (no project/room context to draw on, unlike the in-app version in
// project.controller.ts). Rate-limited at the route level (see ai.routes.ts)
// since this endpoint has no auth gate protecting it from abuse.

const MAX_PROMPT_LENGTH = 2000;
const ALLOWED_FILE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

export async function generatePreview(req: Request, res: Response) {
  try {
    const prompt = String(req.body?.prompt ?? '').trim();
    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      return res.status(400).json({ success: false, error: `Prompt must be under ${MAX_PROMPT_LENGTH} characters` });
    }

    const file = (req as any).file as UploadedFile | undefined;
    let floorPlanContext = '';
    let floorPlanInlineData: { data: string; mimeType: string } | null = null;

    if (file) {
      if (!ALLOWED_FILE_TYPES.includes(file.mimetype)) {
        return res.status(400).json({
          success: false,
          error: 'Unsupported file type. Please use JPG, PNG, WebP or PDF.',
          code: 'INVALID_FILE_TYPE',
        });
      }
      if (file.size > MAX_FILE_SIZE) {
        return res.status(400).json({
          success: false,
          error: 'File too large. Maximum size is 20 MB.',
          code: 'FILE_TOO_LARGE',
        });
      }

      // Only images can be passed as visual reference to the image model —
      // a PDF upload still counts as "attached" but isn't used as inline
      // visual context here (no PDF-to-image conversion in this lightweight path).
      if (file.mimetype.startsWith('image/')) {
        floorPlanInlineData = {
          data:     file.buffer.toString('base64'),
          mimeType: file.mimetype,
        };
        floorPlanContext = 'Use the attached floor plan image as the basis for the room layout in the render.';
      }
    }

    const fullPrompt = [
      'Generate a photorealistic interior design render based on the following request.',
      floorPlanContext,
      `Design request: ${prompt}`,
    ].filter(Boolean).join('\n\n');

    let image: { base64: string; mimeType: string };
    try {
      image = await callGeminiImageModel(fullPrompt, floorPlanInlineData);
    } catch (genErr: any) {
      console.error('Landing preview generation error:', genErr);
      return res.status(502).json({
        success: false,
        error: genErr.message || 'Image generation failed. Please try again.',
      });
    }

    // Store in the same bucket as authenticated renders, under a generic
    // "previews" prefix since there's no user/project to scope it to yet.
    const ext = image.mimeType.split('/')[1] || 'png';
    const storagePath = `previews/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const buffer = Buffer.from(image.base64, 'base64');

    const { error: uploadError } = await supabase.storage
      .from('nooi-projects')
      .upload(storagePath, buffer, {
        contentType: image.mimeType,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('nooi-projects')
      .getPublicUrl(storagePath);

    return res.status(200).json({
      success: true,
      data: { image_url: publicUrl },
    });

  } catch (err) {
    console.error('Generate preview error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}