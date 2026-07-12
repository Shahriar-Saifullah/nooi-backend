import { Response } from 'express';
import { supabase } from '../services/supabase';
import { AuthRequest } from '../types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { saveGeneration } from './generation.controller';
import {
  CreateProjectInput,
  SaveRoomsInput,
  SaveDimensionsInput,
  UpdateProjectInput,
  GenerateRenderInput,
  Room,
} from '../schemas/project.schema';

// ─── Multer file type ─────────────────────────────────────────────────────────

interface UploadedFile {
  fieldname: string;
  originalname: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function computeTotalArea(rooms: Room[]): number {
  return parseFloat(
    rooms.reduce((sum, r) => {
      if (r.length && r.width) return sum + r.length * r.width;
      return sum;
    }, 0).toFixed(1)
  );
}

async function verifyOwnership(projectId: string, userId: string) {
  const { data } = await supabase
    .from('projects')
    .select('id, room_data, floor_plan_url, status')
    .eq('id', projectId)
    .eq('user_id', userId)
    .single();
  return data;
}

// ─── Gemini Vision — Real room detection (two-pass) ──────────────────────────

interface RawRoom {
  name: string;
  confidence: number;
  color: string;
  box_2d?: [number, number, number, number];
  dimensions?: { length: number; width: number; unit: 'ft' | 'm' } | null;
}

// ─── Floor plan detection — delegates to Python microservice ─────────────────
// The Python service (nooi-floorplan-service) uses OpenCV for pixel-accurate
// wall detection, room region extraction, and door/window detection.
// Gemini is called by the Python service for room naming only.
// Falls back to Roboflow-only detection if the Python service is unavailable.

// Room + the true-shape polygon from the v3 pipeline ([x%, y%] pairs)
type DetectedRoom = Room & { polygon?: [number, number][] };

interface DetectionResult {
  rooms:      DetectedRoom[];
  walls:      Array<{ id?: string; x1: number; y1: number; x2: number; y2: number; thickness: number }>;
  openings:   Array<{ type: 'door'|'window'; wall: 'horizontal'|'vertical'; x: number; y: number; width: number; wall_id?: string }>;
  imgW:       number;
  imgH:       number;
  scaleMPerPx: number | null;
}

async function callFloorPlanService(
  imageUrl: string,
  projectId: string,
): Promise<DetectionResult | null> {
  const serviceUrl = process.env.FLOORPLAN_SERVICE_URL;
  if (!serviceUrl) {
    console.warn('FLOORPLAN_SERVICE_URL not set — skipping Python service');
    return null;
  }

  try {
    const res = await fetch(`${serviceUrl}/analyse`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'X-Service-Key': process.env.FLOORPLAN_SERVICE_KEY || '',
      },
      body: JSON.stringify({
        image_url:      imageUrl,
        project_id:     projectId,
        gemini_api_key: process.env.GEMINI_API_KEY || '',
      }),
      signal: AbortSignal.timeout(120_000), // 2 min timeout
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(`Floor plan service error ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }

    const data = await res.json() as any;
    if (!data.success) {
      console.error('Floor plan service returned failure:', data.error);
      return null;
    }

    console.log(
      `Python service: ${data.rooms?.length} rooms, ` +
      `${data.walls?.length} walls, ${data.openings?.length} openings`
    );

    // Convert service response to DetectionResult format
    const rooms: DetectedRoom[] = (data.rooms || []).map((r: any) => ({
      id:         r.id,
      name:       r.name,
      confidence: r.confidence ?? 70,
      color:      r.color ?? '#e5e7eb',
      box:        r.box,
      polygon:    r.polygon,          // v3: true room shape ([x%, y%] pairs)
      length:     r.length,
      width:      r.width,
    }));

    return {
      rooms,
      walls:    data.walls    || [],
      openings: data.openings || [],   // v3: each carries wall_id
      imgW:     data.image_size?.width  || 1000,
      imgH:     data.image_size?.height || 1000,
      scaleMPerPx: data.scale_m_per_px ?? null,
    };
  } catch (err) {
    console.error('Floor plan service call failed:', err);
    return null;
  }
}

// Roboflow fallback — used when Python service is unavailable
interface RoboflowPrediction {
  x: number; y: number; width: number; height: number;
  class: 'wall' | 'door' | 'window'; confidence: number;
}

async function callRoboflow(imageUrl: string): Promise<{
  walls: RoboflowPrediction[];
  doors: RoboflowPrediction[];
  windows: RoboflowPrediction[];
  imgW: number; imgH: number;
} | null> {
  const apiKey = process.env.ROBOFLOW_API_KEY;
  if (!apiKey) return null;

  try {
    const imgRes = await fetch(imageUrl);
    if (!imgRes.ok) return null;
    const imgBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');

    const res = await fetch(
      `https://serverless.roboflow.com/cubicasa5k-2-qpmsa/6?api_key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: base64 }
    );
    if (!res.ok) return null;
    const result = await res.json() as any;
    const preds = result.predictions || [];

    console.log(`Roboflow: ${preds.filter((p:any)=>p.class==='wall').length} walls, ` +
      `${preds.filter((p:any)=>p.class==='door').length} doors, ` +
      `${preds.filter((p:any)=>p.class==='window').length} windows`);

    return {
      walls:   preds.filter((p:any) => p.class === 'wall'),
      doors:   preds.filter((p:any) => p.class === 'door'),
      windows: preds.filter((p:any) => p.class === 'window'),
      imgW:    result.image?.width  || 1000,
      imgH:    result.image?.height || 1000,
    };
  } catch (err) {
    console.error('Roboflow call failed:', err);
    return null;
  }
}

async function detectRooms(floorPlanUrl: string, projectId: string): Promise<DetectionResult> {
  // ── Primary: Python microservice (OpenCV + Gemini naming) ──
  const serviceResult = await callFloorPlanService(floorPlanUrl, projectId);
  if (serviceResult && (serviceResult.rooms.length > 0 || serviceResult.walls.length > 0)) {
    return serviceResult;
  }

  // ── Fallback: Roboflow for walls/doors/windows + Gemini for room naming ──
  console.warn('Python service unavailable — falling back to Roboflow + Gemini');

  const rf = await callRoboflow(floorPlanUrl);
  const imgW = rf?.imgW || 1000;
  const imgH = rf?.imgH || 1000;

  // Gemini room naming fallback
  const geminiKey = process.env.GEMINI_API_KEY || '';
  let rooms: Room[] = [];

  if (geminiKey) {
    const { GoogleGenerativeAI } = await import('@google/generative-ai');
    const genAI = new GoogleGenerativeAI(geminiKey);
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      generationConfig: { responseMimeType: 'application/json' },
    });

    const imgRes = await fetch(floorPlanUrl);
    const imgBuf = await imgRes.arrayBuffer();
    const b64    = Buffer.from(imgBuf).toString('base64');
    const mime   = (imgRes.headers.get('content-type') || 'image/png').split(';')[0];

    const prompt = `Analyse this floor plan. List all rooms as JSON array.
Each: {"name":"unique name","confidence":0-100,"box_2d":[ymin,xmin,ymax,xmax],"color":"hex","dimensions":{"length":0,"width":0,"unit":"ft"}|null}
0-1000 scale. Unique names only. Return ONLY the JSON array.`;

    const delays = [3000, 6000, 10000];
    for (let attempt = 0; attempt <= delays.length; attempt++) {
      try {
        const result = await model.generateContent([
          { text: prompt },
          { inlineData: { data: b64, mimeType: mime } },
        ]);
        const raw = result.response.text().trim();
        const parsed = JSON.parse(raw.slice(raw.indexOf('['), raw.lastIndexOf(']')+1));
        const FT = 0.3048;
        rooms = parsed.map((r: any, i: number) => {
          const box = r.box_2d ? {
            top:    Math.max(0,Math.min(100,r.box_2d[0]/10)),
            left:   Math.max(0,Math.min(100,r.box_2d[1]/10)),
            width:  Math.max(0,Math.min(100,(r.box_2d[3]-r.box_2d[1])/10)),
            height: Math.max(0,Math.min(100,(r.box_2d[2]-r.box_2d[0])/10)),
          } : undefined;
          return {
            id: `${projectId}-r${i+1}`, name: r.name,
            confidence: Math.round(r.confidence||70),
            color: r.color||'#e5e7eb', box,
            length: r.dimensions ? parseFloat((r.dimensions.length*(r.dimensions.unit==='ft'?FT:1)).toFixed(2)) : undefined,
            width:  r.dimensions ? parseFloat((r.dimensions.width *(r.dimensions.unit==='ft'?FT:1)).toFixed(2)) : undefined,
          };
        });
        break;
      } catch (err: any) {
        if (err?.status===503 && attempt < delays.length) {
          await new Promise(r => setTimeout(r, delays[attempt]));
        } else { break; }
      }
    }
  }

  // Convert Roboflow walls/openings
  const walls = rf ? rf.walls.map(w => {
    const isH = w.width > w.height;
    return isH
      ? { x1:(w.x-w.width/2)/imgW*100, y1:w.y/imgH*100, x2:(w.x+w.width/2)/imgW*100, y2:w.y/imgH*100, thickness:Math.max(0.5,w.height/imgH*100) }
      : { x1:w.x/imgW*100, y1:(w.y-w.height/2)/imgH*100, x2:w.x/imgW*100, y2:(w.y+w.height/2)/imgH*100, thickness:Math.max(0.5,w.width/imgW*100) };
  }) : [];

  const openings = rf ? [
    ...rf.doors.map(d => ({
      type: 'door' as const,
      wall: (d.width>d.height?'horizontal':'vertical') as 'horizontal'|'vertical',
      x: d.x/imgW*1000, y: d.y/imgH*1000,
      width: Math.max(80, Math.max(d.width,d.height)/Math.max(imgW,imgH)*1000),
    })),
    ...rf.windows.map(w => ({
      type: 'window' as const,
      wall: (w.width>w.height?'horizontal':'vertical') as 'horizontal'|'vertical',
      x: w.x/imgW*1000, y: w.y/imgH*1000,
      width: Math.max(60, Math.max(w.width,w.height)/Math.max(imgW,imgH)*1000),
    })),
  ] : [];

  return { rooms, walls, openings, imgW, imgH, scaleMPerPx: null };
}

// ─── Step 1: Create project ───────────────────────────────────────────────────
// POST /projects

export async function createProject(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const { name, project_type, address } = req.body as CreateProjectInput;

    // Enforce plan project limits
    const { data: profile } = await supabase
      .from('profiles')
      .select('plan')
      .eq('id', userId)
      .single();

    const plan = profile?.plan ?? 'free';
    const limits: Record<string, number> = { free: 50, starter: 10, pro: Infinity };
    const limit = limits[plan] ?? 50;

    if (limit !== Infinity) {
      const { count } = await supabase
        .from('projects')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', userId);

      if ((count ?? 0) >= limit) {
        return res.status(403).json({
          success: false,
          error: `Your ${plan} plan allows up to ${limit} projects. Upgrade to create more.`,
          code: 'PROJECT_LIMIT_REACHED',
        });
      }
    }

    const { data, error } = await supabase
      .from('projects')
      .insert({
        user_id:         userId,
        name,
        project_type,
        address:         address ?? null,
        status:          'draft',
        floor_plan_data: {},
        room_data:       {},
      })
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(201).json({
      success: true,
      data: { project: data },
    });

  } catch (err) {
    console.error('Create project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 2: Upload floor plan ────────────────────────────────────────────────
// POST /projects/:id/floor-plan  (multipart/form-data, field: floor_plan)

export async function uploadFloorPlan(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const file = (req as any).file as UploadedFile | undefined;
    if (!file) {
      return res.status(400).json({ success: false, error: 'No file uploaded' });
    }

    // Validate file type
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (!allowed.includes(file.mimetype)) {
      return res.status(400).json({
        success: false,
        error: 'Unsupported file type. Please use JPG, PNG, WebP or PDF.',
        code: 'INVALID_FILE_TYPE',
      });
    }

    // Validate size (20 MB)
    if (file.size > 20 * 1024 * 1024) {
      return res.status(400).json({
        success: false,
        error: 'File too large. Maximum size is 20 MB.',
        code: 'FILE_TOO_LARGE',
      });
    }

    // Upload to Supabase Storage
    const ext         = file.originalname.split('.').pop();
    const storagePath = `floor-plans/${userId}/${projectId}.${ext}`;

    const { error: uploadError } = await supabase.storage
      .from('nooi-projects')
      .upload(storagePath, file.buffer, {
        contentType: file.mimetype,
        upsert: true,
      });

    if (uploadError) {
      return res.status(500).json({ success: false, error: uploadError.message });
    }

    const { data: { publicUrl } } = supabase.storage
      .from('nooi-projects')
      .getPublicUrl(storagePath);

    // Save floor plan URL on project
    const { data: updated, error: updateError } = await supabase
      .from('projects')
      .update({
        floor_plan_url:  publicUrl,
        floor_plan_data: {
          storage_path:  storagePath,
          original_name: file.originalname,
          size:          file.size,
          mime:          file.mimetype,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (updateError) {
      return res.status(400).json({ success: false, error: updateError.message });
    }

    // Detect rooms using Gemini Vision
    let detectedRooms: DetectedRoom[] = [];
    let detectedOpenings: DetectionResult['openings'] = [];
    let detectedWalls: DetectionResult['walls'] = [];
    let imgW = 1000; let imgH = 1000;
    let scaleMPerPx: number | null = null;
    try {
      const detection = await detectRooms(publicUrl, projectId);
      detectedRooms    = detection.rooms;
      detectedOpenings = detection.openings;
      detectedWalls    = detection.walls;
      imgW             = detection.imgW;
      imgH             = detection.imgH;
      scaleMPerPx      = detection.scaleMPerPx;
      console.log(`Detection complete: ${detectedRooms.length} rooms, ${detectedWalls.length} walls, ${detectedOpenings.length} openings`);
    } catch (aiErr) {
      console.error('Detection failed:', aiErr);
      detectedRooms = [];
    }

    if (detectedRooms.length > 0 || detectedWalls.length > 0) {
      await supabase
        .from('projects')
        .update({
          room_data: {
            rooms:      detectedRooms,
            walls:      detectedWalls,
            openings:   detectedOpenings,
            image_size: { width: imgW, height: imgH },
            scale_m_per_px: scaleMPerPx,
          },
          updated_at: new Date().toISOString(),
        })
        .eq('id', projectId);
    }

    return res.status(200).json({
      success: true,
      data: {
        project:        updated,
        floor_plan_url: publicUrl,
        detected_rooms: detectedRooms,
        walls:          detectedWalls,
        openings:       detectedOpenings,
        ai_detected:    detectedRooms.length > 0 || detectedWalls.length > 0,
      },
    });

  } catch (err) {
    console.error('Upload floor plan error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 3: Save reviewed rooms ──────────────────────────────────────────────
// PUT /projects/:id/rooms

export async function saveRooms(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { rooms } = req.body as SaveRoomsInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    // Preserve existing Roboflow data — only update rooms
    const existing = (project.room_data as any) ?? {};
    const { data, error } = await supabase
      .from('projects')
      .update({
        room_data: {
          ...existing,
          rooms,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { project: data, rooms },
    });

  } catch (err) {
    console.error('Save rooms error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 4: Save room dimensions ─────────────────────────────────────────────
// PUT /projects/:id/dimensions

export async function saveDimensions(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { rooms } = req.body as SaveDimensionsInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const existingRooms: Room[] = (project.room_data as any)?.rooms ?? [];
    const dimensionMap = new Map(rooms.map(r => [r.id, r]));

    const mergedRooms = existingRooms.map(room => {
      const dims = dimensionMap.get(room.id);
      return dims ? { ...room, ...dims } : room;
    });

    const totalArea = computeTotalArea(mergedRooms);

    // Preserve existing Roboflow data — only update rooms and total_area
    const existing = (project.room_data as any) ?? {};
    const { data, error } = await supabase
      .from('projects')
      .update({
        room_data: {
          ...existing,
          rooms: mergedRooms,
          total_area_m2: totalArea,
        },
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({
      success: true,
      data: { project: data, rooms: mergedRooms, total_area_m2: totalArea },
    });

  } catch (err) {
    console.error('Save dimensions error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Step 5: Confirm project ──────────────────────────────────────────────────
// POST /projects/:id/confirm

export async function confirmProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    if (!project.floor_plan_url) {
      return res.status(400).json({
        success: false,
        error: 'Floor plan is required before confirming.',
        code:  'MISSING_FLOOR_PLAN',
      });
    }

    const rooms: Room[] = (project.room_data as any)?.rooms ?? [];
    if (rooms.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Rooms are required before confirming.',
        code:  'MISSING_ROOMS',
      });
    }

    const { data: confirmed, error } = await supabase
      .from('projects')
      .update({
        status:     'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', projectId)
      .select()
      .single();

    if (error) {
      return res.status(400).json({ success: false, error: error.message });
    }

    const roomsSummary = rooms.map(r => ({
      name:       r.name,
      dimensions: `${r.length ?? '-'} × ${r.width ?? '-'} × ${r.height ?? '-'} m`,
      area_m2:    r.length && r.width ? parseFloat((r.length * r.width).toFixed(1)) : null,
    }));

    return res.status(200).json({
      success: true,
      data: {
        project:       confirmed,
        rooms_summary: roomsSummary,
        total_area_m2: (project.room_data as any)?.total_area_m2 ?? 0,
      },
    });

  } catch (err) {
    console.error('Confirm project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Standard CRUD ────────────────────────────────────────────────────────────

export async function getProjects(req: AuthRequest, res: Response) {
  try {
    const userId = req.user!.id;
    const limit  = req.query.limit ? parseInt(req.query.limit as string) : undefined;

    const query = supabase
      .from('projects')
      .select('id, name, project_type, address, thumbnail_url, floor_plan_url, status, room_data, created_at, updated_at')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false });

    if (limit) query.limit(limit);

    const { data, error } = await query;
    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, data: { projects: data } });

  } catch (err) {
    console.error('Get projects error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function getProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .eq('user_id', userId)
      .single();

    if (error || !data) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    return res.status(200).json({ success: true, data: { project: data } });

  } catch (err) {
    console.error('Get project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function updateProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const updates   = req.body as UpdateProjectInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { data, error } = await supabase
      .from('projects')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', projectId)
      .select()
      .single();

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, data: { project: data } });

  } catch (err) {
    console.error('Update project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

export async function deleteProject(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const { error } = await supabase
      .from('projects')
      .delete()
      .eq('id', projectId)
      .eq('user_id', userId);

    if (error) return res.status(400).json({ success: false, error: error.message });

    return res.status(200).json({ success: true, message: 'Project deleted successfully' });

  } catch (err) {
    console.error('Delete project error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

// ─── Generate an AI render image from the user's prompt + current room layout ─
// Every `model` value currently routes to the same Gemini image model
// (gemini-2.5-flash-image, aka "Nano Banana") — see GenerateRenderInput schema
// comment. Swapping in real per-provider routing later only touches this
// function; the request/response contract for the frontend stays the same.

function buildRoomContextSummary(rooms: Room[]): string {
  if (!rooms || rooms.length === 0) return '';

  const lines = rooms.map(r => {
    const dims = (r.length && r.width) ? ` (${r.length}m x ${r.width}m)` : '';
    return `- ${r.name}${dims}`;
  });

  return `The floor plan contains the following rooms:\n${lines.join('\n')}`;
}

interface GeminiImageResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: { data: string; mimeType: string };
      }>;
    };
  }>;
}

export async function callGeminiImageModel(
  prompt: string,
  referenceImage?: { data: string; mimeType: string } | null
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');

  const requestParts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = [
    { text: prompt },
  ];
  if (referenceImage) {
    requestParts.push({ inlineData: { data: referenceImage.data, mimeType: referenceImage.mimeType } });
  }

  // Using the raw REST endpoint here (rather than the @google/generative-ai
  // SDK used elsewhere in this file) since image generation via
  // responseModalities is a newer capability and the REST contract is the
  // most stable reference for it — see ai.google.dev/gemini-api/docs/image-generation
  const response = await fetch(
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
    {
      method:  'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type':   'application/json',
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: requestParts }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini image generation failed (${response.status}): ${errText}`);
  }

  const json = await response.json() as GeminiImageResponse;
  const responseParts = json.candidates?.[0]?.content?.parts ?? [];
  const imagePart = responseParts.find(
    (p): p is { inlineData: { data: string; mimeType: string } } => !!p.inlineData?.data
  );

  if (!imagePart) {
    throw new Error('Gemini did not return an image. It may have refused the prompt.');
  }

  return {
    base64:   imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || 'image/png',
  };
}

export async function generateRender(req: AuthRequest, res: Response) {
  try {
    const userId    = req.user!.id;
    const projectId = String(req.params.id);
    const { prompt, model } = req.body as GenerateRenderInput;

    const project = await verifyOwnership(projectId, userId);
    if (!project) {
      return res.status(404).json({ success: false, error: 'Project not found' });
    }

    const rooms = (project.room_data as any)?.rooms ?? [];
    const roomContext = buildRoomContextSummary(rooms);

    const fullPrompt = [
      'Generate a photorealistic interior design render based on this floor plan and the following request.',
      roomContext,
      `Design request: ${prompt}`,
    ].filter(Boolean).join('\n\n');

    let image: { base64: string; mimeType: string };
    try {
      image = await callGeminiImageModel(fullPrompt);
    } catch (genErr: any) {
      console.error('Image generation error:', genErr);
      return res.status(502).json({
        success: false,
        error: genErr.message || 'Image generation failed. Please try again.',
      });
    }

    // Upload the generated image to Supabase Storage, same bucket/convention
    // used for uploaded floor plans, so renders persist and have a stable URL.
    const ext = image.mimeType.split('/')[1] || 'png';
    const storagePath = `renders/${userId}/${projectId}-${Date.now()}.${ext}`;
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

    // Persist the generation so it appears in the dashboard's Recent Creations.
    // Fire-and-forget — non-fatal if it fails.
    saveGeneration(userId, projectId, prompt, publicUrl, model ?? 'gemini', 'prompt-render');

    return res.status(200).json({
      success: true,
      data: {
        image_url: publicUrl,
        model_requested: model, // echoed back; not yet used to pick a provider
      },
    });

  } catch (err) {
    console.error('Generate render error:', err);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}