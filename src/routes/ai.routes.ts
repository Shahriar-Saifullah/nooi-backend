import { Router } from 'express';
import { requireAuth } from '../middleware/auth.middleware';
import { getRecentGenerations } from '../controllers/generation.controller';

const router = Router();


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

export default router;