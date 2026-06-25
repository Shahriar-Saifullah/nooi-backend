import { Router } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.middleware';
import { getRecentGenerations } from '../controllers/generation.controller';
import { generatePreview } from '../controllers/public-generation.controller';
import { AI_TOOLS } from '../constants/aiTools';

const router = Router();

// Multer — memory storage, 20MB limit
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 20 * 1024 * 1024 },
});

// Public landing-page preview — rate-limited, no auth required
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

// GET /ai/tools?type=create|edit|enhance
router.get('/tools', requireAuth, (req, res) => {
  const { type } = req.query;
  const tools = type
    ? AI_TOOLS.filter(tool => tool.type === type)
    : AI_TOOLS;
  return res.status(200).json({ success: true, data: { tools } });
});

// GET /ai/generations/recent?limit=4
router.get('/generations/recent', requireAuth, getRecentGenerations);

// POST /ai/generate-preview — public, rate-limited
router.post('/generate-preview', previewRateLimit, upload.single('floor_plan'), generatePreview);

export default router;