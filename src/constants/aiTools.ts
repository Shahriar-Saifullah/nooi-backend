// ─── AI Tools catalogue ───────────────────────────────────────────────────
// Single source of truth for all AI tool definitions.
// Used by GET /ai/tools and referenced when recording generations.

export type ToolType =
  | 'smart-render'
  | 'prompt-render'
  | 'expand-view'
  | 'hd-boost'
  | 'recolor'
  | 'clear-room';

export interface AiTool {
  id: ToolType;
  name: string;
  description: string;
  type: 'create' | 'edit' | 'enhance';
  thumbnail_url: string | null;
}

export const AI_TOOLS: AiTool[] = [
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