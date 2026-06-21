import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.middleware';
import { getRecentGenerations } from '../controllers/generation.controller';
import { generatePreview } from '../controllers/public-generation.controller';

const router = Router();

// Multer — memory storage, 20MB limit (matches the project floor-plan upload limit)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
});

// This endpoint is public (no requireAuth) since landing-page visitors don't
// have an account yet — it hits a paid Gemini API with no auth gate, so it
// gets its own stricter rate limit on top of the global one in index.ts.
// 10 requests per IP per hour is a starting point; tune based on real abuse
// patterns once this is live.
const previewRateLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many preview requests from this device. Please try again later, or sign up for unlimited generations.',
  },
});

const AI_TOOLS = [
  {
    id: 'smart-render',
    name: 'Smart Render',
    description: 'Turn sketches or photos into stunning 3D visuals effortlessly.',
    type: 'create',
    thumbnail_url: null,
  },
  {
    id: 'prompt-render',
    name: 'Prompt Render',
    description: 'Write what you imagine, and come into beautiful interior visuals.',
    type: 'create',
    thumbnail_url: null,
  },
  {
    id: 'expand-view',
    name: 'Expand View',
    description: 'Experience your design view detail with an expanded layout.',
    type: 'edit',
    thumbnail_url: null,
  },
  {
    id: 'hd-boost',
    name: 'HD Boost',
    description: 'Enhance your render with sharper details and vibrant clarity in HD.',
    type: 'enhance',
    thumbnail_url: null,
  },
  {
    id: 'recolor',
    name: 'Recolor',
    description: 'Easily switch colors and tones to explore new design moods.',
    type: 'edit',
    thumbnail_url: null,
  },
  {
    id: 'clear-room',
    name: 'Clear Room',
    description: 'Remove furniture and objects to start fresh with a clean space.',
    type: 'edit',
    thumbnail_url: null,
  },
];

// GET /ai/tools?type=create|edit|enhance
router.get('/tools', requireAuth, (req, res) => {
  const { type } = req.query;

  const tools = type
    ? AI_TOOLS.filter(tool => tool.type === type)
    : AI_TOOLS;

  return res.status(200).json({
    success: true,
    data: { tools },
  });
});


router.post('/suggest', requireAuth, (req, res) =>
  res.json({ message: 'ai suggest - coming soon' })
);

// GET /ai/generations/recent?limit=4
router.get('/generations/recent', requireAuth, getRecentGenerations);

// POST /ai/generate-preview — public, no auth, rate-limited. Used by the
// landing page prompt box so visitors can generate a one-off design preview
// before signing up. See public-generation.controller.ts for details.
router.post('/generate-preview', previewRateLimit, upload.single('floor_plan'), generatePreview);

export default router;